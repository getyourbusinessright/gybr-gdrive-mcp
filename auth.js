#!/usr/bin/env node

/**
 * GYBR Google Drive MCP Server - Auth Flow
 * Self-contained authentication with full Drive access scope
 */

import { google } from "googleapis";
import { authenticate } from "@google-cloud/local-auth";
import fs from "fs";
import path from "path";
import os from "os";

// ─── GYBR Data Directory (Fix 26) ─────────────────────────────────────────────
const GYBR_MCP_DIR = path.join(os.homedir(), "gybr-mcp");
if (!fs.existsSync(GYBR_MCP_DIR)) fs.mkdirSync(GYBR_MCP_DIR, { recursive: true });

// ─── Config ───────────────────────────────────────────────────────────────────
const OAUTH_PATH =
  process.env.GDRIVE_OAUTH_PATH ||
  path.join(GYBR_MCP_DIR, "gcp-oauth.keys.json");

const CREDENTIALS_PATH =
  process.env.GDRIVE_CREDENTIALS_PATH ||
  path.join(GYBR_MCP_DIR, ".gdrive-server-credentials.json");

// Full read/write access scope
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
];

// ─── Auth Flow ────────────────────────────────────────────────────────────────
async function runAuth() {
  console.log("\n============================================================");
  console.log("  GYBR Google Drive MCP Server - Authentication");
  console.log("  Get Your Business Right LLC");
  console.log("============================================================\n");

  if (!fs.existsSync(OAUTH_PATH)) {
    console.error(`ERROR: OAuth keys file not found at: ${OAUTH_PATH}`);
    console.error(`\nPlease place gcp-oauth.keys.json in: ${GYBR_MCP_DIR}`);
    process.exit(1);
  }

  console.log("Launching authentication flow...");
  console.log("A browser window will open. Sign in with your Google account");
  console.log("and click Allow when prompted.\n");

  try {
    const authClient = await authenticate({
      keyfilePath: OAUTH_PATH,
      scopes: SCOPES,
    });

    fs.writeFileSync(
      CREDENTIALS_PATH,
      JSON.stringify(authClient.credentials, null, 2)
    );

    console.log("\n============================================================");
    console.log("  AUTHENTICATION SUCCESSFUL!");
    console.log("============================================================\n");
    console.log(`Credentials saved to: ${CREDENTIALS_PATH}`);
    console.log("\nPlease restart Claude Desktop for changes to take effect.");
    console.log("Right-click the Claude icon in your system tray");
    console.log("and select Quit, then reopen it.\n");

  } catch (err) {
    console.error(`\nERROR: Authentication failed: ${err.message}`);
    console.error("Please try running auth again.");
    process.exit(1);
  }
}

runAuth();
