# GYBR Google Drive MCP Server
### The only Windows and Mac compatible Google Drive MCP server with full read/write access, built-in governance, action logging, draft mode, and auto-backup. Built by GYBR for Claude Desktop.

## What This Does
Connects Claude Desktop directly to your Google Drive with full read/write access and enterprise-grade governance controls.

## Features
- ✅ Full read access across all of Google Drive including shared files
- ✅ Create Google Docs, Sheets, Slides, folders
- ✅ Upload real .docx, .xlsx, and .pdf files
- ✅ Edit existing files anywhere in Drive
- ✅ Draft mode ON by default — creates revision copies instead of editing originals
- ✅ Auto-backup to AI-Archive before any destructive edit
- ✅ Action log spreadsheet tracking every AI action
- ✅ AI_YYYYMMDD_ naming convention on all created files
- ✅ Delete protection with confirmation required
- ✅ Rate limiting — max 10 writes per minute, max 3 deletes per session
- ✅ Separate config file — change settings without touching code
- ✅ One-click Windows installer
- ✅ One-command Mac installer

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
⚠️ Windows users: When saving the downloaded JSON file, rename it to exactly:
gcp-oauth.keys.json
If using Notepad, make sure "Save as type" is set to "All Files" not "Text Documents" 
or the extension will be doubled.

## Windows Installation
1. Download `install.bat` from this repo
2. Double-click it — installs everything automatically
3. Copy `gcp-oauth.keys.json` to `C:\Users\YourName\`
4. Double-click `auth.bat` — sign in with Google in the browser
5. Restart Claude Desktop
6. In a new chat type: `setup_ai_workspace`

## Mac Installation
Open Terminal and run:
```
curl -s --output install.sh https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main/install.sh && chmod +x install.sh && bash install.sh
```
Then:
1. Copy `gcp-oauth.keys.json` to your home folder (`/Users/YourName/`)
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
After updating — restart Claude Desktop and you're done.

## Re-Authentication
If your Google Drive access stops working:

**Windows:** Download and double-click `auth.bat`

**Mac:** Run `auth.sh`

## Known Issues
- v4.2: Delete confirmation is handled conversationally by Claude rather than as a hard tool-level block. File is never deleted without user confirmation — hard block coming in v4.3.
- v4.2: Delete on uploaded .docx/.xlsx files sometimes fails — fix coming in v4.3.

## Built By
[Get Your Business Right LLC (GYBR)](https://getyourbusinessright.com)
