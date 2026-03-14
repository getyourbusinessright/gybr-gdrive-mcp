#!/bin/bash

echo ""
echo "============================================================"
echo "  GYBR Google Drive MCP Server - Mac Installer"
echo "  Version 4.1 - Governance Edition"
echo "  Get Your Business Right LLC"
echo "============================================================"
echo ""

# ── Check Node.js ─────────────────────────────────────────────
echo "[1/6] Checking Node.js installation..."
if ! command -v node &> /dev/null; then
    echo ""
    echo "ERROR: Node.js is not installed."
    echo ""
    echo "Please install Node.js first:"
    echo "1. Go to https://nodejs.org"
    echo "2. Download the LTS version"
    echo "3. Run the installer"
    echo "4. Restart your terminal"
    echo "5. Run this installer again"
    echo ""
    open "https://nodejs.org"
    exit 1
fi
echo "   Node.js found! $(node --version)"

# ── Check Claude Desktop ──────────────────────────────────────
echo "[2/6] Checking Claude Desktop..."
CLAUDE_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [ ! -f "$CLAUDE_CONFIG" ]; then
    echo ""
    echo "ERROR: Claude Desktop config not found."
    echo ""
    echo "Please install Claude Desktop first:"
    echo "1. Go to https://claude.ai/download"
    echo "2. Download and install Claude Desktop"
    echo "3. Open it at least once"
    echo "4. Run this installer again"
    echo ""
    open "https://claude.ai/download"
    exit 1
fi
echo "   Claude Desktop found!"

# ── Create server folder ──────────────────────────────────────
echo "[3/6] Creating server folder..."
SERVER_DIR="$HOME/gdrive-mcp-server-v4"
if [ -d "$SERVER_DIR" ]; then
    echo "   Folder already exists - updating files..."
else
    mkdir -p "$SERVER_DIR"
    echo "   Created: $SERVER_DIR"
fi

# ── Download files from GitHub ────────────────────────────────
echo "[4/6] Downloading server files from GitHub..."
GITHUB_RAW="https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main"

curl -s -o "$SERVER_DIR/index.js" "$GITHUB_RAW/index.js" || { echo "ERROR: Download failed. Check your internet connection."; exit 1; }
curl -s -o "$SERVER_DIR/auth.js" "$GITHUB_RAW/auth.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/docx-builder.js" "$GITHUB_RAW/docx-builder.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/xlsx-builder.js" "$GITHUB_RAW/xlsx-builder.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/package.json" "$GITHUB_RAW/package.json" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/gybr-mcp-config.json" "$GITHUB_RAW/gybr-mcp-config.json" || { echo "ERROR: Download failed."; exit 1; }

echo "   All files downloaded!"

# ── Install dependencies ──────────────────────────────────────
echo "[5/6] Installing dependencies (this may take a minute)..."
cd "$SERVER_DIR"
npm install --silent
if [ $? -ne 0 ]; then
    echo ""
    echo "ERROR: npm install failed."
    echo "Please try running this installer again."
    exit 1
fi
echo "   Dependencies installed!"

# ── Update Claude Desktop config ─────────────────────────────
echo "[6/6] Updating Claude Desktop configuration..."

SERVER_PATH="$SERVER_DIR/index.js"
CREDS_PATH="$HOME/.gdrive-server-credentials.json"

cat > "$CLAUDE_CONFIG" << EOF
{
  "mcpServers": {
    "gdrive": {
      "command": "node",
      "args": ["$SERVER_PATH"],
      "env": {
        "GDRIVE_CREDENTIALS_PATH": "$CREDS_PATH"
      }
    }
  },
  "preferences": {
    "coworkScheduledTasksEnabled": false,
    "ccdScheduledTasksEnabled": true,
    "coworkWebSearchEnabled": true
  }
}
EOF

echo "   Claude Desktop configured!"

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "============================================================"
echo "  INSTALLATION COMPLETE!"
echo "============================================================"
echo ""
echo "Next steps:"
echo ""
echo "STEP 1: Copy your credentials files to your home folder:"
echo "        $HOME/"
echo ""
echo "        You need these 2 files:"
echo "        - gcp-oauth.keys.json"
echo "        - .gdrive-server-credentials.json"
echo ""
echo "STEP 2: Restart Claude Desktop"
echo "        Quit Claude Desktop from the menu bar"
echo "        then reopen it."
echo ""
echo "STEP 3: In a new Claude Desktop chat, type:"
echo "        setup_ai_workspace"
echo ""
echo "============================================================"
echo ""

# Open home folder so user can drop in credentials
open "$HOME"
