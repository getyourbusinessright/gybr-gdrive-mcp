#!/usr/bin/env node

/**
 * GYBR Google Drive MCP Server - Auth Flow
 *
 * CSRF-protected OAuth2: generates a cryptographically random state before
 * redirecting to Google and verifies it matches on the callback, preventing
 * cross-site request forgery during sign-in.
 *
 * Replaces @google-cloud/local-auth, which did not include a state parameter.
 */

import { google } from "googleapis";
import { createServer } from "http";
import { randomBytes } from "crypto";
import { exec } from "child_process";
import { URL as NodeURL } from "url";
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

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
];

// ─── Browser Launch ───────────────────────────────────────────────────────────

function openBrowser(url) {
  const cmd =
    process.platform === "win32"  ? `start "" "${url}"` :
    process.platform === "darwin" ? `open "${url}"` :
                                    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error("Note: could not open browser automatically. Copy the URL above.");
  });
}

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

  const keys = JSON.parse(fs.readFileSync(OAUTH_PATH, "utf-8"));
  const clientKeys = keys.installed || keys.web;

  // Start a local HTTP server on a random available port to receive the callback.
  // Port 0 lets the OS assign a free port; we read it back after listen().
  const httpServer = createServer();
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address();
  const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

  const oAuth2Client = new google.auth.OAuth2(
    clientKeys.client_id,
    clientKeys.client_secret,
    redirectUri
  );

  // Generate a cryptographically random state value (64 hex chars = 256 bits).
  // This is tied to this specific auth session and verified on the callback.
  const state = randomBytes(32).toString("hex");

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,             // CSRF protection — Google echoes this back on redirect
  });

  console.log("Launching authentication flow...");
  console.log("A browser window will open. Sign in with your Google account");
  console.log("and click Allow when prompted.\n");
  console.log(`If your browser does not open automatically, visit:\n${authUrl}\n`);

  openBrowser(authUrl);

  // Wait for Google to redirect to our local server with ?code=...&state=...
  const authCode = await new Promise((resolve, reject) => {
    // Abort if the user does not complete auth within 5 minutes
    const timeout = setTimeout(() => {
      httpServer.close();
      reject(new Error("Authentication timed out (5 minutes). Please run auth again."));
    }, 5 * 60 * 1000);

    httpServer.on("request", (req, res) => {
      try {
        const reqUrl = new NodeURL(req.url, `http://127.0.0.1:${port}`);

        if (reqUrl.pathname !== "/oauth2callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const returnedState = reqUrl.searchParams.get("state");
        const error         = reqUrl.searchParams.get("error");
        const code          = reqUrl.searchParams.get("code");

        // Google returned an error (e.g. user denied access)
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h2>Authentication failed: ${error}</h2><p>You may close this window.</p>`);
          clearTimeout(timeout);
          httpServer.close();
          reject(new Error(`Google OAuth error: ${error}`));
          return;
        }

        // State mismatch — abort immediately, do not exchange the code
        if (!returnedState || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            `<h2>Security check failed</h2>` +
            `<p>State parameter mismatch — possible CSRF attack. Authentication aborted.</p>` +
            `<p>You may close this window.</p>`
          );
          clearTimeout(timeout);
          httpServer.close();
          reject(new Error("OAuth state mismatch — possible CSRF attack. Authentication aborted."));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h2>No authorization code received</h2><p>You may close this window and try again.</p>`);
          clearTimeout(timeout);
          httpServer.close();
          reject(new Error("No authorization code received from Google."));
          return;
        }

        // State verified, code received — send success page and proceed
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem">` +
          `<h2>&#x2705; Authentication successful!</h2>` +
          `<p>You may close this window and return to the terminal.</p>` +
          `</body></html>`
        );
        clearTimeout(timeout);
        httpServer.close();
        resolve(code);
      } catch (e) {
        clearTimeout(timeout);
        httpServer.close();
        reject(e);
      }
    });
  });

  // Exchange the authorization code for access + refresh tokens
  const { tokens } = await oAuth2Client.getToken(authCode);
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(tokens, null, 2));

  console.log("\n============================================================");
  console.log("  AUTHENTICATION SUCCESSFUL!");
  console.log("============================================================\n");
  console.log(`Credentials saved to: ${CREDENTIALS_PATH}`);
  console.log("\nPlease restart Claude Desktop for changes to take effect.");
  console.log("Right-click the Claude icon in your system tray");
  console.log("and select Quit, then reopen it.\n");
}

runAuth().catch((err) => {
  console.error(`\nERROR: Authentication failed: ${err.message}`);
  console.error("Please run auth again.");
  process.exit(1);
});
