#!/bin/bash
# ══════════════════════════════════════════════════════
#   Lavora Clinic — One-Command Google Setup
#
#   HOW TO USE:
#   1. Open Terminal (Command + Space → "Terminal")
#   2. Run this command:
#        bash ~/Desktop/ai/lavora-backend/setup-google.sh
#   3. Your browser will open → sign in to Google → click Allow
#   4. The script does EVERYTHING else automatically:
#      ✅ Creates GCP project
#      ✅ Enables Sheets + Calendar APIs
#      ✅ Creates service account + downloads key
#      ✅ Creates Google Sheet with all 4 tabs
#      ✅ Creates Google Calendar
#      ✅ Shares both with the service account
#      ✅ Writes your .env file
# ══════════════════════════════════════════════════════

set -e

GCLOUD="$HOME/google-cloud-sdk/bin/gcloud"
NODE="$HOME/node20/bin/node"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║   Lavora Clinic — Google Setup                       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Check tools
if [ ! -f "$GCLOUD" ]; then
  echo "❌ gcloud not found at $GCLOUD"
  exit 1
fi
if [ ! -f "$NODE" ]; then
  echo "❌ node not found at $NODE"
  exit 1
fi

echo "Step 1/2 — Opening Google login in your browser..."
echo "         Sign in with your Google account and click Allow."
echo ""

# This opens the browser automatically and waits for auth
"$GCLOUD" auth application-default login \
  --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/drive"

echo ""
echo "Step 2/2 — Running automated Google setup..."
echo ""

"$NODE" "$SCRIPT_DIR/scripts/google-autosetup.js"
