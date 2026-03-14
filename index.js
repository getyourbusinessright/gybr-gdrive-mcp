#!/usr/bin/env node

/**
 * GYBR Google Drive MCP Server v4.1 — Full Governance Edition
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

// ─── Load Config ──────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), "gybr-mcp-config.json");
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// ─── Load Credentials ─────────────────────────────────────────────────────────

const CREDENTIALS_PATH =
  process.env.GDRIVE_CREDENTIALS_PATH ||
  path.join(os.homedir(), ".gdrive-server-credentials.json");

if (!fs.existsSync(CREDENTIALS_PATH)) {
  console.error(`Credentials not found at: ${CREDENTIALS_PATH}`);
  process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
const auth = new google.auth.OAuth2();
auth.setCredentials(credentials);
google.options({ auth });

const drive = google.drive({ version: "v3", auth });
const docs = google.docs({ version: "v1", auth });
const sheets = google.sheets({ version: "v4", auth });
const slides = google.slides({ version: "v1", auth });

// ─── Cache & State ────────────────────────────────────────────────────────────

const CACHE_PATH = path.join(os.homedir(), ".gdrive-mcp-workspace-cache.json");

// Rate limiting state
const writeTimestamps = [];
let deleteCount = 0;

// Session draft mode (overrides config default)
let sessionDraftMode = null;

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "gybr-gdrive-v4", version: "4.1.0" },
  { capabilities: { tools: {} } }
);

// ─── Tools ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    // ── SETUP & CONTROL ──
    {
      name: "setup_ai_workspace",
      description: "One-time setup: creates GYBR-AI-Workspace folder structure and action log in Google Drive. Run this first.",
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
      description: "Read contents of any file anywhere in Drive — Google Docs, Sheets, Slides, or plain text. READ ONLY.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "Google Drive file ID" },
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

    // ── EDIT EXISTING (anywhere, split standard/destructive) ──
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
      name: "overwrite_document",
      description: "DESTRUCTIVE EDIT — Replaces ALL content in a Google Doc. Requires confirm=true + reason. Auto-backup created in AI-Archive first. Show preview before calling.",
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
      description: "Move a file to a different folder. Use 'archive' to move to AI-Archive.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File ID to move" },
          new_folder_id: { type: "string", description: "Destination folder ID or 'archive'" },
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
      description: "⚠️ DESTRUCTIVE — Moves file to trash (soft delete only, never permanent). CRITICAL RULES: (1) NEVER ask the user conversationally if they want to delete — always return the BLOCKED message immediately if confirm is not explicitly set to true in the tool call. (2) NEVER proceed without confirm=true AND a reason string. (3) If the user says 'yes', 'sure', 'go ahead' in conversation — that does NOT count as confirm=true. They must explicitly say 'confirm=true' or you must pass confirm:true in the tool call. (4) Always show the file name and ID before attempting deletion.",
      inputSchema: {
        type: "object",
        properties: {
          file_id: { type: "string", description: "File ID to trash" },
          confirm: { type: "boolean", description: "MUST be explicitly true to proceed. Conversational 'yes' does not count." },
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

// ─── Handlers ─────────────────────────────────────────────────────────────────

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
        const wsId = await createFolder("GYBR-AI-Workspace", null);
        const createdId = await createFolder("_AI-Created", wsId);
        const draftsId = await createFolder("_AI-Drafts", wsId);
        const logsId = await createFolder("_AI-Logs", wsId);
        const archiveId = await createFolder("_AI-Archive", wsId);
        const exportsId = await createFolder("Exports", wsId);

        const logSheet = await sheets.spreadsheets.create({ requestBody: { properties: { title: "GYBR-AI-Action-Log" } } });
        const logSheetId = logSheet.data.spreadsheetId;
        await moveToFolder(logSheetId, logsId);
        await sheets.spreadsheets.values.update({
          spreadsheetId: logSheetId,
          range: "A1:G1",
          valueInputOption: "RAW",
          requestBody: { values: [["Timestamp", "Action", "File Name", "File ID", "Folder", "Details", "Status"]] },
        });

        saveCache({ workspaceId: wsId, createdId, draftsId, logsId, archiveId, exportsId, logSheetId });
        return text(`✅ AI Workspace created!\n\n📁 GYBR-AI-Workspace\n   📁 _AI-Created\n   📁 _AI-Drafts\n   📁 _AI-Logs\n   📁 _AI-Archive\n   📁 Exports\n   📊 GYBR-AI-Action-Log\n\nAll new files go to _AI-Created by default.\nEvery action is logged automatically.\nDestructive edits + deletes require confirmation.`);
      }

      // ── GET WORKSPACE INFO ──
      case "get_workspace_info": {
        const cache = loadCache();
        const draftMode = getCurrentDraftMode();
        if (!cache.workspaceId) return text(`⚠️ Workspace not set up. Run setup_ai_workspace first.`);
        return text(`📁 GYBR-AI-Workspace\n\nFolder IDs:\n  _AI-Created: ${cache.createdId}\n  _AI-Drafts: ${cache.draftsId}\n  _AI-Logs: ${cache.logsId}\n  _AI-Archive: ${cache.archiveId}\n  Exports: ${cache.exportsId}\n  Action Log: ${cache.logSheetId}\n\nCurrent Settings:\n  Draft Mode: ${draftMode.toUpperCase()}\n  Auto Backup: ${config.backup.autoBackupBeforeDestructiveEdit}\n  Confirm Overwrite: ${config.permissions.requireConfirmForOverwrite}\n  Confirm Delete: ${config.permissions.requireConfirmForDelete}\n  Max Writes/Min: ${config.rateLimits.maxWritesPerMinute}`);
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
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: cache.logSheetId, range: "A1:G1000" });
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
        const includeShared = args.include_shared !== false;
        const q = includeShared
          ? `(name contains '${args.query}' or fullText contains '${args.query}') and trashed = false`
          : `(name contains '${args.query}' or fullText contains '${args.query}') and trashed = false and 'me' in owners`;
        const res = await drive.files.list({
          q,
          pageSize: args.max_results || 10,
          fields: "files(id, name, mimeType, modifiedTime, shared)",
          corpora: "allDrives",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
        const files = res.data.files || [];
        if (files.length === 0) return text("No files found.");
        return text(files.map(f =>
          `${mimeIcon(f.mimeType)} ${f.name}${f.shared ? " [shared]" : ""}\n   ID: ${f.id}\n   Modified: ${f.modifiedTime}`
        ).join("\n\n"));
      }

      // ── LIST FOLDER ──
      case "list_folder": {
        const folderId = await resolveShortcut(args.folder_id);
        const res = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false`,
          pageSize: 100,
          fields: "files(id, name, mimeType, modifiedTime)",
          orderBy: "folder,name",
        });
        const files = res.data.files || [];
        if (files.length === 0) return text("Folder is empty.");
        return text(files.map(f => `${mimeIcon(f.mimeType)} ${f.name}\n   ID: ${f.id}`).join("\n"));
      }

      // ── READ FILE ──
      case "read_file": {
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name, mimeType" });
        const mimeType = meta.data.mimeType;
        if (mimeType === "application/vnd.google-apps.document") {
          const doc = await docs.documents.get({ documentId: args.file_id });
          const content = doc.data.body.content.map(el => el.paragraph?.elements?.map(e => e.textRun?.content || "").join("") || "").join("");
          return text(`📄 ${meta.data.name}\n\n${content}`);
        }
        if (mimeType === "application/vnd.google-apps.spreadsheet") {
          const sheet = await sheets.spreadsheets.values.get({ spreadsheetId: args.file_id, range: "A1:Z1000" });
          return text(`📊 ${meta.data.name}\n\n${(sheet.data.values || []).map(r => r.join("\t")).join("\n")}`);
        }
        if (mimeType === "application/vnd.google-apps.presentation") {
          const pres = await slides.presentations.get({ presentationId: args.file_id });
          const slideTexts = pres.data.slides.map((s, i) => {
            const t = (s.pageElements || []).flatMap(el => el.shape?.text?.textElements?.map(te => te.textRun?.content || "") || []).join(" ").trim();
            return `Slide ${i + 1}: ${t}`;
          });
          return text(`🎬 ${meta.data.name}\n\n${slideTexts.join("\n")}`);
        }
        try {
          const res = await drive.files.export({ fileId: args.file_id, mimeType: "text/plain" }, { responseType: "text" });
          return text(`📄 ${meta.data.name}\n\n${res.data}`);
        } catch {
          return text(`Cannot read file type: ${mimeType}. Use export_file instead.`);
        }
      }

      // ── CREATE DOCUMENT ──
      case "create_document": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const doc = await docs.documents.create({ requestBody: { title } });
        const fileId = doc.data.documentId;
        await moveToFolder(fileId, folderId);
        if (args.content) {
          await docs.documents.batchUpdate({ documentId: fileId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] } });
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
        const sheet = await sheets.spreadsheets.create({ requestBody: { properties: { title } } });
        const fileId = sheet.data.spreadsheetId;
        await moveToFolder(fileId, folderId);
        await logAction("CREATE", title, fileId, folderId, "Created Google Sheet", "success");
        return text(`✅ Created: "${title}"\nID: ${fileId}\nURL: https://docs.google.com/spreadsheets/d/${fileId}/edit`);
      }

      // ── CREATE SLIDES ──
      case "create_slides": {
        checkRateLimit();
        const cache = loadCache();
        const folderId = await resolveWorkspaceFolder(args.folder, cache);
        const title = applyNaming(args.title);
        const pres = await slides.presentations.create({ requestBody: { title } });
        const fileId = pres.data.presentationId;
        await moveToFolder(fileId, folderId);
        await logAction("CREATE", title, fileId, folderId, "Created Google Slides", "success");
        return text(`✅ Created: "${title}"\nID: ${fileId}\nURL: https://docs.google.com/presentation/d/${fileId}/edit`);
      }

      // ── CREATE FOLDER ──
      case "create_folder": {
        const parentId = args.parent_folder_id || null;
        const folderId = await createFolder(args.name, parentId);
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
        const res = await drive.files.create({
          requestBody: { name: `${title}.docx`, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parents: [folderId] },
          media: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: fs.createReadStream(tmpPath) },
          fields: "id",
        });
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
        const res = await drive.files.create({
          requestBody: { name: `${title}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", parents: [folderId] },
          media: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", body: fs.createReadStream(tmpPath) },
          fields: "id",
        });
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
        const doc = await docs.documents.create({ requestBody: { title } });
        const docId = doc.data.documentId;
        if (args.content) {
          await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] } });
        }
        const pdfRes = await drive.files.export({ fileId: docId, mimeType: "application/pdf" }, { responseType: "arraybuffer" });
        const tmpPath = path.join(os.tmpdir(), `${title}.pdf`);
        fs.writeFileSync(tmpPath, Buffer.from(pdfRes.data));
        const uploaded = await drive.files.create({
          requestBody: { name: `${title}.pdf`, mimeType: "application/pdf", parents: [folderId] },
          media: { mimeType: "application/pdf", body: fs.createReadStream(tmpPath) },
          fields: "id",
        });
        fs.unlinkSync(tmpPath);
        if (!args.keep_source_doc) await drive.files.delete({ fileId: docId });
        await logAction("CREATE", `${title}.pdf`, uploaded.data.id, folderId, "Created PDF", "success");
        return text(`✅ Created PDF: "${title}.pdf"\nID: ${uploaded.data.id}`);
      }

      // ── APPEND TO DOCUMENT (standard edit) ──
      case "append_to_document": {
        checkRateLimit();
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name" });
        const doc = await docs.documents.get({ documentId: args.file_id });
        const endIndex = doc.data.body.content.slice(-1)[0].endIndex - 1;
        await docs.documents.batchUpdate({
          documentId: args.file_id,
          requestBody: { requests: [{ insertText: { location: { index: endIndex }, text: "\n" + args.content } }] },
        });
        await logAction("EDIT_APPEND", meta.data.name, args.file_id, "", "Appended content", "success");
        return text(`✅ Content appended to "${meta.data.name}".`);
      }

      // ── OVERWRITE DOCUMENT (destructive edit) ──
      case "overwrite_document": {
        if (!args.confirm) {
          return text(`⚠️ OVERWRITE BLOCKED\n\nThis is a destructive edit that will replace ALL content.\n\nTo proceed you must:\n1. Pass confirm: true\n2. Include a reason\n\nA backup will be automatically created in AI-Archive before any changes are made.`);
        }

        const meta = await drive.files.get({ fileId: args.file_id, fields: "name, parents" });
        const draftMode = args.draft_mode_override === "direct" ? "direct" : getCurrentDraftMode();

        // Draft mode — create a copy instead
        if (draftMode === "draft") {
          const cache = loadCache();
          const draftTitle = `DRAFT_${meta.data.name}_${formatDate()}`;
          const copy = await drive.files.copy({
            fileId: args.file_id,
            requestBody: { name: draftTitle, parents: [cache.draftsId] },
            fields: "id, name",
          });
          const copyId = copy.data.id;
          const copyDoc = await docs.documents.get({ documentId: copyId });
          const endIndex = copyDoc.data.body.content.slice(-1)[0].endIndex - 1;
          if (endIndex > 1) {
            await docs.documents.batchUpdate({ documentId: copyId, requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex } } }] } });
          }
          await docs.documents.batchUpdate({ documentId: copyId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] } });
          await logAction("EDIT_DRAFT", draftTitle, copyId, cache.draftsId, `Draft revision of "${meta.data.name}". Reason: ${args.reason}`, "success");
          return text(`✅ DRAFT REVISION created (draft mode is ON)\n\nOriginal: "${meta.data.name}" — UNCHANGED\nDraft copy: "${draftTitle}"\nDraft ID: ${copyId}\n\nReview the draft, then use overwrite_document with draft_mode_override: 'direct' to apply to the original.`);
        }

        // Direct mode — backup first, then overwrite
        checkRateLimit();
        const cache = loadCache();

        // Step 1: Create backup
        const backupName = `${meta.data.name}.backup-${formatDate()}`;
        const backup = await drive.files.copy({
          fileId: args.file_id,
          requestBody: { name: backupName, parents: [cache.archiveId] },
          fields: "id, name",
        });
        await logAction("BACKUP", backupName, backup.data.id, cache.archiveId, `Backup before overwrite of "${meta.data.name}"`, "success");

        // Step 2: Overwrite
        const doc = await docs.documents.get({ documentId: args.file_id });
        const endIndex = doc.data.body.content.slice(-1)[0].endIndex - 1;
        if (endIndex > 1) {
          await docs.documents.batchUpdate({ documentId: args.file_id, requestBody: { requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex } } }] } });
        }
        await docs.documents.batchUpdate({ documentId: args.file_id, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: args.content } }] } });
        await logAction("EDIT_OVERWRITE", meta.data.name, args.file_id, "", `Overwritten. Reason: ${args.reason}. Backup ID: ${backup.data.id}`, "success");
        return text(`✅ "${meta.data.name}" overwritten.\n\nBackup saved: "${backupName}" in AI-Archive\nBackup ID: ${backup.data.id}\nReason logged: ${args.reason}`);
      }

      // ── UPDATE SHEET VALUES ──
      case "update_sheet_values": {
        checkRateLimit();
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name" });
        await sheets.spreadsheets.values.update({
          spreadsheetId: args.file_id,
          range: args.range,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: args.values },
        });
        await logAction("EDIT_SHEET", meta.data.name, args.file_id, "", `Updated range ${args.range}`, "success");
        return text(`✅ "${meta.data.name}" updated at range ${args.range}.`);
      }

      // ── COPY FILE ──
      case "copy_file": {
        const cache = loadCache();
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name" });
        const destFolder = args.folder_id || cache.createdId;
        const copyName = args.new_name || `Copy of ${meta.data.name}`;
        const res = await drive.files.copy({
          fileId: args.file_id,
          requestBody: { name: copyName, parents: destFolder ? [destFolder] : undefined },
          fields: "id, name",
        });
        await logAction("COPY", res.data.name, res.data.id, destFolder || "", `Copied from "${meta.data.name}"`, "success");
        return text(`✅ Copied as: "${res.data.name}"\nID: ${res.data.id}`);
      }

      // ── MOVE FILE ──
      case "move_file": {
        const cache = loadCache();
        const destFolder = args.new_folder_id === "archive" ? cache.archiveId : args.new_folder_id;
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name" });
        await moveToFolder(args.file_id, destFolder);
        await logAction("MOVE", meta.data.name, args.file_id, destFolder, `Moved file`, "success");
        return text(`✅ "${meta.data.name}" moved successfully.`);
      }

      // ── RENAME FILE ──
      case "rename_file": {
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name" });
        await drive.files.update({ fileId: args.file_id, requestBody: { name: args.new_name }, fields: "id, name" });
        await logAction("RENAME", args.new_name, args.file_id, "", `Renamed from "${meta.data.name}"`, "success");
        return text(`✅ Renamed to: "${args.new_name}"`);
      }

      // ── DELETE FILE (protected) ──
      case "delete_file": {
        if (!args.confirm) {
          return text(`⚠️ DELETE BLOCKED\n\nTo delete a file you must:\n1. Pass confirm: true\n2. Provide a reason\n\nNote: Files are only moved to trash, never permanently deleted.`);
        }
        if (!args.reason) {
          return text(`⚠️ DELETE BLOCKED\n\nA reason is required for all deletions. Please provide a reason.`);
        }
        if (deleteCount >= config.rateLimits.maxDeletesPerSession) {
          return text(`⚠️ DELETE LIMIT REACHED\n\nMax ${config.rateLimits.maxDeletesPerSession} deletes per session reached. Restart Claude Desktop to reset.`);
        }
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name" });
        await drive.files.update({ fileId: args.file_id, requestBody: { trashed: true } });
        deleteCount++;
        await logAction("DELETE", meta.data.name, args.file_id, "", `Trashed. Reason: ${args.reason}`, "success");
        return text(`🗑️ "${meta.data.name}" moved to trash.\nReason: ${args.reason}\nDeletes this session: ${deleteCount}/${config.rateLimits.maxDeletesPerSession}`);
      }

      // ── SHARE FILE ──
      case "share_file": {
        const meta = await drive.files.get({ fileId: args.file_id, fields: "name" });
        await drive.permissions.create({
          fileId: args.file_id,
          requestBody: { type: "user", role: args.role, emailAddress: args.email },
        });
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
        const mimeType = mimeMap[args.format];
        if (!mimeType) return text(`❌ Unknown format: ${args.format}. Use pdf, docx, or xlsx.`);

        const exportRes = await drive.files.export({ fileId: args.file_id, mimeType }, { responseType: "arraybuffer" });
        const fileName = `${args.output_name}.${args.format}`;
        const tmpPath = path.join(os.tmpdir(), fileName);
        fs.writeFileSync(tmpPath, Buffer.from(exportRes.data));
        const uploaded = await drive.files.create({
          requestBody: { name: fileName, mimeType, parents: [folderId] },
          media: { mimeType, body: fs.createReadStream(tmpPath) },
          fields: "id",
        });
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

// ─── Governance Helpers ───────────────────────────────────────────────────────

function getCurrentDraftMode() {
  if (sessionDraftMode !== null) return sessionDraftMode;
  return config.draftMode.defaultMode || "draft";
}

function applyNaming(title) {
  if (title.startsWith("AI_")) return title;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `AI_${date}_${title}`;
}

function formatDate() {
  return new Date().toISOString().slice(0, 16).replace("T", "T").replace(/:/g, "-");
}

function checkRateLimit() {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  while (writeTimestamps.length > 0 && writeTimestamps[0] < oneMinuteAgo) writeTimestamps.shift();
  if (writeTimestamps.length >= config.rateLimits.maxWritesPerMinute) {
    throw new Error(`Rate limit reached: max ${config.rateLimits.maxWritesPerMinute} writes per minute. Wait a moment and try again.`);
  }
  writeTimestamps.push(now);
}

async function resolveShortcut(folderId) {
  const cache = loadCache();
  const shortcuts = { root: "root", workspace: cache.workspaceId, created: cache.createdId, drafts: cache.draftsId, archive: cache.archiveId, exports: cache.exportsId, logs: cache.logsId };
  return shortcuts[folderId] || folderId;
}

async function resolveWorkspaceFolder(folderArg, cache) {
  if (!folderArg || folderArg === "created") return cache.createdId || "root";
  if (folderArg === "drafts") return cache.draftsId || "root";
  if (folderArg === "exports") return cache.exportsId || "root";
  return folderArg;
}

async function logAction(action, fileName, fileId, folderId, details, status) {
  try {
    if (!config.logging.logReads && action === "READ") return;
    const cache = loadCache();
    if (!cache.logSheetId) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: cache.logSheetId,
      range: "A:G",
      valueInputOption: "RAW",
      requestBody: { values: [[new Date().toISOString(), action, fileName, fileId, folderId, details, status]] },
    });
  } catch {}
}

async function createFolder(name, parentId) {
  const res = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : [] },
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

function saveCache(data) { fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2)); }

function text(content) { return { content: [{ type: "text", text: content }] }; }

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

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("GYBR Google Drive MCP Server v4.1 — Full Governance Edition running.");
