#!/usr/bin/env bash
# Start SSH SOCKS5 tunnel + pproxy HTTP proxy + Claude Code in one shot.
#
# Usage:
#   ./start_claude_proxy.sh                  # launch claude interactively
#   ./start_claude_proxy.sh "fix the bug"    # pass prompt to claude
#
# Prerequisites:
#   pip install pproxy
#   SSH key configured for REMOTE_HOST

set -euo pipefail

# ── Configuration (override via environment) ─────────────────────────
REMOTE_HOST="${CLAUDE_SSH_HOST:-user@your-server}"
SOCKS_PORT="${CLAUDE_SOCKS_PORT:-9988}"
HTTP_PORT="${CLAUDE_HTTP_PORT:-9991}"
# ─────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[proxy]${NC} $*"; }
warn() { echo -e "${YELLOW}[proxy]${NC} $*"; }
err()  { echo -e "${RED}[proxy]${NC} $*" >&2; }

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    err "'$1' not found. Please install it first."
    [ -n "${2:-}" ] && err "  → $2"
    exit 1
  fi
}

port_listening() {
  if command -v ss &>/dev/null; then
    ss -tln 2>/dev/null | grep -q ":${1} "
  elif command -v lsof &>/dev/null; then
    lsof -iTCP:"$1" -sTCP:LISTEN -P -n &>/dev/null
  elif command -v netstat &>/dev/null; then
    netstat -tln 2>/dev/null | grep -q ":${1} "
  else
    return 1
  fi
}

cleanup() {
  if [ -n "${PPROXY_PID:-}" ] && kill -0 "$PPROXY_PID" 2>/dev/null; then
    log "Stopping pproxy (PID $PPROXY_PID)..."
    kill "$PPROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Preflight checks ────────────────────────────────────────────────
check_cmd ssh
check_cmd pproxy "pip install pproxy"
check_cmd claude "npm install -g @anthropic-ai/claude-code"

if [ "$REMOTE_HOST" = "user@your-server" ]; then
  warn "REMOTE_HOST not configured. Set CLAUDE_SSH_HOST or edit this script."
  warn "  export CLAUDE_SSH_HOST=user@your-server"
  exit 1
fi

# ── Step 1: SSH SOCKS5 tunnel ───────────────────────────────────────
if port_listening "$SOCKS_PORT"; then
  log "SSH tunnel already running on :$SOCKS_PORT"
else
  log "Starting SSH tunnel → $REMOTE_HOST (SOCKS5 :$SOCKS_PORT)..."
  ssh -D "$SOCKS_PORT" -N -f \
      -o ServerAliveInterval=60 \
      -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      "$REMOTE_HOST"
  sleep 1

  if ! port_listening "$SOCKS_PORT"; then
    err "SSH tunnel failed to start on :$SOCKS_PORT"
    exit 1
  fi
  log "SSH tunnel ready."
fi

# ── Step 2: pproxy (SOCKS5 → HTTP) ─────────────────────────────────
if port_listening "$HTTP_PORT"; then
  log "pproxy already running on :$HTTP_PORT"
else
  log "Starting pproxy (HTTP :$HTTP_PORT → SOCKS5 :$SOCKS_PORT)..."
  pproxy -l "http://127.0.0.1:$HTTP_PORT" -r "socks5://127.0.0.1:$SOCKS_PORT" -vv &
  PPROXY_PID=$!
  sleep 1

  if ! port_listening "$HTTP_PORT"; then
    err "pproxy failed to start on :$HTTP_PORT"
    exit 1
  fi
  log "pproxy ready (PID $PPROXY_PID)."
fi

# ── Step 3: Launch Claude Code ──────────────────────────────────────
export HTTPS_PROXY="http://127.0.0.1:$HTTP_PORT"
export HTTP_PROXY="http://127.0.0.1:$HTTP_PORT"

log "Proxy chain ready:"
log "  Claude Code → HTTP :$HTTP_PORT → SOCKS5 :$SOCKS_PORT → SSH $REMOTE_HOST → Internet"
echo ""

claude "$@"
