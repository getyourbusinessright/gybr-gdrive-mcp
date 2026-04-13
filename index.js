#!/usr/bin/env node
/**
 * GYBR Google Drive MCP Server v5.1 — Full Governance Edition
 *
 * PERMISSION MODEL:
 * READ        → everywhere, no restrictions
 * CREATE      → AI Workspace folders only
 * EDIT        → anywhere (standard edits logged, destructive edits require confirm + backup)
 * DELETE      → anywhere (confirm + reason + soft delete only)
 * CONFIG      → gybr-mcp-config.json (no code edits needed)
 * DRAFT MODE  → global default in config, overridable per conversation
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import os from "os";
import mammoth from "mammoth";
import ExcelJS from "exceljs";

// ─── Data Folder (Fix 26) ─────────────────────────────────────────────────────

const GYBR_MCP_DIR = path.join(os.homedir(), "gybr-mcp");
if (!fs.existsSync(GYBR_MCP_DIR)) fs.mkdirSync(GYBR_MCP_DIR, { recursive: true });

const OAUTH_PATH = process.env.GDRIVE_OAUTH_PATH || path.join(GYBR_MCP_DIR, "gcp-oauth.keys.json");
const CREDENTIALS_PATH = process.env.GDRIVE_CREDENTIALS_PATH || path.join(GYBR_MCP_DIR, ".gdrive-server-credentials.json");
const CACHE_PATH = path.join(GYBR_MCP_DIR, ".gdrive-mcp-workspace-cache.json");
const RATELIMIT_PATH = path.join(GYBR_MCP_DIR, ".gdrive-mcp-ratelimit.json");

// Silent migration from old home-dir paths
function migrateFile(oldPath, newPath) {
  if (!fs.existsSync(newPath) && fs.existsSync(oldPath)) {
    try { fs.renameSync(oldPath, newPath); }
    catch { try { fs.copyFileSync(oldPath, newPath); fs.unlinkSync(oldPath); } catch {} }
  }
}
migrateFile(path.join(os.homedir(), "gcp-oauth.keys.json"), OAUTH_PATH);
migrateFile(path.join(os.homedir(), ".gdrive-server-credentials.json"), CREDENTIALS_PATH);
migrateFile(path.join(os.homedir(), ".gdrive-mcp-workspace-cache.json"), CACHE_PATH);
migrateFile(path.join(os.homedir(), ".gdrive-mcp-ratelimit.json"), RATELIMIT_PATH);

// ─── Load Config ──────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
  "gybr-mcp-config.json"
);
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const MAX_READ_CHARS = config.maxReadChars || 50000; // Fix 23

// ─── Auth Setup (Fix 14: proper OAuth2 client with token refresh) ─────────────

if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error(`Credentials not found at: ${CREDENTIALS_PATH}`);
  process.exit(1);
}
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));

let auth;
if (fs.existsSync(OAUTH_PATH)) {
  const keys = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf-8"));
  const clientKeys = keys.installed || keys.web;
  auth = new google.auth.OAuth2(
    clientKeys.client_id,
    clientKeys.client_secret,
    clientKeys.redirect_uris[0]
  );
  auth.setCredentials(credentials);
  auth.on("tokens", (tokens) => {
    const updated = { ...credentials, ...tokens };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2));
    console.error("Token refreshed and saved.");
  });
} else {
  auth = new google.auth.OAuth2();
  auth.setCredentials(credentials);
  console.error(`Warning: ${OAUTH_PATH} not found. Token auto-refresh disabled.`);
}

// Fix 15: Startup token refresh if expiring within 5 minutes
if (credentials.expiry_date && credentials.expiry_date - Date.now() < 5 * 60 * 1000) {
  try {
    const { credentials: fresh } = await auth.refreshAccessToken();
    const updated = { ...credentials, ...fresh };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2));
    auth.setCredentials(updated);
    console.error("Token refreshed on startup.");
  } catch (e) {
    console.error(`Warning: startup token refresh failed: ${e.message}`);
  }
}

google.options({ auth });
const drive  = google.drive({ version: "v3", auth });
const docs   = google.docs({ version: "v1", auth });
const sheets = google.sheets({ version: "v4", auth });
const slides = google.slides({ version: "v1", auth });

// ─── Rate Limit State (Fix 5: disk-persisted timestamps) ──────────────────────

let writeTimestamps = [];
try {
  if (fs.existsSync(RATELIMIT_PATH)) {
    const saved = JSON.parse(fs.readFileSync(RATELIMIT_PATH, "utf-8"));
    writeTimestamps = (saved.timestamps || []).filter((t) => t > Date.now() - 60000);
  }
} catch {}

// ─── Session State ────────────────────────────────────────────────────────────

let sessionDraftMode = null;
let deleteCount = 0;
const lastReadTime = new Map(); // Fix 22: freshness tracking keyed by fileId::tabOrSection

// ─── Auth Retry Wrapper (Fix 16) ──────────────────────────────────────────────

async function withAuthRetry(fn) {
  try { return await fn(); } catch (err) {
    const status = err?.response?.status || err?.code;
    if (status === 401 || status === 403) {
      try {
        const { credentials: fresh } = await auth.refreshAccessToken();
        const updated = { ...credentials, ...fresh };
        fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2));
        auth.setCredentials(updated);
      } catch (re) {
        throw new Error(`Auth refresh failed: ${re.message}. Original: ${err.message}`);
      }
      return await fn();
    }
    throw err;
  }
}

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "gybr-gdrive-v5", version: "5.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tool Schemas ─────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    // ── SETUP & CONTROL ──
    {
      name: "setup_ai_workspace",
      description: "One-time setup: creates GYBR-AI-Workspace folder structure and 11-column action log in Google Drive. Run this first.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_workspace_info",
      description: "Show AI workspace folder IDs, current config settings, and draft mode status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "set_draft_mode",
      description: "Override draft mode for this conversation. Draft mode creates revision copies instead of editing real files directly.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", description: "'draft' = create revision copies | 'direct' = edit real files" },
        },
        required: ["mode"],
      },
    },
    {
      name: "get_action_log",
      description: "Show recent AI actions from the action log spreadsheet.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of recent entries (default 20)" },
        },
      },
    },

    // ── READ (unrestricted) ──
    {
      name: "search_files",
      description: "Search anywhere in Google Drive including files shared with you. READ ONLY — no restrictions.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query — file name, content, or type" },
          max_results: { type: "number", description: "Max results (default 10)" },
          include_shared: { type: "boolean", description: "Include files shared with you (default true)" },
        },
        required: ["query"],
      },
    },
    {
      name: "list_folder",
      description: "List files in any folder. READ ONLY. Use 'root' for My Drive, 'workspace' for AI workspace, 'created'/'drafts'/'archive' for AI subfolders.",
      inputSchema: {
        type: "object",
        properties: {
          folder_id: { type: "string", description: "Folder ID or shortcut: root | workspace | created | drafts | archive" },
        },
        required: ["folder_id"],
      },
    },
    {
      name: "read_file",
      description: "Read contents of any file anywhere in Drive — Google Docs, Sheets (with tab/row selection), Slides, plain text, .docx, .xlsx. READ ONLY.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "Google Drive file ID" },
          tab_name: { type: "string", description: "Sheets: specific tab name to read (default: first visible tab)" },
          section_name: { type: "string", description: "Docs: heading name to read under (reads that section only)" },
          start_row: { type: "number", description: "Sheets: first data row to return (1-based, excludes header)" },
          end_row: { type: "number", description: "Sheets: last data row to return (1-based, excludes header)" },
          include_hidden_tabs: { type: "boolean", description: "Sheets: include hidden tabs in tab list (default false)" },
          confirm_stale: { type: "boolean", description: "Bypass freshness warning if file was modified since last read" },
        },
        required: ["file_id"],
      },
    },

    // ── CREATE (workspace only) ──
    {
      name: "create_document",
      description: "Create a new Google Doc. NEW FILES ONLY — saves to AI-Created or AI-Drafts folder. Cannot create files outside AI workspace.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Document title (AI_DATE_ prefix added automatically)" },
          content: { type: "string", description: "Initial content (optional)" },
          folder: { type: "string", description: "created (default) | drafts" },
        },
        required: ["title"],
      },
    },
    {
      name: "create_spreadsheet",
      description: "Create a new Google Sheet. NEW FILES ONLY — saves to AI workspace folders only.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Spreadsheet title" },
          folder: { type: "string", description: "created (default) | drafts" },
        },
        required: ["title"],
      },
    },
    {
      name: "create_slides",
      description: "Create a new Google Slides presentation. NEW FILES ONLY — saves to AI workspace folders only.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Presentation title" },
          folder: { type: "string", description: "created (default) | drafts" },
        },
        required: ["title"],
      },
    },
    {
      name: "create_folder",
      description: "Create a new folder anywhere in Drive.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Folder name" },
          parent_folder_id: { type: "string", description: "Parent folder ID (optional, defaults to root)" },
        },
        required: ["name"],
      },
    },
    {
      name: "create_and_upload_docx",
      description: "Create a real Word .docx file and upload to AI workspace. NEW FILES ONLY.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "File name (no extension needed)" },
          content: { type: "string", description: "Content: use # H1, ## H2, **bold**, - for bullets" },
          folder: { type: "string", description: "created (default) | drafts" },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "create_and_upload_xlsx",
      description: "Create a real Excel .xlsx file and upload to AI workspace. NEW FILES ONLY.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "File name (no extension needed)" },
          sheets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                headers: { type: "array", items: { type: "string" } },
                rows: { type: "array", items: { type: "array" } },
              },
              required: ["name", "headers"],
            },
          },
          folder: { type: "string", description: "created (default) | drafts" },
        },
        required: ["title", "sheets"],
      },
    },
    {
      name: "create_and_upload_pdf",
      description: "Create a real PDF file and upload to AI workspace. NEW FILES ONLY.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "File name (no extension needed)" },
          content: { type: "string", description: "Content: use # H1, ## H2, **bold**, - for bullets" },
          folder: { type: "string", description: "created (default) | drafts" },
          keep_source_doc: { type: "boolean", description: "Keep the intermediate Google Doc (default false)" },
        },
        required: ["title", "content"],
      },
    },

    // ── EDIT EXISTING (anywhere) ──
    {
      name: "append_to_document",
      description: "STANDARD EDIT — Append text to the END of an existing Google Doc anywhere in Drive. Logged automatically. Safe operation.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "Google Doc file ID" },
          content: { type: "string", description: "Text to append" },
        },
        required: ["file_id", "content"],
      },
    },
    {
      name: "append_row",
      description: "STANDARD EDIT — Append a row to a Google Sheet tab. Optionally checks for duplicates before inserting.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "Google Sheet file ID" },
          tab_name: { type: "string", description: "Tab name to append to (default: first sheet)" },
          values: { type: "array", description: "Array of cell values for the new row", items: {} },
          check_duplicate_column: { type: "string", description: "Column header name — blocks insert if this column already contains the first value in 'values'" },
        },
        required: ["file_id", "values"],
      },
    },
    {
      name: "insert_under_heading",
      description: "STANDARD EDIT — Insert content immediately after a named heading in a Google Doc without touching anything else. If multiple headings match, returns all matches with position info and requires heading_index to disambiguate. Supports dry_run.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "Google Doc file ID" },
          heading_text: { type: "string", description: "Text of the heading to insert under (case-insensitive substring match, styled headings only; falls back to plain text if none found)" },
          content: { type: "string", description: "Content to insert immediately after the heading" },
          heading_index: { type: "number", description: "0-based index to disambiguate when multiple headings match (required if ambiguous)" },
          dry_run: { type: "boolean", description: "Preview insertion point without making changes (default false)" },
        },
        required: ["file_id", "heading_text", "content"],
      },
    },
    {
      name: "overwrite_document",
      description: "DESTRUCTIVE EDIT — Replaces ALL content in a Google Doc. Requires confirm=true + reason. Auto-backup created in AI-Archive first.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "Google Doc file ID" },
          content: { type: "string", description: "New content to replace everything with" },
          confirm: { type: "boolean", description: "Must be true to proceed" },
          reason: { type: "string", description: "Why you are overwriting this file" },
          draft_mode_override: { type: "string", description: "Pass 'direct' to bypass draft mode for this action" },
        },
        required: ["file_id", "content", "confirm", "reason"],
      },
    },
    {
      name: "update_sheet_values",
      description: "STANDARD EDIT — Write data to a specific cell range in a Google Sheet anywhere in Drive. Logged automatically.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "Google Sheet file ID" },
          range: { type: "string", description: "Cell range e.g. Sheet1!A1:D10" },
          values: { type: "array", description: "2D array of values", items: { type: "array" } },
        },
        required: ["file_id", "range", "values"],
      },
    },

    // ── ORGANIZE ──
    {
      name: "copy_file",
      description: "Make a copy of any file. Copy lands in AI-Created folder by default.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File ID to copy" },
          new_name: { type: "string", description: "Name for the copy (optional)" },
          folder_id: { type: "string", description: "Destination folder (optional, defaults to AI-Created)" },
        },
        required: ["file_id"],
      },
    },
    {
      name: "move_file",
      description: "Move a file to a different folder. Use 'archive' to move to AI-Archive. Pass dry_run: true to preview without moving.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File ID to move" },
          new_folder_id: { type: "string", description: "Destination folder ID or 'archive'" },
          dry_run: { type: "boolean", description: "Preview the move without executing it (default false)" },
        },
        required: ["file_id", "new_folder_id"],
      },
    },
    {
      name: "rename_file",
      description: "Rename a file or folder. Original name logged.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File or folder ID" },
          new_name: { type: "string", description: "New name" },
        },
        required: ["file_id", "new_name"],
      },
    },

    // ── DELETE (protected) ──
    {
      name: "delete_file",
      description: "DESTRUCTIVE — Moves file to trash (soft delete only, never permanent). Requires confirm=true AND a reason string.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File ID to trash" },
          confirm: { type: "boolean", description: "MUST be explicitly true to proceed." },
          reason: { type: "string", description: "Why this file is being deleted — required, cannot be empty" },
        },
        required: ["file_id", "confirm", "reason"],
      },
    },

    // ── SHARE ──
    {
      name: "share_file",
      description: "Share a file or folder with an email address.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File or folder ID" },
          email: { type: "string", description: "Email address to share with" },
          role: { type: "string", description: "reader | commenter | writer" },
        },
        required: ["file_id", "email", "role"],
      },
    },

    // ── EXPORT ──
    {
      name: "export_file",
      description: "Export a Google Doc/Sheet/Slides as pdf, docx, or xlsx. Exported file saves to AI-Created folder.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File ID to export" },
          format: { type: "string", description: "pdf | docx | xlsx" },
          output_name: { type: "string", description: "Output file name (no extension)" },
          folder_id: { type: "string", description: "Destination folder (optional, defaults to AI-Created)" },
        },
        required: ["file_id", "format", "output_name"],
      },
    },
  ],
}));

// ─── Handlers Part A: setup → append_row ─────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {

      // ── SETUP WORKSPACE ──
      case "setup_ai_workspace": {
        const cache = loadCache();
        if (cache.workspaceId) {
          return text(`✅ AI Workspace already configured.\n\n📁 GYBR-AI-Workspace (${cache.workspaceId})\n   📁 _AI-Created (${cache.createdId})\n   📁 _AI-Drafts (${cache.draftsId})\n   📁 _AI-Logs (${cache.logsId})\n   📁 _AI-Archive (${cache.archiveId})\n   📁 Exports (${cache.exportsId})\n   📊 Action Log (${cache.logSheetId})`);
        }
        const wsId = await withAuthRetry(() => createFolder("GYBR-AI-Workspace", null));
        const createdId = await withAuthRetry(() => createFolder("_AI-Created", wsId));
        const draftsId  = await withAuthRetry(() => createFolder("_AI-Drafts", wsId));
        const logsId    = await withAuthRetry(() => createFolder("_AI-Logs", wsId));
        const archiveId = await withAuthRetry(() => createFolder("_AI-Archive", wsId));
        const exportsId = await withAuthRetry(() => createFolder("Exports", wsId));

        const logSheet = await withAuthRetry(() => sheets.spreadsheets.create({
          requestBody: { properties: { title: "GYBR-AI-Action-Log" } }
        }));
        const logSheetId = logSheet.data.spreadsheetId;
        await withAuthRetry(() => moveToFolder(logSheetId, logsId));
        // Fix 21: 11-column header
        await withAuthRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId: logSheetId,
          range: "A1:K1",
          valueInputOption: "RAW",
          requestBody: { values: [["Timestamp","Action","File Name","File ID","Folder","Details","Status","Before Snapshot","After Snapshot","Tab/Section","Retry Used"]] },
        }));

        saveCache({ workspaceId: wsId, createdId, draftsId, logsId, archiveId, exportsId, logSheetId });
        return text(`✅ AI Workspace created!\n\n📁 GYBR-AI-Workspace\n   📁 _AI-Created\n   📁 _AI-Drafts\n   📁 _AI-Logs\n   📁 _AI-Archive\n   📁 Exports\n   📊 GYBR-AI-Action-Log\n\nAll new files go to _AI-Created by default.\nEvery action is logged automatically.\nDestructive edits + deletes require confirmation.`);
      }

      // ── GET WORKSPACE INFO ──
      case "get_workspace_info": {
        const cache = loadCache();
        const draftMode = getCurrentDraftMode();
        if (!cache.workspaceId) return text(`⚠️ Workspace not set up. Run setup_ai_workspace first.`);
        return text(`📁 GYBR-AI-Workspace\n\nFolder IDs:\n  _AI-Created: ${cache.createdId}\n  _AI-Drafts: ${cache.draftsId}\n  _AI-Logs: ${cache.logsId}\n  _AI-Archive: ${cache.archiveId}\n  Exports: ${cache.exportsId}\n  Action Log: ${cache.logSheetId}\n\nCurrent Settings:\n  Draft Mode: ${draftMode.toUpperCase()}\n  Auto Backup: ${config.backup.autoBackupBeforeDestructiveEdit}\n  Confirm Overwrite: ${config.permissions.requireConfirmForOverwrite}\n  Confirm Delete: ${config.permissions.requireConfirmForDelete}\n  Max Writes/Min: ${config.rateLimits.maxWritesPerMinute}\n  Max Read Chars: ${MAX_READ_CHARS}`);
      }

      // ── SET DRAFT MODE ──
      case "set_draft_mode": {
        if (!["draft", "direct"].includes(args.mode)) return text(`❌ Invalid mode. Use 'draft' or 'direct'.`);
        sessionDraftMode = args.mode;
        return text(`✅ Draft mode set to: ${args.mode.toUpperCase()} for this session.\n\n${args.mode === "draft" ? "Claude will create revision copies instead of editing real files directly." : "Claude will edit real files directly. Destructive edits still require confirmation."}`);
      }

      // ── GET ACTION LOG ──
      case "get_action_log": {
        const cache = loadCache();
        if (!cache.logSheetId) return text(`⚠️ Action log not found. Run setup_ai_workspace first.`);
        const res = await withAuthRetry(() => sheets.spreadsheets.values.get({
          spreadsheetId: cache.logSheetId, range: "A1:K1000"
        }));
        const rows = res.data.values || [];
        if (rows.length <= 1) return text("No actions logged yet.");
        const limit = args.limit || 20;
        const recent = rows.slice(1).slice(-limit);
        return text(`📋 Last ${recent.length} logged actions:\n\n` + recent.map(r =>
          `[${r[0]}] ${r[1]} — ${r[2]} | ${r[6] || "success"}`
        ).join("\n"));
      }

      // ── SEARCH FILES ──
      case "search_files": {
        // Fix 9: sanitize query to prevent injection
        const safeQuery = (args.query || "").replace(/'/g, "\\'");
        const includeShared = args.include_shared !== false;
        const q = includeShared
          ? `(name contains '${safeQuery}' or fullText contains '${safeQuery}') and trashed = false`
          : `(name contains '${safeQuery}' or fullText contains '${safeQuery}') and trashed = false and 'me' in owners`;
        const res = await withAuthRetry(() => drive.files.list({
          q,
          pageSize: args.max_results || 10,
          fields: "files(id, name, mimeType, modifiedTime, shared)",
          corpora: "allDrives",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        }));
        const files = res.data.files || [];
        if (files.length === 0) return text("No files found.");
        return text(files.map(f =>
          `${mimeIcon(f.mimeType)} ${f.name}${f.shared ? " [shared]" : ""}\n   ID: ${f.id}\n   Modified: ${f.modifiedTime}`
        ).join("\n\n"));
      }

      // ── LIST FOLDER ──
      case "list_folder": {
        const folderId = await resolveShortcut(args.folder_id);
        const res = await withAuthRetry(() => drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          pageSize: 100,
          fields: "files(id, name, mimeType, modifiedTime)",
          orderBy: "folder,name",
        }));
        const files = res.data.files || [];
        if (files.length === 0) return text("Folder is empty.");
        return text(files.map(f => `${mimeIcon(f.mimeType)} ${f.name}\n   ID: ${f.id}`).join("\n"));
      }

      // ── READ FILE (Fixes 1, 2, 4, 10, 13, 16, 17, 18, 19, 20, 22, 23, 24, 25) ──
      case "read_file": {
        const { file_id, tab_name, section_name, start_row, end_row, include_hidden_tabs, confirm_stale } = args;
        const meta = await withAuthRetry(() => drive.files.get({
          fileId: file_id,
          fields: "name, mimeType, modifiedTime, webViewLink",
        }));
        const { name: title, mimeType, modifiedTime, webViewLink: url } = meta.data;

        // Fix 22: freshness check
        const fKey = freshnessKey(file_id, tab_name || section_name || "");
        const warnings = [];
        if (lastReadTime.has(fKey)) {
          try {
            const fm = await withAuthRetry(() => drive.files.get({ fileId: file_id, fields: "modifiedTime" }));
            if (new Date(fm.data.modifiedTime).getTime() > lastReadTime.get(fKey)) {
              if (!confirm_stale) {
                warnings.push(`STALE: File modified at ${fm.data.modifiedTime} since last read. Pass confirm_stale: true to suppress this warning.`);
              }
            }
          } catch {}
        }

        // ── Google Docs ──
        if (mimeType === "application/vnd.google-apps.document") {
          const doc = await withAuthRetry(() => docs.documents.get({ documentId: file_id }));
          let content;
          if (section_name) {
            // Fix 13: read specific heading section
            const bodyContent = doc.data.body.content;
            let inSection = false, found = false;
            const sectionLines = [];
            for (const el of bodyContent) {
              const paraStyle = el.paragraph?.paragraphStyle?.namedStyleType || "";
              const elText = (el.paragraph?.elements || []).map(e => e.textRun?.content || "").join("").trim();
              if (paraStyle.startsWith("HEADING") && elText) {
                if (inSection) break;
                if (elText.toLowerCase().includes(section_name.toLowerCase())) { inSection = true; found = true; }
              } else if (inSection) {
                sectionLines.push((el.paragraph?.elements || []).map(e => e.textRun?.content || "").join(""));
              }
            }
            if (!found) {
              const headings = bodyContent
                .filter(el => el.paragraph?.paragraphStyle?.namedStyleType?.startsWith("HEADING"))
                .map(el => (el.paragraph.elements || []).map(e => e.textRun?.content || "").join("").trim())
                .filter(Boolean);
              content = `Section "${section_name}" not found.\nAvailable headings:\n${headings.map(h => `  - ${h}`).join("\n")}`;
            } else {
              content = sectionLines.join("");
            }
          } else {
            content = (doc.data.body.content || [])
              .map(el => (el.paragraph?.elements || []).map(e => e.textRun?.content || "").join("") || "")
              .join("");
          }
          let truncated = false;
          if (content.length > MAX_READ_CHARS) { content = content.slice(0, MAX_READ_CHARS); truncated = true; }
          lastReadTime.set(fKey, Date.now());
          await logAction("READ", title, file_id, "", section_name ? `section:${section_name}` : "full", "success", { tabOrSection: section_name || "" });
          return buildFileResponse({ file_id, title, mime_type: mimeType, url, last_modified: modifiedTime, section_name, content, warnings, truncated });
        }

        // ── Google Sheets ──
        if (mimeType === "application/vnd.google-apps.spreadsheet") {
          // Fix 25: dynamic range from gridProperties
          const spreadsheet = await withAuthRetry(() => sheets.spreadsheets.get({
            spreadsheetId: file_id,
            fields: "sheets(properties(sheetId,title,hidden,gridProperties))",
          }));
          const allSheets = spreadsheet.data.sheets || [];
          const visibleSheets = allSheets.filter(s => !s.properties.hidden);
          const sheetList = (include_hidden_tabs ? allSheets : visibleSheets).map(s => s.properties.title);

          // Fix 18: tab resolution with ambiguity detection
          let targetSheet;
          if (tab_name) {
            const matches = allSheets.filter(s => s.properties.title.toLowerCase() === tab_name.toLowerCase());
            if (matches.length === 0) {
              lastReadTime.set(fKey, Date.now());
              return buildFileResponse({
                file_id, title, mime_type: mimeType, url, last_modified: modifiedTime,
                content: `Tab "${tab_name}" not found.\nAvailable tabs: ${sheetList.join(", ")}`,
                warnings, truncated: false,
              });
            }
            targetSheet = matches[0];
          } else {
            targetSheet = visibleSheets[0] || allSheets[0];
          }

          const sheetTitle = targetSheet.properties.title;
          const grid = targetSheet.properties.gridProperties;
          const colCount = Math.min(grid?.columnCount || 26, 52);
          const lastCol = colIndexToLetter(colCount);

          // Fetch header row
          const headerRes = await withAuthRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: file_id,
            range: `${sheetTitle}!A1:${lastCol}1`,
          }));
          const headers = headerRes.data.values?.[0] || [];

          // Fix 19: pagination with start_row/end_row
          const dataStart = (start_row || 1) + 1;
          const dataEnd = end_row ? end_row + 1 : (grid?.rowCount || 1000);
          const dataRes = await withAuthRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: file_id,
            range: `${sheetTitle}!A${dataStart}:${lastCol}${dataEnd}`,
          }));
          const rows = dataRes.data.values || [];

          let content = `Tabs: ${sheetList.join(", ")}\nReading tab: ${sheetTitle}\n\n${headers.join("\t")}\n${rows.map(r => r.join("\t")).join("\n")}`;
          let truncated = false;
          if (content.length > MAX_READ_CHARS) { content = content.slice(0, MAX_READ_CHARS); truncated = true; }

          const sheetFKey = freshnessKey(file_id, sheetTitle);
          lastReadTime.set(sheetFKey, Date.now());
          await logAction("READ", title, file_id, "", `tab:${sheetTitle}`, "success", { tabOrSection: sheetTitle });

          const nextPageParams = (end_row && rows.length >= (dataEnd - dataStart))
            ? { file_id, tab_name: sheetTitle, start_row: end_row + 1 } : null;

          return buildFileResponse({
            file_id, title, mime_type: mimeType, url, last_modified: modifiedTime,
            tab_name: sheetTitle, content, warnings, truncated, next_page_params: nextPageParams,
          });
        }

        // ── Google Slides ──
        if (mimeType === "application/vnd.google-apps.presentation") {
          const pres = await withAuthRetry(() => slides.presentations.get({ presentationId: file_id }));
          const slideTexts = (pres.data.slides || []).map((s, i) => {
            const t = (s.pageElements || [])
              .flatMap(el => el.shape?.text?.textElements?.map(te => te.textRun?.content || "") || [])
              .join(" ").trim();
            return `Slide ${i + 1}: ${t}`;
          });
          let content = slideTexts.join("\n");
          let truncated = false;
          if (content.length > MAX_READ_CHARS) { content = content.slice(0, MAX_READ_CHARS); truncated = true; }
          lastReadTime.set(fKey, Date.now());
          await logAction("READ", title, file_id, "", "slides", "success");
          return buildFileResponse({ file_id, title, mime_type: mimeType, url, last_modified: modifiedTime, content, warnings, truncated });
        }

        // ── .docx via mammoth (Fix 2) ──
        if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
          const res = await withAuthRetry(() =>
            drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "arraybuffer" })
          );
          const { value: rawText } = await mammoth.extractRawText({ buffer: Buffer.from(res.data) });
          let content = rawText;
          let truncated = false;
          if (content.length > MAX_READ_CHARS) { content = content.slice(0, MAX_READ_CHARS); truncated = true; }
          lastReadTime.set(fKey, Date.now());
          await logAction("READ", title, file_id, "", ".docx/mammoth", "success");
          return buildFileResponse({ file_id, title, mime_type: mimeType, url, last_modified: modifiedTime, content, warnings, truncated });
        }

        // ── .xlsx via ExcelJS (Fix 2) ──
        if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
          const res = await withAuthRetry(() =>
            drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "arraybuffer" })
          );
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(Buffer.from(res.data));
          const lines = [];
          wb.eachSheet(ws => {
            lines.push(`Sheet: ${ws.name}`);
            ws.eachRow(row => { lines.push(row.values.slice(1).join("\t")); });
          });
          let content = lines.join("\n");
          let truncated = false;
          if (content.length > MAX_READ_CHARS) { content = content.slice(0, MAX_READ_CHARS); truncated = true; }
          lastReadTime.set(fKey, Date.now());
          await logAction("READ", title, file_id, "", ".xlsx/ExcelJS", "success");
          return buildFileResponse({ file_id, title, mime_type: mimeType, url, last_modified: modifiedTime, content, warnings, truncated });
        }

        // ── Export fallback ──
        try {
          const res = await withAuthRetry(() =>
            drive.files.export({ fileId: file_id, mimeType: "text/plain" }, { responseType: "text" })
          );
          let content = res.data;
          let truncated = false;
          if (content.length > MAX_READ_CHARS) { content = content.slice(0, MAX_READ_CHARS); truncated = true; }
          lastReadTime.set(fKey, Date.now());
          await logAction("READ", title, file_id, "", "text export", "success");
          return buildFileResponse({ file_id, title, mime_type: mimeType, url, last_modified: modifiedTime, content, warnings, truncated });
        } catch {
          return buildFileResponse({
            file_id, title, mime_type: mimeType, url, last_modified: modifiedTime,
            content: `Cannot read file type: ${mimeType}. Use export_file instead.`,
            warnings, truncated: false,
          });
        }
      }

      // ── CREATE DOCUMENT ──
      case "create_document": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const doc = await withAuthRetry(() => docs.documents.create({ requestBody: { title } }));
        const fileId = doc.data.documentId;
        await withAuthRetry(() => moveToFolder(fileId, folderId));
        if (args.content) {
          await withAuthRetry(() => docs.documents.batchUpdate({
            documentId: fileId,
            requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] },
          }));
        }
        await logAction("CREATE", title, fileId, folderId, "Created Google Doc", "success");
        return text(`✅ Created: "${title}"\nID: ${fileId}\nURL: https://docs.google.com/document/d/${fileId}/edit`);
      }

      // ── CREATE SPREADSHEET ──
      case "create_spreadsheet": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const sheet = await withAuthRetry(() => sheets.spreadsheets.create({ requestBody: { properties: { title } } }));
        const fileId = sheet.data.spreadsheetId;
        await withAuthRetry(() => moveToFolder(fileId, folderId));
        await logAction("CREATE", title, fileId, folderId, "Created Google Sheet", "success");
        return text(`✅ Created: "${title}"\nID: ${fileId}\nURL: https://docs.google.com/spreadsheets/d/${fileId}/edit`);
      }

      // ── CREATE SLIDES ──
      case "create_slides": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const pres = await withAuthRetry(() => slides.presentations.create({ requestBody: { title } }));
        const fileId = pres.data.presentationId;
        await withAuthRetry(() => moveToFolder(fileId, folderId));
        await logAction("CREATE", title, fileId, folderId, "Created Google Slides", "success");
        return text(`✅ Created: "${title}"\nID: ${fileId}\nURL: https://docs.google.com/presentation/d/${fileId}/edit`);
      }

      // ── CREATE FOLDER ──
      case "create_folder": {
        const parentId = args.parent_folder_id || null;
        const folderId = await withAuthRetry(() => createFolder(args.name, parentId));
        await logAction("CREATE_FOLDER", args.name, folderId, parentId || "root", "Created folder", "success");
        return text(`✅ Created folder: "${args.name}"\nID: ${folderId}`);
      }

      // ── CREATE AND UPLOAD DOCX ──
      case "create_and_upload_docx": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const { createDocxBuffer } = await import("./docx-builder.js");
        const buffer = await createDocxBuffer(title, args.content);
        const tmpPath = path.join(os.tmpdir(), `${title}.docx`);
        fs.writeFileSync(tmpPath, buffer);
        const res = await withAuthRetry(() => drive.files.create({
          requestBody: { name: `${title}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parents: [folderId] },
          media: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: fs.createReadStream(tmpPath) },
          fields: "id",
        }));
        fs.unlinkSync(tmpPath);
        await logAction("CREATE", `${title}.docx`, res.data.id, folderId, "Uploaded Word doc", "success");
        return text(`✅ Uploaded: "${title}.docx"\nID: ${res.data.id}`);
      }

      // ── CREATE AND UPLOAD XLSX ──
      case "create_and_upload_xlsx": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const { createXlsxBuffer } = await import("./xlsx-builder.js");
        const buffer = await createXlsxBuffer(args.sheets);
        const tmpPath = path.join(os.tmpdir(), `${title}.xlsx`);
        fs.writeFileSync(tmpPath, buffer);
        const res = await withAuthRetry(() => drive.files.create({
          requestBody: { name: `${title}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", parents: [folderId] },
          media: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: fs.createReadStream(tmpPath) },
          fields: "id",
        }));
        fs.unlinkSync(tmpPath);
        await logAction("CREATE", `${title}.xlsx`, res.data.id, folderId, "Uploaded Excel file", "success");
        return text(`✅ Uploaded: "${title}.xlsx"\nID: ${res.data.id}`);
      }

      // ── CREATE AND UPLOAD PDF ──
      case "create_and_upload_pdf": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const doc = await withAuthRetry(() => docs.documents.create({ requestBody: { title } }));
        const docId = doc.data.documentId;
        if (args.content) {
          await withAuthRetry(() => docs.documents.batchUpdate({
            documentId: docId,
            requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] },
          }));
        }
        const pdfRes = await withAuthRetry(() =>
          drive.files.export({ fileId: docId, mimeType: "application/pdf" }, { responseType: "arraybuffer" })
        );
        const tmpPath = path.join(os.tmpdir(), `${title}.pdf`);
        fs.writeFileSync(tmpPath, Buffer.from(pdfRes.data));
        const uploaded = await withAuthRetry(() => drive.files.create({
          requestBody: { name: `${title}.pdf`, mimeType: "application/pdf", parents: [folderId] },
          media: { mimeType: "application/pdf", body: fs.createReadStream(tmpPath) },
          fields: "id",
        }));
        fs.unlinkSync(tmpPath);
        if (!args.keep_source_doc) await withAuthRetry(() => drive.files.update({ fileId: docId, requestBody: { trashed: true } }));
        await logAction("CREATE", `${title}.pdf`, uploaded.data.id, folderId, "Created PDF", "success");
        return text(`✅ Created PDF: "${title}.pdf"\nID: ${uploaded.data.id}`);
      }

      // ── APPEND TO DOCUMENT (Fix 16, 21, 22) ──
      case "append_to_document": {
        checkRateLimit();
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name" }));
        const doc = await withAuthRetry(() => docs.documents.get({ documentId: args.file_id }));
        const endIndex = doc.data.body.content.slice(-1)[0].endIndex - 1;
        // Fix 21: before snapshot
        const beforeSnap = (doc.data.body.content || [])
          .map(el => (el.paragraph?.elements || []).map(e => e.textRun?.content || "").join("")).join("").slice(0, 200);
        await withAuthRetry(() => docs.documents.batchUpdate({
          documentId: args.file_id,
          requestBody: { requests: [{ insertText: { location: { index: endIndex }, text: "\n" + args.content } }] },
        }));
        await logAction("EDIT_APPEND", meta.data.name, args.file_id, "", "Appended content", "success", {
          beforeSnapshot: beforeSnap,
          afterSnapshot: args.content.slice(0, 200),
        });
        return text(`✅ Content appended to "${meta.data.name}".`);
      }

      // ── APPEND ROW (Fix 17: new tool) ──
      case "append_row": {
        checkRateLimit();
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name" }));

        // Resolve target tab
        const spreadsheet = await withAuthRetry(() => sheets.spreadsheets.get({
          spreadsheetId: args.file_id,
          fields: "sheets(properties(title))",
        }));
        const allSheets = spreadsheet.data.sheets || [];
        let sheetTitle = allSheets[0]?.properties.title || "Sheet1";
        if (args.tab_name) {
          const match = allSheets.find(s => s.properties.title.toLowerCase() === args.tab_name.toLowerCase());
          if (!match) return text(`❌ Tab "${args.tab_name}" not found. Available: ${allSheets.map(s => s.properties.title).join(", ")}`);
          sheetTitle = match.properties.title;
        }

        // Fix 17: duplicate detection
        if (args.check_duplicate_column && args.values.length > 0) {
          const headerRes = await withAuthRetry(() => sheets.spreadsheets.values.get({
            spreadsheetId: args.file_id,
            range: `${sheetTitle}!1:1`,
          }));
          const headers = headerRes.data.values?.[0] || [];
          const colIdx = headers.findIndex(h => h.toLowerCase() === args.check_duplicate_column.toLowerCase());
          if (colIdx >= 0) {
            const colLetter = colIndexToLetter(colIdx + 1);
            const colRes = await withAuthRetry(() => sheets.spreadsheets.values.get({
              spreadsheetId: args.file_id,
              range: `${sheetTitle}!${colLetter}2:${colLetter}10000`,
            }));
            const existing = (colRes.data.values || []).flat().map(v => String(v).toLowerCase());
            const newVal = String(args.values[0]).toLowerCase();
            if (existing.includes(newVal)) {
              return text(`⚠️ DUPLICATE BLOCKED\n\nColumn "${args.check_duplicate_column}" already contains "${args.values[0]}".\nRow not appended.`);
            }
          }
        }

        await withAuthRetry(() => sheets.spreadsheets.values.append({
          spreadsheetId: args.file_id,
          range: `${sheetTitle}!A:A`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [args.values] },
        }));
        await logAction("EDIT_APPEND_ROW", meta.data.name, args.file_id, "", `Appended row to tab: ${sheetTitle}`, "success", {
          afterSnapshot: JSON.stringify(args.values).slice(0, 200),
          tabOrSection: sheetTitle,
        });
        return text(`✅ Row appended to "${meta.data.name}" → ${sheetTitle}.`);
      }

      // ── INSERT UNDER HEADING (Fix 8) ──
      case "insert_under_heading": {
        const { file_id, heading_text, content, heading_index, dry_run } = args;

        const [meta, doc] = await Promise.all([
          withAuthRetry(() => drive.files.get({ fileId: file_id, fields: "name" })),
          withAuthRetry(() => docs.documents.get({ documentId: file_id })),
        ]);
        const bodyContent = doc.data.body.content || [];

        // Collect styled-heading matches first
        const headingMatches = [];
        for (const el of bodyContent) {
          const paraStyle = el.paragraph?.paragraphStyle?.namedStyleType || "";
          if (!paraStyle.startsWith("HEADING")) continue;
          const elText = (el.paragraph.elements || []).map(e => e.textRun?.content || "").join("").trim();
          if (elText.toLowerCase().includes(heading_text.toLowerCase())) {
            headingMatches.push({ text: elText, style: paraStyle, startIndex: el.startIndex, endIndex: el.endIndex });
          }
        }

        // Fallback to plain body paragraphs only if no styled headings matched
        let matches = headingMatches;
        let usedFallback = false;
        if (matches.length === 0) {
          usedFallback = true;
          for (const el of bodyContent) {
            if (!el.paragraph) continue;
            const elText = (el.paragraph.elements || []).map(e => e.textRun?.content || "").join("").trim();
            if (elText.toLowerCase().includes(heading_text.toLowerCase())) {
              matches.push({
                text: elText,
                style: el.paragraph.paragraphStyle?.namedStyleType || "NORMAL_TEXT",
                startIndex: el.startIndex,
                endIndex: el.endIndex,
              });
            }
          }
        }

        if (matches.length === 0) {
          return text(`❌ No heading matching "${heading_text}" found in "${meta.data.name}".\n\nUse read_file to see document structure.`);
        }

        // Ambiguity: multiple matches, no heading_index supplied
        if (matches.length > 1 && heading_index === undefined) {
          const list = matches.map((m, i) =>
            `  [${i}] "${m.text}" (${m.style}, startIndex: ${m.startIndex})`
          ).join("\n");
          return text(`⚠️ AMBIGUOUS — ${matches.length} headings match "${heading_text}":\n\n${list}\n\nPass heading_index: <number> to specify which one.`);
        }

        const idx = heading_index ?? 0;
        if (idx < 0 || idx >= matches.length) {
          return text(`❌ heading_index ${idx} out of range. Valid range: 0–${matches.length - 1}.`);
        }
        const target = matches[idx];
        const insertAt = target.endIndex; // right after the heading's trailing \n

        if (dry_run) {
          const fallbackNote = usedFallback ? "\n⚠️ Matched as plain text (no styled heading found)." : "";
          return text(`🔍 DRY RUN — insert_under_heading\n\nFile: "${meta.data.name}"\nHeading: "${target.text}" (${target.style})\nInsert at index: ${insertAt}${fallbackNote}\n\nContent to insert:\n---\n${content}\n---\n\nNo changes made. Remove dry_run: true to execute.`);
        }

        checkRateLimit();
        const insertText = content.endsWith("\n") ? content : content + "\n";
        await withAuthRetry(() => docs.documents.batchUpdate({
          documentId: file_id,
          requestBody: { requests: [{ insertText: { location: { index: insertAt }, text: insertText } }] },
        }));

        await logAction("EDIT_INSERT", meta.data.name, file_id, "", `Inserted under heading "${target.text}"`, "success", {
          afterSnapshot: content.slice(0, 200),
          tabOrSection: target.text,
        });
        return text(`✅ Content inserted after "${target.text}" in "${meta.data.name}".`);
      }

      // ── OVERWRITE DOCUMENT (Fix 11, 16, 21) ──
      case "overwrite_document": {
        if (!args.confirm) {
          return text(`⚠️ OVERWRITE BLOCKED\n\nThis is a destructive edit that will replace ALL content.\n\nTo proceed you must:\n1. Pass confirm: true\n2. Include a reason\n\nA backup will be automatically created in AI-Archive before any changes are made.`);
        }

        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name, parents" }));
        const draftMode = args.draft_mode_override === "direct" ? "direct" : getCurrentDraftMode();

        if (draftMode === "draft") {
          const cache = loadCache();
          const draftTitle = `DRAFT_${meta.data.name}_${formatDate()}`;
          const copy = await withAuthRetry(() => drive.files.copy({
            fileId: args.file_id,
            requestBody: { name: draftTitle, parents: [cache.draftsId] },
            fields: "id, name",
          }));
          const copyId = copy.data.id;
          const copyDoc = await withAuthRetry(() => docs.documents.get({ documentId: copyId }));
          const endIndex = copyDoc.data.body.content.slice(-1)[0].endIndex - 1;
          if (endIndex > 1) {
            await withAuthRetry(() => docs.documents.batchUpdate({
              documentId: copyId,
              requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex } } }] },
            }));
          }
          await withAuthRetry(() => docs.documents.batchUpdate({
            documentId: copyId,
            requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] },
          }));
          await logAction("EDIT_DRAFT", draftTitle, copyId, cache.draftsId, `Draft of "${meta.data.name}". Reason: ${args.reason}`, "success");
          return text(`✅ DRAFT REVISION created (draft mode is ON)\n\nOriginal: "${meta.data.name}" — UNCHANGED\nDraft copy: "${draftTitle}"\nDraft ID: ${copyId}\n\nReview the draft, then use overwrite_document with draft_mode_override: 'direct' to apply to the original.`);
        }

        checkRateLimit();
        const cache = loadCache();
        const doc = await withAuthRetry(() => docs.documents.get({ documentId: args.file_id }));
        const beforeSnap = (doc.data.body.content || [])
          .map(el => (el.paragraph?.elements || []).map(e => e.textRun?.content || "").join("")).join("").slice(0, 300);

        const backupName = `${meta.data.name}.backup-${formatDate()}`;
        const backup = await withAuthRetry(() => drive.files.copy({
          fileId: args.file_id,
          requestBody: { name: backupName, parents: [cache.archiveId] },
          fields: "id",
        }));
        await logAction("BACKUP", backupName, backup.data.id, cache.archiveId, `Backup before overwrite of "${meta.data.name}"`, "success");

        const endIndex = doc.data.body.content.slice(-1)[0].endIndex - 1;
        if (endIndex > 1) {
          await withAuthRetry(() => docs.documents.batchUpdate({
            documentId: args.file_id,
            requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex } } }] },
          }));
        }
        await withAuthRetry(() => docs.documents.batchUpdate({
          documentId: args.file_id,
          requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] },
        }));
        await logAction("EDIT_OVERWRITE", meta.data.name, args.file_id, "", `Overwritten. Reason: ${args.reason}. Backup: ${backup.data.id}`, "success", {
          beforeSnapshot: beforeSnap,
          afterSnapshot: args.content.slice(0, 300),
        });
        return text(`✅ "${meta.data.name}" overwritten.\n\nBackup saved: "${backupName}" in AI-Archive\nBackup ID: ${backup.data.id}\nReason logged: ${args.reason}`);
      }

      // ── UPDATE SHEET VALUES ──
      case "update_sheet_values": {
        checkRateLimit();
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name" }));
        await withAuthRetry(() => sheets.spreadsheets.values.update({
          spreadsheetId: args.file_id,
          range: args.range,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: args.values },
        }));
        await logAction("EDIT_SHEET", meta.data.name, args.file_id, "", `Updated range ${args.range}`, "success", {
          afterSnapshot: JSON.stringify(args.values).slice(0, 200),
        });
        return text(`✅ "${meta.data.name}" updated at range ${args.range}.`);
      }

      // ── COPY FILE ──
      case "copy_file": {
        const cache = loadCache();
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name" }));
        const destFolder = args.folder_id || cache.createdId;
        const copyName = args.new_name || `Copy of ${meta.data.name}`;
        const res = await withAuthRetry(() => drive.files.copy({
          fileId: args.file_id,
          requestBody: { name: copyName, parents: destFolder ? [destFolder] : undefined },
          fields: "id, name",
        }));
        await logAction("COPY", res.data.name, res.data.id, destFolder || "", `Copied from "${meta.data.name}"`, "success");
        return text(`✅ Copied as: "${res.data.name}"\nID: ${res.data.id}`);
      }

      // ── MOVE FILE (Fix 12: dry_run) ──
      case "move_file": {
        const cache = loadCache();
        const destFolder = args.new_folder_id === "archive" ? cache.archiveId : args.new_folder_id;
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name, parents" }));
        const currentParents = (meta.data.parents || []).join(",");

        if (args.dry_run) {
          return text(`🔍 DRY RUN — Move preview\n\nFile: "${meta.data.name}" (${args.file_id})\nFrom folder(s): ${currentParents}\nTo folder: ${destFolder}\n\nNo changes made. Remove dry_run: true to execute.`);
        }

        await withAuthRetry(() => drive.files.update({
          fileId: args.file_id,
          addParents: destFolder,
          removeParents: currentParents,
          fields: "id, parents",
        }));
        await logAction("MOVE", meta.data.name, args.file_id, destFolder, "Moved file", "success");
        return text(`✅ "${meta.data.name}" moved successfully.`);
      }

      // ── RENAME FILE ──
      case "rename_file": {
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name" }));
        await withAuthRetry(() => drive.files.update({
          fileId: args.file_id,
          requestBody: { name: args.new_name },
          fields: "id, name",
        }));
        await logAction("RENAME", args.new_name, args.file_id, "", `Renamed from "${meta.data.name}"`, "success", {
          beforeSnapshot: meta.data.name,
          afterSnapshot: args.new_name,
        });
        return text(`✅ Renamed to: "${args.new_name}"`);
      }

      // ── DELETE FILE (Fix 3: soft delete only) ──
      case "delete_file": {
        if (!args.confirm) {
          return text(`⚠️ DELETE BLOCKED\n\nTo delete a file you must:\n1. Pass confirm: true\n2. Provide a reason\n\nNote: Files are only moved to trash, never permanently deleted.`);
        }
        if (!args.reason) {
          return text(`⚠️ DELETE BLOCKED\n\nA reason is required for all deletions.`);
        }
        if (deleteCount >= config.rateLimits.maxDeletesPerSession) {
          return text(`⚠️ DELETE LIMIT REACHED\n\nMax ${config.rateLimits.maxDeletesPerSession} deletes per session reached. Restart Claude Desktop to reset.`);
        }
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name" }));
        await withAuthRetry(() => drive.files.update({ fileId: args.file_id, requestBody: { trashed: true } }));
        deleteCount++;
        await logAction("DELETE", meta.data.name, args.file_id, "", `Trashed. Reason: ${args.reason}`, "success");
        return text(`🗑️ "${meta.data.name}" moved to trash.\nReason: ${args.reason}\nDeletes this session: ${deleteCount}/${config.rateLimits.maxDeletesPerSession}`);
      }

      // ── SHARE FILE ──
      case "share_file": {
        const meta = await withAuthRetry(() => drive.files.get({ fileId: args.file_id, fields: "name" }));
        await withAuthRetry(() => drive.permissions.create({
          fileId: args.file_id,
          requestBody: { type: "user", role: args.role, emailAddress: args.email },
        }));
        await logAction("SHARE", meta.data.name, args.file_id, "", `Shared with ${args.email} as ${args.role}`, "success");
        return text(`✅ "${meta.data.name}" shared with ${args.email} as ${args.role}.`);
      }

      // ── EXPORT FILE ──
      case "export_file": {
        const cache = loadCache();
        const folderId = args.folder_id || cache.exportsId || cache.createdId;
        const mimeMap = {
          pdf: "application/pdf",
          docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        const exportMime = mimeMap[args.format];
        if (!exportMime) return text(`❌ Unknown format: ${args.format}. Use pdf, docx, or xlsx.`);
        const exportRes = await withAuthRetry(() =>
          drive.files.export({ fileId: args.file_id, mimeType: exportMime }, { responseType: "arraybuffer" })
        );
        const fileName = `${args.output_name}.${args.format}`;
        const tmpPath = path.join(os.tmpdir(), fileName);
        fs.writeFileSync(tmpPath, Buffer.from(exportRes.data));
        const uploaded = await withAuthRetry(() => drive.files.create({
          requestBody: { name: fileName, mimeType: exportMime, parents: [folderId] },
          media: { mimeType: exportMime, body: fs.createReadStream(tmpPath) },
          fields: "id",
        }));
        fs.unlinkSync(tmpPath);
        await logAction("EXPORT", fileName, uploaded.data.id, folderId, `Exported as ${args.format}`, "success");
        return text(`✅ Exported as ${args.format.toUpperCase()}: "${fileName}"\nID: ${uploaded.data.id}`);
      }

      default:
        return text(`Unknown tool: ${name}`);
    }
  } catch (err) {
    await logAction("ERROR", name, "", "", err.message, "error").catch(() => {});
    return text(`❌ Error: ${err.message}`);
  }
});

// ─── Helper Functions ─────────────────────────────────────────────────────────

function getCurrentDraftMode() {
  if (sessionDraftMode !== null) return sessionDraftMode;
  return config.draftMode?.defaultMode || "draft";
}

function applyNaming(title) {
  if (title.startsWith("AI_")) return title;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `AI_${date}_${title}`;
}

function formatDate() {
  return new Date().toISOString().slice(0, 16).replace("T", "T").replace(/:/g, "-");
}

// Fix 5: persist rate limit state to disk
function saveRateLimit() {
  try { fs.writeFileSync(RATELIMIT_PATH, JSON.stringify({ timestamps: writeTimestamps }, null, 2)); } catch {}
}

function checkRateLimit() {
  const now = Date.now(), ago = now - 60000;
  while (writeTimestamps.length && writeTimestamps[0] < ago) writeTimestamps.shift();
  if (writeTimestamps.length >= config.rateLimits.maxWritesPerMinute) {
    throw new Error(`Rate limit reached: max ${config.rateLimits.maxWritesPerMinute} writes per minute. Wait a moment and try again.`);
  }
  writeTimestamps.push(now);
  saveRateLimit();
}

async function resolveShortcut(folderId) {
  const cache = loadCache();
  const shortcuts = {
    root: "root",
    workspace: cache.workspaceId,
    created: cache.createdId,
    drafts: cache.draftsId,
    archive: cache.archiveId,
    exports: cache.exportsId,
    logs: cache.logsId,
  };
  return shortcuts[folderId] || folderId;
}

async function resolveWorkspaceFolder(folderArg, cache) {
  if (!folderArg || folderArg === "created") return cache.createdId || "root";
  if (folderArg === "drafts") return cache.draftsId || "root";
  if (folderArg === "exports") return cache.exportsId || "root";
  return folderArg;
}

// Fix 21: extended 11-column log
async function logAction(action, fileName, fileId, folderId, details, status, extras = {}) {
  try {
    if (!config.logging.logReads && action === "READ") return;
    const cache = loadCache();
    if (!cache.logSheetId) return;
    const { beforeSnapshot = "", afterSnapshot = "", tabOrSection = "", retryUsed = false } = extras;
    await sheets.spreadsheets.values.append({
      spreadsheetId: cache.logSheetId,
      range: "A:K",
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          new Date().toISOString(), action, fileName, fileId, folderId, details, status,
          String(beforeSnapshot).slice(0, 300),
          String(afterSnapshot).slice(0, 300),
          tabOrSection,
          retryUsed ? "yes" : "no",
        ]],
      },
    });
  } catch {}
}

async function createFolder(name, parentId) {
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : [],
    },
    fields: "id",
  });
  return res.data.id;
}

async function moveToFolder(fileId, newFolderId) {
  const fileMeta = await drive.files.get({ fileId, fields: "parents" });
  await drive.files.update({
    fileId,
    addParents: newFolderId,
    removeParents: (fileMeta.data.parents || []).join(","),
    fields: "id, parents",
  });
}

function loadCache() {
  try { if (fs.existsSync(CACHE_PATH)) return JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")); } catch {}
  return {};
}

function saveCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

function text(content) {
  return { content: [{ type: "text", text: content }] };
}

function mimeIcon(mimeType) {
  if (!mimeType) return "📄";
  if (mimeType.includes("folder")) return "📁";
  if (mimeType.includes("document")) return "📝";
  if (mimeType.includes("spreadsheet")) return "📊";
  if (mimeType.includes("presentation")) return "🎬";
  if (mimeType.includes("pdf")) return "📕";
  if (mimeType.includes("image")) return "🖼️";
  return "📄";
}

// Fix 24: column index to spreadsheet letter (A, B, ..., Z, AA, ...)
function colIndexToLetter(n) {
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || "A";
}

// Fix 22: freshness key
function freshnessKey(fileId, tabOrSection) {
  return tabOrSection ? `${fileId}::${tabOrSection}` : fileId;
}

// Fix 1: normalized response shape for all read_file branches
function buildFileResponse({
  file_id, title, mime_type, url, last_modified,
  tab_name, section_name, content, warnings, truncated,
  page, total_pages, next_page_params,
}) {
  const meta = [
    `file_id: ${file_id}`,
    `title: ${title}`,
    `mime_type: ${mime_type}`,
    url              ? `url: ${url}`                         : null,
    last_modified    ? `last_modified: ${last_modified}`     : null,
    tab_name         ? `tab_name: ${tab_name}`               : null,
    section_name     ? `section_name: ${section_name}`       : null,
    `truncated: ${truncated || false}`,
    page !== undefined        ? `page: ${page}`              : null,
    total_pages !== undefined ? `total_pages: ${total_pages}`: null,
  ].filter(Boolean).join("\n");

  const w = warnings?.length
    ? `\n⚠️ Warnings:\n${warnings.map((x) => `  - ${x}`).join("\n")}\n`
    : "";
  const np = next_page_params
    ? `\n📄 Next page params: ${JSON.stringify(next_page_params)}\n`
    : "";

  return text(`${meta}\n${w}${np}\n---\n${content}`);
}

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("GYBR Google Drive MCP Server v5.1 — Full Governance Edition running.");
