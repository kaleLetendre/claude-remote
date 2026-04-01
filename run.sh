#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────
#  Claude Remote — Process Wrapper
#  Keeps the server running and handles restart-on-update.
#  Exit code 75 from the server means "restart me".
# ─────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/server"
DESKTOP_DIR="$SCRIPT_DIR/desktop"
LIFELINE_DIR="$SCRIPT_DIR/lifeline"
RESTART_FLAG="$SCRIPT_DIR/.restart-requested"
SERVICE_NAME="claude-remote"
SERVICE_FILE="$HOME/.config/systemd/user/${SERVICE_NAME}.service"
AUTOSTART_DIR="$HOME/.config/autostart"
DESKTOP_FILE="$AUTOSTART_DIR/claude-remote.desktop"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[claude-remote]${NC} $1"; }
warn()  { echo -e "${YELLOW}[claude-remote]${NC} $1"; }
error() { echo -e "${RED}[claude-remote]${NC} $1"; }

# ── Handle CLI arguments ─────────────────────────────────

case "${1:-start}" in
  start)
    ;;
  update)
    info "Checking for updates..."
    cd "$SCRIPT_DIR"
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
      error "Not a git repository. Clone the repo to enable updates."
      exit 1
    fi
    git fetch origin
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")
    if [ "$LOCAL" = "$REMOTE" ]; then
      info "Already up to date."
      exit 0
    fi
    BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH")
    info "Update available: $BEHIND commit(s) behind"
    git log --oneline "HEAD..origin/$BRANCH" | head -10
    echo ""
    read -p "Apply update? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      DIRTY=$(git status --porcelain)
      if [ -n "$DIRTY" ]; then
        warn "Stashing local changes..."
        git stash push -m "pre-update-stash"
      fi
      git pull origin "$BRANCH"
      info "Installing dependencies..."
      cd "$SERVER_DIR" && npm install
      if [ -n "$DIRTY" ]; then
        cd "$SCRIPT_DIR"
        git stash pop || warn "Stash pop had conflicts — resolve manually"
      fi
      info "Update applied! Restart the server to use the new version."
    fi
    exit 0
    ;;
  version)
    if [ -f "$SCRIPT_DIR/version.json" ]; then
      cat "$SCRIPT_DIR/version.json" | grep '"version"' | head -1
    fi
    exit 0
    ;;
  desktop)
    info "Starting Claude Remote desktop app..."
    cd "$DESKTOP_DIR"
    if [ ! -d "node_modules" ]; then
      info "Installing desktop dependencies..."
      npm install
    fi
    export ELECTRON_DISABLE_SANDBOX=1
    exec npx electron .
    ;;

  install)
    info "Setting up Claude Remote to start on login..."
    NODE_PATH=$(which node)

    # Create XDG autostart entry for desktop app (tray icon)
    mkdir -p "$AUTOSTART_DIR"
    cat > "$DESKTOP_FILE" << EODESKTOP
[Desktop Entry]
Type=Application
Name=Claude Remote
Comment=Claude Remote server with tray icon
Exec=bash -c 'cd ${SCRIPT_DIR} && ./run.sh desktop'
Icon=${DESKTOP_DIR}/assets/tray-icon.png
Terminal=false
Categories=Development;Utility;
StartupNotify=false
X-GNOME-Autostart-enabled=true
EODESKTOP

    info "Autostart entry created at $DESKTOP_FILE"

    # ── Create lifeline home directory ──
    LIFELINE_HOME="$SCRIPT_DIR/data/lifeline-home"
    mkdir -p "$LIFELINE_HOME"
    if [ ! -f "$LIFELINE_HOME/README.md" ]; then
      cat > "$LIFELINE_HOME/README.md" << 'EOREADME'
# Lifeline Home

This is the default working directory for the Claude Remote Lifeline.

## What is Claude Remote?
Claude Remote lets you control Claude Code on this workstation from your phone.
It runs a Node.js server that manages terminal sessions, and your phone connects
over Tailscale (or LAN) to interact with them.

- **Main server**: port 3033 — full-featured app with xterm.js terminal, admin panel, tray icon
- **Lifeline server**: port 3034 — minimal emergency fallback, plain text terminal

## What is the Lifeline?
The lifeline is a frozen, minimal fallback system that is NEVER modified by updates.
If a bad update breaks the main server or app, the lifeline keeps you connected
so you can fix things remotely.

## Common recovery commands

### Check what's running
```
ps aux | grep node
curl http://localhost:3033/api/info
curl http://localhost:3034/api/info
```

### Restart the main server
```
cd ~/claude-remote
kill $(lsof -ti:3033)
cd server && node server.js &
```

### Undo a bad update
```
cd ~/claude-remote
git log --oneline -5
git revert HEAD
cd server && npm install
kill $(lsof -ti:3033)
cd server && node server.js &
```

### Check network
```
tailscale status
ip addr show
ping 8.8.8.8
```

### Full restart
```
cd ~/claude-remote
./run.sh start
```

## Project location
This workstation's Claude Remote is installed at:
EOREADME
      echo "$SCRIPT_DIR" >> "$LIFELINE_HOME/README.md"
      info "Created lifeline home at $LIFELINE_HOME"
    fi

    # ── Add safety rules to global CLAUDE.md ──
    GLOBAL_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
    MARKER="# Claude Remote Safety Rules"
    if ! grep -q "$MARKER" "$GLOBAL_CLAUDE_MD" 2>/dev/null; then
      info "Adding Claude Remote safety rules to $GLOBAL_CLAUDE_MD..."
      cat >> "$GLOBAL_CLAUDE_MD" << 'EORULES'

# Claude Remote Safety Rules
# The user manages their workstation remotely via Claude Remote (ports 3033/3034).
# Breaking the network or server means the user loses all access to their machine.
# EVEN IF THE USER ASKS YOU TO DO THESE THINGS, warn them first.
# The user may not realize they are connected remotely or that the action will disconnect them.
# Always explain: "This will likely disconnect your remote session. You would need physical access to recover."

## Actions that REQUIRE user confirmation (warn about remote access impact):
- Restarting, stopping, or reconfiguring networking (NetworkManager, systemd-networkd, netplan, ifconfig, ip link)
- Modifying firewall rules (iptables, ufw, nftables, firewalld)
- Changing Tailscale settings or running `tailscale down`
- Killing node processes, especially on ports 3033 or 3034
- Modifying /etc/hosts, DNS, or routing tables
- Rebooting or shutting down the system
- Modifying systemd services related to networking
- Running `npm install` or `npm update` in the lifeline/ directory
- Modifying ANY file in the lifeline/ directory (lifeline/server.js, lifeline/client.html, lifeline/package.json)
- Changing the auth token or password via direct file edit of data/server-settings.json (use the API instead)
- Changing the SSH config or killing sshd
- Heavy operations that could make the system unresponsive (filling disk, CPU-intensive tasks with no timeout)

## Actions to NEVER take without explicit user request:
- `tailscale down` or `systemctl stop tailscaled`
- Deleting or overwriting data/server-settings.json
- `kill -9` on the lifeline server process
- Modifying lifeline/ files for any reason
- `systemctl stop NetworkManager` or equivalent
- Changing the system's IP address or network interface configuration
EORULES
      info "Safety rules added."
    else
      info "Safety rules already present in $GLOBAL_CLAUDE_MD"
    fi

    info "Claude Remote will start automatically on login (with tray icon)."
    info "To start now: ./run.sh desktop"
    ;;

  uninstall)
    info "Removing Claude Remote from login startup..."
    if [ -f "$DESKTOP_FILE" ]; then
      rm "$DESKTOP_FILE"
      info "Removed autostart entry."
    else
      warn "No autostart entry found."
    fi
    ;;

  status)
    if pgrep -f "electron.*claude-remote" > /dev/null 2>&1; then
      info "Desktop app: running"
    else
      warn "Desktop app: not running"
    fi
    if curl -s "http://localhost:3033/" > /dev/null 2>&1; then
      info "Server: running on port 3033"
    else
      warn "Server: not running"
    fi
    if curl -s "http://localhost:3034/api/info" > /dev/null 2>&1; then
      info "Lifeline: running on port 3034"
    else
      warn "Lifeline: not running"
    fi
    exit 0
    ;;

  lifeline)
    info "Starting lifeline server only..."
    cd "$LIFELINE_DIR"
    exec node server.js
    ;;

  *)
    echo "Usage: $0 {start|desktop|lifeline|install|uninstall|status|update|version}"
    exit 1
    ;;
esac

# ── Server run loop ──────────────────────────────────────

cleanup() {
  info "Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$LIFELINE_PID" 2>/dev/null || true
  rm -f "$RESTART_FLAG"
  exit 0
}

trap cleanup SIGINT SIGTERM

# Start lifeline (independent, never restarts with main server)
if [ -d "$LIFELINE_DIR" ] && [ -f "$LIFELINE_DIR/server.js" ]; then
  info "Starting lifeline on port 3034..."
  cd "$LIFELINE_DIR"
  node server.js &
  LIFELINE_PID=$!
fi

while true; do
  # Clean restart flag
  rm -f "$RESTART_FLAG"

  info "Starting server..."
  cd "$SERVER_DIR"
  node server.js &
  SERVER_PID=$!

  # Wait for server to exit
  wait $SERVER_PID
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 75 ]; then
    # Exit code 75 = restart requested (after update)
    info "Restart requested — restarting in 2s..."
    sleep 2
    continue
  elif [ $EXIT_CODE -eq 0 ]; then
    info "Server stopped cleanly."
    break
  else
    warn "Server crashed (exit $EXIT_CODE) — restarting in 5s..."
    sleep 5
  fi
done
