#!/bin/bash

echo ""
echo "============================================================"
echo "  GYBR Google Drive MCP Server - Updater (Mac)"
echo "  Get Your Business Right LLC"
echo "============================================================"
echo ""

SERVER_DIR="$HOME/gdrive-mcp-server-v4"
GITHUB_RAW="https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main"

if [ ! -d "$SERVER_DIR" ]; then
    echo "ERROR: Server not installed yet."
    echo "Please run install.sh first."
    exit 1
fi

echo "Downloading latest files from GitHub..."
echo ""

curl -s -o "$SERVER_DIR/index.js" "$GITHUB_RAW/index.js" || { echo "ERROR: Download failed. Check your internet connection."; exit 1; }
curl -s -o "$SERVER_DIR/auth.js" "$GITHUB_RAW/auth.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/docx-builder.js" "$GITHUB_RAW/docx-builder.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/xlsx-builder.js" "$GITHUB_RAW/xlsx-builder.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/package.json" "$GITHUB_RAW/package.json" || { echo "ERROR: Download failed."; exit 1; }

echo "   Files updated!"
echo ""
echo "Installing any new dependencies..."
cd "$SERVER_DIR"
npm install --silent
echo "   Done!"
echo ""
echo "============================================================"
echo "  UPDATE COMPLETE!"
echo "============================================================"
echo ""
echo "Please restart Claude Desktop for changes to take effect."
echo "Quit Claude Desktop from the menu bar, then reopen it."
echo ""
