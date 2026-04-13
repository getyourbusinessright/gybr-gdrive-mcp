#!/bin/bash

echo ""
echo "============================================================"
echo "  GYBR Google Drive MCP Server - Mac Installer"
echo "  Version 5.1 - Governance Edition"
echo "  Get Your Business Right LLC"
echo "============================================================"
echo ""

# ── Check Node.js ─────────────────────────────────────────────
echo "[1/7] Checking Node.js installation..."
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
echo "[2/7] Checking Claude Desktop..."
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

# ── Create GYBR data folder ───────────────────────────────────
echo "[3/7] Creating GYBR data folder..."
GYBR_DIR="$HOME/gybr-mcp"
mkdir -p "$GYBR_DIR"
echo "   GYBR data folder: $GYBR_DIR"

# ── Create server folder ──────────────────────────────────────
echo "[4/7] Creating server folder..."
SERVER_DIR="$HOME/gdrive-mcp-server-v5"
if [ -d "$SERVER_DIR" ]; then
    echo "   Folder already exists - updating files..."
else
    mkdir -p "$SERVER_DIR"
    echo "   Created: $SERVER_DIR"
fi

# ── Download files from GitHub ────────────────────────────────
echo "[5/7] Downloading server files from GitHub..."
GITHUB_RAW="https://raw.githubusercontent.com/getyourbusinessright/gybr-gdrive-mcp/main"

curl -s -o "$SERVER_DIR/index.js" "$GITHUB_RAW/index.js" || { echo "ERROR: Download failed. Check your internet connection."; exit 1; }
curl -s -o "$SERVER_DIR/auth.js" "$GITHUB_RAW/auth.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/docx-builder.js" "$GITHUB_RAW/docx-builder.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/xlsx-builder.js" "$GITHUB_RAW/xlsx-builder.js" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/package.json" "$GITHUB_RAW/package.json" || { echo "ERROR: Download failed."; exit 1; }
curl -s -o "$SERVER_DIR/gybr-mcp-config.json" "$GITHUB_RAW/gybr-mcp-config.json" || { echo "ERROR: Download failed."; exit 1; }

echo "   All files downloaded!"

# ── Install dependencies ──────────────────────────────────────
echo "[6/7] Installing dependencies (this may take a minute)..."
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
echo "[7/7] Updating Claude Desktop configuration..."

SERVER_PATH="$SERVER_DIR/index.js"
CREDS_PATH="$GYBR_DIR/.gdrive-server-credentials.json"

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
echo "STEP 1: Copy gcp-oauth.keys.json to the GYBR data folder:"
echo "        $GYBR_DIR/"
echo ""
echo "STEP 2: Run auth.sh to sign in with Google"
echo "        A browser will open — click Allow"
echo ""
echo "STEP 3: Restart Claude Desktop"
echo "        Quit from the menu bar then reopen."
echo ""
echo "STEP 4: In a new Claude Desktop chat, type:"
echo "        setup_ai_workspace"
echo ""
echo "All MCP data files are stored in: $GYBR_DIR"
echo "============================================================"
echo ""

open "$GYBR_DIR"
