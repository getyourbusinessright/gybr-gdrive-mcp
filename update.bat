@echo off
setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo   GYBR Google Drive MCP Server - Updater
echo   Get Your Business Right LLC
echo ============================================================
echo.

set SERVER_DIR=%USERPROFILE%\gdrive-mcp-server-v4
set GITHUB_RAW=https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main

:: ── Check server folder exists ────────────────────────────────
if not exist "%SERVER_DIR%" (
    echo ERROR: Server not installed yet.
    echo Please run install.bat first.
    pause
    exit /b 1
)

echo Downloading latest files from GitHub...
echo.

curl --ssl-no-revoke -s -o "%SERVER_DIR%\index.js" "%GITHUB_RAW%/index.js"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\docx-builder.js" "%GITHUB_RAW%/docx-builder.js"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\xlsx-builder.js" "%GITHUB_RAW%/xlsx-builder.js"
if %errorlevel% neq 0 goto download_error

curl --ssl-no-revoke -s -o "%SERVER_DIR%\package.json" "%GITHUB_RAW%/package.json"
if %errorlevel% neq 0 goto download_error

echo    Files updated!
echo.
echo Installing any new dependencies...
cd /d "%SERVER_DIR%"
call npm install --silent
echo    Done!
echo.

echo ============================================================
echo   UPDATE COMPLETE!
echo ============================================================
echo.
echo Please restart Claude Desktop for changes to take effect.
echo Right-click the Claude icon in your system tray
echo and select Quit, then reopen it.
echo.
pause
goto end

:download_error
echo.
echo ERROR: Could not download files from GitHub.
echo Please check your internet connection and try again.
pause

:end
