@echo off
setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo   GYBR Google Drive MCP Server - Windows Installer
echo   Version 5.1 - Governance Edition
echo   Get Your Business Right LLC
echo ============================================================
echo.

:: ── Check Node.js ────────────────────────────────────────────
echo [1/7] Checking Node.js installation...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Node.js is not installed.
    echo.
    echo Please install Node.js first:
    echo 1. Go to https://nodejs.org
    echo 2. Download the LTS version
    echo 3. Run the installer
    echo 4. Restart your computer
    echo 5. Run this installer again
    echo.
    start https://nodejs.org
    pause
    exit /b 1
)
echo    Node.js found!

:: ── Check Claude Desktop ──────────────────────────────────────
echo [2/7] Checking Claude Desktop...
set CLAUDE_CONFIG=%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
if not exist "%CLAUDE_CONFIG%" (
    echo.
    echo ERROR: Claude Desktop config not found.
    echo.
    echo Please install Claude Desktop first:
    echo 1. Go to https://claude.ai/download
    echo 2. Download and install Claude Desktop
    echo 3. Open it at least once
    echo 4. Run this installer again
    echo.
    start https://claude.ai/download
    pause
    exit /b 1
)
echo    Claude Desktop found!

:: ── Create GYBR data folder ──────────────────────────────────
echo [3/7] Creating GYBR data folder...
set GYBR_DIR=%USERPROFILE%\gybr-mcp
if not exist "%GYBR_DIR%" mkdir "%GYBR_DIR%"
echo    GYBR data folder: %GYBR_DIR%

:: ── Create server folder ──────────────────────────────────────
echo [4/7] Creating server folder...
set SERVER_DIR=%USERPROFILE%\gdrive-mcp-server-v5
if exist "%SERVER_DIR%" (
    echo    Folder already exists - updating files...
) else (
    mkdir "%SERVER_DIR%"
    echo    Created: %SERVER_DIR%
)

:: ── Download files from GitHub ────────────────────────────────
echo [5/7] Downloading server files from GitHub...
set GITHUB_RAW=https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main

curl --ssl-no-revoke -s -o "%SERVER_DIR%\index.js" "%GITHUB_RAW%/index.js"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\auth.js" "%GITHUB_RAW%/auth.js"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\docx-builder.js" "%GITHUB_RAW%/docx-builder.js"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\xlsx-builder.js" "%GITHUB_RAW%/xlsx-builder.js"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\package.json" "%GITHUB_RAW%/package.json"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\gybr-mcp-config.json" "%GITHUB_RAW%/gybr-mcp-config.json"
if %errorlevel% neq 0 goto download_error

echo    All files downloaded!
goto install_deps

:download_error
echo.
echo ERROR: Could not download files from GitHub.
echo Please check your internet connection and try again.
pause
exit /b 1

:: ── Install dependencies ──────────────────────────────────────
:install_deps
echo [6/7] Installing dependencies (this may take a minute)...
cd /d "%SERVER_DIR%"
call npm install --silent
if %errorlevel% neq 0 (
    echo.
    echo ERROR: npm install failed.
    echo Please run this installer as Administrator and try again.
    pause
    exit /b 1
)
echo    Dependencies installed!

:: ── Update Claude Desktop config ─────────────────────────────
echo [7/7] Updating Claude Desktop configuration...

set SERVER_PATH=%SERVER_DIR%\index.js
set CREDS_PATH=%GYBR_DIR%\.gdrive-server-credentials.json

set SERVER_PATH_JSON=%SERVER_PATH:\=\\%
set CREDS_PATH_JSON=%CREDS_PATH:\=\\%

(
echo {
echo   "mcpServers": {
echo     "gdrive": {
echo       "command": "node",
echo       "args": ["%SERVER_PATH_JSON%"],
echo       "env": {
echo         "GDRIVE_CREDENTIALS_PATH": "%CREDS_PATH_JSON%"
echo       }
echo     }
echo   },
echo   "preferences": {
echo     "coworkScheduledTasksEnabled": false,
echo     "ccdScheduledTasksEnabled": true,
echo     "coworkWebSearchEnabled": true
echo   }
echo }
) > "%CLAUDE_CONFIG%"

echo    Claude Desktop configured!

:: ── Done ─────────────────────────────────────────────────────
echo.
echo ============================================================
echo   INSTALLATION COMPLETE!
echo ============================================================
echo.
echo Next steps:
echo.
echo STEP 1: Copy gcp-oauth.keys.json to the GYBR data folder:
echo         %GYBR_DIR%\
echo.
echo STEP 2: Run auth.bat to authenticate with Google
echo         A browser will open — sign in and click Allow
echo.
echo STEP 3: Restart Claude Desktop
echo         Right-click Claude in the system tray, select Quit,
echo         then reopen it.
echo.
echo STEP 4: In a new Claude Desktop chat, type:
echo         setup_ai_workspace
echo.
echo All MCP data files are stored in: %GYBR_DIR%
echo ============================================================
echo.

explorer "%GYBR_DIR%"

pause
