@echo off
setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo   GYBR Google Drive MCP Server - Re-Authentication
echo   Get Your Business Right LLC
echo ============================================================
echo.
echo This will open a browser window to re-authenticate
echo your Google account with Claude Desktop.
echo.
echo This is needed if:
echo   - Your Drive access stopped working
echo   - It has been a long time since last auth
echo   - You are setting up on a new machine
echo.
pause

set OAUTH_PATH=%USERPROFILE%\gcp-oauth.keys.json
set CREDS_PATH=%USERPROFILE%\.gdrive-server-credentials.json
set SERVER_DIR=%USERPROFILE%\gdrive-mcp-server-v4

:: Check credentials file exists
if not exist "%OAUTH_PATH%" (
    echo.
    echo ERROR: gcp-oauth.keys.json not found in %USERPROFILE%\
    echo.
    echo Please make sure your gcp-oauth.keys.json file is in:
    echo %USERPROFILE%\
    echo.
    pause
    exit /b 1
)

echo.
echo Starting authentication flow...
echo A browser window will open. Sign in with your Google account
echo and click Allow when prompted.
echo.

set GDRIVE_OAUTH_PATH=%OAUTH_PATH%
set GDRIVE_CREDENTIALS_PATH=%CREDS_PATH%

node "%APPDATA%\npm\node_modules\@modelcontextprotocol\server-gdrive\dist\index.js" auth

if %errorlevel% equ 0 (
    echo.
    echo ============================================================
    echo   AUTHENTICATION SUCCESSFUL!
    echo ============================================================
    echo.
    echo Please restart Claude Desktop for changes to take effect.
    echo Right-click the Claude icon in your system tray
    echo and select Quit, then reopen it.
    echo.
) else (
    echo.
    echo Authentication may have failed.
    echo Please try running this file again.
    echo.
)

pause
