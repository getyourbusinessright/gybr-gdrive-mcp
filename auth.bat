@echo off
setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo   GYBR Google Drive MCP Server - Authentication
echo   Get Your Business Right LLC
echo ============================================================
echo.
echo This will open a browser window to authenticate
echo your Google account with Claude Desktop.
echo.
echo This is needed:
echo   - During first time setup on a new machine
echo   - If your Drive access stops working
echo   - After a long period of inactivity
echo.
pause

set OAUTH_PATH=%USERPROFILE%\gcp-oauth.keys.json
set CREDS_PATH=%USERPROFILE%\.gdrive-server-credentials.json
set SERVER_DIR=%USERPROFILE%\gdrive-mcp-server-v4

:: Check server is installed
if not exist "%SERVER_DIR%\auth.js" (
    echo.
    echo ERROR: Server not installed yet.
    echo Please run install.bat first.
    echo.
    pause
    exit /b 1
)

:: Check OAuth keys file exists
if not exist "%OAUTH_PATH%" (
    echo.
    echo ERROR: gcp-oauth.keys.json not found.
    echo.
    echo Please make sure gcp-oauth.keys.json is in:
    echo %USERPROFILE%\
    echo.
    pause
    exit /b 1
)

echo.
echo Starting authentication...
echo.

set GDRIVE_OAUTH_PATH=%OAUTH_PATH%
set GDRIVE_CREDENTIALS_PATH=%CREDS_PATH%

node "%SERVER_DIR%\auth.js"

pause
