#!/bin/bash
# ══════════════════════════════════════════════════════
#   Lavora Clinic — Google Setup (minimal scopes)
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
echo "Opening Google login in your browser..."
echo "Sign in and click Allow."
echo ""

# Only request Sheets + Calendar + Drive (no cloud-platform → avoids blocked error)
"$GCLOUD" auth application-default login \
  --scopes="https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/drive"

echo ""
echo "Running automated setup..."
echo ""

"$NODE" "$SCRIPT_DIR/scripts/google-autosetup.js"
