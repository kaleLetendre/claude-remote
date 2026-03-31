#!/usr/bin/env bash
set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    ⌘  Claude Remote — Setup              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Server dependencies ──────────────────────────
echo "▸ Installing server dependencies..."
cd server
npm install
cd ..

# ── Client / Capacitor ───────────────────────────
echo ""
echo "▸ Installing client dependencies..."
cd client
npm install

# ── Add Android platform ─────────────────────────
if [ ! -d "android" ]; then
  echo ""
  echo "▸ Adding Android platform..."
  npx cap add android
fi

echo ""
echo "▸ Syncing web assets to Android..."
npx cap sync android

cd ..

echo ""
echo "════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  1. Start the server:"
echo "     cd server && npm start"
echo ""
echo "  2. Option A — Open in browser on phone:"
echo "     Use the URL printed by the server"
echo ""
echo "  2. Option B — Build the Android app:"
echo "     cd client"
echo "     # Edit capacitor.config.ts → set server.url to your LAN IP"
echo "     npx cap sync android"
echo "     npx cap open android    # Opens Android Studio"
echo "     # Build & run from Android Studio"
echo ""
echo "  2. Option C — Run directly on connected device:"
echo "     cd client && npx cap run android"
echo "════════════════════════════════════════════"
echo ""
