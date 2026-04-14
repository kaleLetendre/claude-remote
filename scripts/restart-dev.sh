#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  Restart the dev server (port 3034) reliably.
#  Safe to call from Claude Code sessions.
#  Will NOT touch prod (port 3033).
# ─────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
DEV_PORT=3034

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info()  { echo -e "${GREEN}[restart-dev]${NC} $1"; }
warn()  { echo -e "${YELLOW}[restart-dev]${NC} $1"; }

# ── Step 1: Kill existing dev processes ──────────────────
# Kill only the node server.js running on the dev port, not prod
DEV_PIDS=$(lsof -ti :$DEV_PORT 2>/dev/null || true)
if [ -n "$DEV_PIDS" ]; then
  info "Stopping dev server (port $DEV_PORT)..."
  echo "$DEV_PIDS" | xargs kill 2>/dev/null || true
  sleep 1
  # Force-kill stragglers
  REMAINING=$(lsof -ti :$DEV_PORT 2>/dev/null || true)
  if [ -n "$REMAINING" ]; then
    echo "$REMAINING" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
else
  info "No dev server running on port $DEV_PORT."
fi

# Also kill any orphaned run.sh wrappers for dev (not prod)
pkill -f "run\.sh.*start.*claude-remote[^-]" 2>/dev/null || true
pkill -f "run\.sh.*start$" --cwd "$SCRIPT_DIR" 2>/dev/null || true

# ── Step 2: Start fresh ─────────────────────────────────
info "Starting dev server..."
cd "$SCRIPT_DIR"
nohup ./run.sh start > /tmp/claude-remote-dev.log 2>&1 &
disown

# ── Step 3: Wait for it to come up ──────────────────────
for i in $(seq 1 10); do
  if curl -s -o /dev/null -w "" "http://localhost:$DEV_PORT/" 2>/dev/null; then
    info "Dev server is up on port $DEV_PORT."
    exit 0
  fi
  sleep 1
done

warn "Dev server didn't respond after 10s. Check /tmp/claude-remote-dev.log"
exit 1
