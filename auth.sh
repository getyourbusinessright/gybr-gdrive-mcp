#!/bin/bash

echo ""
echo "============================================================"
echo "  GYBR Google Drive MCP Server - Authentication (Mac)"
echo "  Get Your Business Right LLC"
echo "============================================================"
echo ""
echo "This will open a browser window to authenticate"
echo "your Google account with Claude Desktop."
echo ""
echo "This is needed:"
echo "  - During first time setup on a new machine"
echo "  - If your Drive access stops working"
echo "  - After a long period of inactivity"
echo ""
read -p "Press Enter to continue..."

OAUTH_PATH="$HOME/gcp-oauth.keys.json"
CREDS_PATH="$HOME/.gdrive-server-credentials.json"
SERVER_DIR="$HOME/gdrive-mcp-server-v4"

if [ ! -f "$SERVER_DIR/auth.js" ]; then
    echo ""
    echo "ERROR: Server not installed yet."
    echo "Please run install.sh first."
    echo ""
    exit 1
fi

if [ ! -f "$OAUTH_PATH" ]; then
    echo ""
    echo "ERROR: gcp-oauth.keys.json not found in $HOME/"
    echo ""
    echo "Please make sure gcp-oauth.keys.json is in:"
    echo "$HOME/"
    echo ""
    exit 1
fi

echo ""
echo "Starting authentication..."
echo ""

GDRIVE_OAUTH_PATH="$OAUTH_PATH" \
GDRIVE_CREDENTIALS_PATH="$CREDS_PATH" \
node "$SERVER_DIR/auth.js"
