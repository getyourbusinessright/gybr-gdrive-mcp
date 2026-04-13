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
