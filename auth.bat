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

set GYBR_DIR=%USERPROFILE%\gybr-mcp
if not exist "%GYBR_DIR%" mkdir "%GYBR_DIR%"

set OAUTH_PATH=%GYBR_DIR%\gcp-oauth.keys.json
set CREDS_PATH=%GYBR_DIR%\.gdrive-server-credentials.json
set SERVER_DIR=%USERPROFILE%\gdrive-mcp-server-v5

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
    echo Please place gcp-oauth.keys.json in:
    echo %GYBR_DIR%\
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
