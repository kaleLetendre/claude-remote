#!/bin/bash
# Relay Claude Code hook events to Claude Remote server.
# Called by Claude Code hooks with: claude-hook-relay.sh <hook_type>
# Hook JSON is passed on stdin. Env vars from pty: CLAUDE_REMOTE_SESSION_ID, CLAUDE_REMOTE_PORT.

[ -z "$CLAUDE_REMOTE_SESSION_ID" ] && exit 0

curl -s -X POST "http://localhost:${CLAUDE_REMOTE_PORT:-3033}/api/hooks/event" \
  -H "Content-Type: application/json" \
  -d "{\"hookType\":\"$1\",\"sessionId\":\"$CLAUDE_REMOTE_SESSION_ID\",\"data\":$(cat)}" \
  --max-time 2 >/dev/null 2>&1
