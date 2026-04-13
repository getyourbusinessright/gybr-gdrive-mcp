# GYBR Google Drive MCP Server
### The only Windows and Mac compatible Google Drive MCP server with full read/write access, built-in governance, action logging, draft mode, and auto-backup. Built by GYBR for Claude Desktop.

## What This Does
Connects Claude Desktop directly to your Google Drive with full read/write access and enterprise-grade governance controls.

## Features
✅ Full read access across all of Google Drive including shared files
✅ Create Google Docs, Sheets, Slides, folders
✅ Upload real .docx, .xlsx, and .pdf files
✅ Read .docx and .xlsx files directly from Drive
✅ Edit existing files anywhere in Drive
✅ Draft mode ON by default — creates revision copies instead of editing originals
✅ Auto-backup to AI-Archive before any destructive edit
✅ Action log spreadsheet tracking every AI action with before/after snapshots
✅ AI_YYYYMMDD_ naming convention on all created files
✅ Delete protection with confirmation required (soft delete / Google Trash only)
✅ Rate limiting — max 10 writes per minute, max 3 deletes per session
✅ Rate limit persists across server restarts
✅ Separate config file — change settings without touching code
✅ One-click Windows installer
✅ One command Mac installer
✅ All data files stored in a single dedicated 
✅ Tab visibility on every Google Sheet read — see all tabs before touching anything
✅ Read any specific tab by name
✅ Tab validation before every write — never writes to wrong tab
✅ Append rows without overwriting existing data
✅ Find columns by header name
✅ Insert content under specific Doc headings
✅ Create new tabs in sheets
✅ Duplicate detection before appending rows
✅ Doc read modes — full, summary, headings only, section
✅ Dry run mode — preview any destructive action before executing
✅ Ambiguity detection — never silently picks the wrong target
✅ Freshness check before writes — warns if file changed since last read
✅ Safe pagination for large files
✅ CSRF protection on OAuth flow

## Data Folder Location
All MCP data files are stored in a single dedicated folder:

| Platform | Path |
|----------|------|
| **Mac** | `~/gybr-mcp/` |
| **Windows** | `%USERPROFILE%\gybr-mcp\` |

The four files in this folder are:

| File | Purpose |
|------|---------|
| `gcp-oauth.keys.json` | Your Google OAuth client credentials |
| `.gdrive-server-credentials.json` | Stored access and refresh token |
| `.gdrive-mcp-workspace-cache.json` | AI workspace folder ID cache |
| `.gdrive-mcp-ratelimit.json` | Rate limit state (persists across restarts) |

**On first run the server automatically migrates any files found at the old `~/` location into `~/gybr-mcp/`.** No manual migration needed.

## Requirements
- Node.js (LTS) — https://nodejs.org
- Claude Desktop — https://claude.ai/download
- Google Account
- Google Cloud Console OAuth credentials (see setup guide below)

## Google Cloud Console Setup (One Time Only)
Before installing you need to create OAuth credentials:
1. Go to https://console.cloud.google.com
2. Create a new project called `Claude MCP`
3. Enable the Google Drive API, Google Docs API, Google Sheets API, and Google Slides API
4. Go to APIs & Services → Credentials → Configure consent screen
5. Set audience to External, add your email as a test user
6. Create OAuth 2.0 credentials → Desktop app
7. Download the JSON file and rename it to `gcp-oauth.keys.json`
8. Place it in your GYBR data folder:
   - **Mac:** `~/gybr-mcp/gcp-oauth.keys.json`
   - **Windows:** `%USERPROFILE%\gybr-mcp\gcp-oauth.keys.json`

## Windows Installation
1. Download `install.bat` from this repo
2. Double-click it — installs everything automatically
3. Copy `gcp-oauth.keys.json` to `%USERPROFILE%\gybr-mcp\`
4. Double-click `auth.bat` — sign in with Google in the browser
5. Restart Claude Desktop
6. In a new chat type: `setup_ai_workspace`

## Mac Installation
Open Terminal and run:
```
curl -s --output install.sh https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main/install.sh && chmod +x install.sh && bash install.sh
```
Then:
1. Copy `gcp-oauth.keys.json` to `~/gybr-mcp/`
2. Run `auth.sh` — sign in with Google in the browser
3. Restart Claude Desktop
4. In a new chat type: `setup_ai_workspace`

## Updating

Updates only replace server files — you do NOT need to re-authenticate after updating.

**Windows:** Download and double-click `update.bat`

**Mac:** Run in Terminal:
```
curl -s --output update.sh https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main/update.sh && chmod +x update.sh && bash update.sh
```
**After updating** — run `npm install` in the server folder to pick up any new dependencies (v5.1 adds mammoth for .docx reading), then restart Claude Desktop.

## Re-Authentication
If your Google Drive access stops working:

**Windows:** Download and double-click `auth.bat`

**Mac:** Run `auth.sh`

## Built By
[Get Your Business Right LLC (GYBR)](https://getyourbusinessright.com)
