#!/bin/bash
# PreToolUse hook for Claude Code. Consults Claude Remote's server to decide
# whether to auto-approve the tool call. Prints Claude Code's hook decision
# JSON on stdout so the TUI never draws a permission prompt.
#
# If CLAUDE_REMOTE_SESSION_ID is unset (not inside a Claude Remote pty),
# or the server doesn't respond quickly, prints {} (no decision) and falls
# through to Claude Code's normal permission logic.

if [ -z "$CLAUDE_REMOTE_SESSION_ID" ]; then
  echo '{}'
  exit 0
fi

PORT="${CLAUDE_REMOTE_PORT:-3033}"

# Hook payload on stdin is discarded — server only needs the session ID.
# Drain stdin so Claude Code doesn't block writing to us.
cat >/dev/null 2>&1

RESP=$(curl -s -X POST "http://localhost:${PORT}/api/hooks/preauth" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$CLAUDE_REMOTE_SESSION_ID\"}" \
  --max-time 1 2>/dev/null)

if [ -z "$RESP" ]; then
  echo '{}'
else
  echo "$RESP"
fi
