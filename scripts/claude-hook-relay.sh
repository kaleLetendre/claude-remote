#!/bin/bash
# Relay Claude Code hook events to all running Claude Remote server instances.
# Called by Claude Code hooks with: claude-hook-relay.sh <hook_type>
# Hook JSON is passed on stdin. CLAUDE_REMOTE_SESSION_ID comes from pty env.

HOOK_TYPE="$1"
HOOK_DATA=$(cat)
CR_SESSION="$CLAUDE_REMOTE_SESSION_ID"

# No session ID means this Claude Code instance wasn't spawned by Claude Remote
[ -z "$CR_SESSION" ] && exit 0

# Find all running instances via their connection-info files and POST to each
for f in "$HOME"/.claude-remote/connection-info.json \
         "$HOME"/claude-remote/data/connection-info.json \
         "$HOME"/claude-remote-prod/data/connection-info.json; do
  [ -f "$f" ] || continue
  PORT=$(grep -o '"port":[ ]*[0-9]*' "$f" | head -1 | grep -o '[0-9]*')
  [ -z "$PORT" ] && continue
  curl -s -X POST "http://localhost:$PORT/api/hooks/event" \
    -H "Content-Type: application/json" \
    -d "{\"hookType\":\"$HOOK_TYPE\",\"sessionId\":\"$CR_SESSION\",\"data\":$HOOK_DATA}" \
    --max-time 2 >/dev/null 2>&1 &
done
wait
