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

    # ── Add safety rules to global CLAUDE.md ──
    GLOBAL_CLAUDE_MD="$HOME/.claude/CLAUDE.md"
    MARKER="# Claude Remote Safety Rules"
    if ! grep -q "$MARKER" "$GLOBAL_CLAUDE_MD" 2>/dev/null; then
      info "Adding Claude Remote safety rules to $GLOBAL_CLAUDE_MD..."
      cat >> "$GLOBAL_CLAUDE_MD" << 'EORULES'

# Claude Remote Safety Rules
# The user manages their workstation remotely via Claude Remote.
# Prod runs on port 3033 (~/claude-remote-prod), dev on port 3034 (~/claude-remote).
# Breaking the network or server means the user loses all access to their machine.
# EVEN IF THE USER ASKS YOU TO DO THESE THINGS, warn them first.
# The user may not realize they are connected remotely or that the action will disconnect them.
# Always explain: "This will likely disconnect your remote session. You would need physical access to recover."

## CRITICAL: NEVER kill the prod server on port 3033
- NEVER use `pkill -f 'node.*server'` or any broad pattern that could match the prod process
- NEVER kill the prod server unless the user EXPLICITLY asks for it
- The dev server (port 3034) is fine to kill/restart freely
- When killing processes, ALWAYS check what you're targeting won't hit prod

## Actions that REQUIRE user confirmation (warn about remote access impact):
- Restarting, stopping, or reconfiguring networking (NetworkManager, systemd-networkd, netplan, ifconfig, ip link)
- Modifying firewall rules (iptables, ufw, nftables, firewalld)
- Changing Tailscale settings or running `tailscale down`
- Modifying /etc/hosts, DNS, or routing tables
- Rebooting or shutting down the system
- Modifying systemd services related to networking
- Changing the auth token or password via direct file edit of data/server-settings.json (use the API instead)
- Changing the SSH config or killing sshd
- Heavy operations that could make the system unresponsive (filling disk, CPU-intensive tasks with no timeout)

## Actions to NEVER take without explicit user request:
- `tailscale down` or `systemctl stop tailscaled`
- Killing the prod server process (port 3033)
- Deleting or overwriting data/server-settings.json
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

  install-service)
    info "Installing Claude Remote as a system service (requires sudo)..."
    NODE_PATH=$(which node)
    if [ -z "$NODE_PATH" ]; then
      error "Node.js not found. Install it first."
      exit 1
    fi

    # Build the service file
    SERVICE_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
    info "Creating systemd service at $SERVICE_UNIT"
    sudo tee "$SERVICE_UNIT" > /dev/null << EOSERVICE
[Unit]
Description=Claude Remote Server (prod)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
Group=$(id -gn)
WorkingDirectory=${SCRIPT_DIR}/server
ExecStart=${NODE_PATH} server.js
Restart=always
RestartSec=5
# Exit code 75 = restart requested (update), treat as success so Restart=always kicks in
SuccessExitStatus=75
# Environment — inherit NVM node path and user HOME
Environment=HOME=${HOME}
Environment=NODE_ENV=production
Environment=CLAUDE_REMOTE_DATA=${SCRIPT_DIR}/data
Environment=PATH=${NODE_PATH%/*}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOSERVICE

    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    sudo systemctl start "$SERVICE_NAME"

    info "Service installed and started."
    info "The prod server is now protected by systemd."
    info ""
    info "Management commands (all require sudo):"
    info "  sudo systemctl status $SERVICE_NAME   # check status"
    info "  sudo systemctl restart $SERVICE_NAME  # restart"
    info "  sudo systemctl stop $SERVICE_NAME     # stop"
    info "  sudo journalctl -u $SERVICE_NAME -f   # view logs"
    exit 0
    ;;

  uninstall-service)
    info "Removing Claude Remote system service (requires sudo)..."
    SERVICE_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
    if [ ! -f "$SERVICE_UNIT" ]; then
      warn "No system service found at $SERVICE_UNIT"
      exit 1
    fi
    sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    sudo rm -f "$SERVICE_UNIT"
    sudo systemctl daemon-reload
    info "System service removed. You can run the server manually with ./run.sh start"
    exit 0
    ;;

  status)
    # Check systemd service
    SERVICE_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
    if [ -f "$SERVICE_UNIT" ]; then
      if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
        info "Systemd service: active (protected — requires sudo to stop)"
      else
        warn "Systemd service: installed but not running"
      fi
    fi
    # Check desktop app
    if pgrep -f "electron.*claude-remote" > /dev/null 2>&1; then
      info "Desktop app: running"
    else
      warn "Desktop app: not running"
    fi
    # Check server
    if curl -s "http://localhost:3033/" > /dev/null 2>&1; then
      info "Server: running on port 3033"
    else
      warn "Server: not running"
    fi
    exit 0
    ;;

  *)
    echo "Usage: $0 {start|desktop|install|uninstall|install-service|uninstall-service|status|update|version}"
    exit 1
    ;;
esac

# ── Server run loop ──────────────────────────────────────

cleanup() {
  info "Shutting down..."
  kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$RESTART_FLAG"
  exit 0
}

trap cleanup SIGINT SIGTERM

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
