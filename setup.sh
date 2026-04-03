#!/usr/bin/env bash
# Legacy setup script — use ./cli.js setup instead.
# This script is kept for backwards compatibility.

set -e

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║    Claude Remote — Setup                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  The recommended setup method is now:"
echo ""
echo "    ./cli.js setup"
echo ""
echo "  It handles dependencies, Tailscale, auth,"
echo "  password setup, and offers to start the server."
echo ""

read -p "Run ./cli.js setup now? [Y/n] " answer
if [ "${answer,,}" != "n" ]; then
  exec ./cli.js setup
else
  echo ""
  echo "  To set up manually:"
  echo "    1. cd server && npm install"
  echo "    2. ./run.sh start"
  echo ""
fi
