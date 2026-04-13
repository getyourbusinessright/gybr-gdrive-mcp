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
