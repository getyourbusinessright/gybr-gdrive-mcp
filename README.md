# GYBR Google Drive MCP Server
### A Windows-compatible Google Drive MCP server with full read/write access, built-in governance, action logging, draft mode, and auto-backup. Built by GYBR for Claude Desktop.

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

## Requirements
- Windows 10/11
- Node.js (LTS) — https://nodejs.org
- Claude Desktop — https://claude.ai/download
- Google Account

## Installation
1. Download `install.bat` from this repo
2. Double-click it
3. Follow the on-screen instructions

## Updating
1. Download `update.bat` from this repo
2. Double-click it
3. Restart Claude Desktop

## Re-Authentication
If your Google Drive access stops working:
1. Download `auth.bat` from this repo
2. Double-click it
3. Sign in with Google in the browser that opens

## Built By
[Get Your Business Right LLC (GYBR)](https://getyourbusinessright.com)
