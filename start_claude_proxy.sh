#!/usr/bin/env bash
# Start pproxy (SOCKS5 -> HTTP) for Claude Code, with live logs.
#
# Usage:
#   ./start_claude_proxy.sh                                     # SOCKS5 :9988 -> HTTP :9991
#   CLAUDE_SOCKS_PORT=1080 ./start_claude_proxy.sh              # custom SOCKS port
#   CLAUDE_SSH_HOST="user@server" ./start_claude_proxy.sh       # also start SSH tunnel
#
# The script:
#   1. (Optional) Starts SSH SOCKS5 tunnel if CLAUDE_SSH_HOST is set
#   2. Syncs proxy settings into ~/.claude/settings.json and Cursor settings.json
#   3. Runs pproxy in foreground with -vv (Ctrl+C to stop)
#
# Prerequisites:
#   pip install pproxy
#   jq (for settings sync)
#   Mode SSH: SSH key configured for CLAUDE_SSH_HOST

set -euo pipefail

# ── Configuration (override via environment) ─────────────────────────
REMOTE_HOST="${CLAUDE_SSH_HOST:-}"
SOCKS_PORT="${CLAUDE_SOCKS_PORT:-9988}"
HTTP_PORT="${CLAUDE_HTTP_PORT:-9991}"
PROXY_URL="http://127.0.0.1:$HTTP_PORT"
# ─────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
MAGENTA='\033[0;35m'
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

# ── Sync ~/.claude/settings.json ────────────────────────────────────
sync_claude_cli() {
  local proxy_url="$1"
  local no_proxy="localhost,127.0.0.1"
  local settings_dir="$HOME/.claude"
  local settings_file="$settings_dir/settings.json"
  local label="~/.claude/settings.json"

  check_cmd jq "apt install jq / brew install jq"
  log "Checking $label ..."

  if [ ! -f "$settings_file" ]; then
    warn "  $label not found, creating..."
    mkdir -p "$settings_dir"
    cat > "$settings_file" <<EOJSON
{
  "env": {
    "HTTPS_PROXY": "$proxy_url",
    "HTTP_PROXY": "$proxy_url",
    "NO_PROXY": "$no_proxy"
  }
}
EOJSON
    log "  Created with proxy $proxy_url"
    return 0
  fi

  local cur_https cur_http cur_noproxy changed=false
  cur_https=$(jq -r '.env.HTTPS_PROXY // empty' "$settings_file" 2>/dev/null || true)
  cur_http=$(jq -r '.env.HTTP_PROXY // empty' "$settings_file" 2>/dev/null || true)
  cur_noproxy=$(jq -r '.env.NO_PROXY // empty' "$settings_file" 2>/dev/null || true)

  [ "$cur_https" != "$proxy_url" ]  && { warn "    HTTPS_PROXY: ${cur_https:-(not set)} -> $proxy_url"; changed=true; }
  [ "$cur_http" != "$proxy_url" ]   && { warn "    HTTP_PROXY: ${cur_http:-(not set)} -> $proxy_url"; changed=true; }
  [ "$cur_noproxy" != "$no_proxy" ] && { warn "    NO_PROXY: ${cur_noproxy:-(not set)} -> $no_proxy"; changed=true; }

  if [ "$changed" = true ]; then
    local tmp; tmp=$(mktemp)
    jq --arg hp "$proxy_url" --arg np "$no_proxy" '
      .env //= {} | .env.HTTPS_PROXY = $hp | .env.HTTP_PROXY = $hp | .env.NO_PROXY = $np
    ' "$settings_file" > "$tmp" && mv "$tmp" "$settings_file"
    warn "  Updated $label"
    return 0
  fi
  log "  $label up to date"
  return 1
}

# ── Sync Cursor settings.json ───────────────────────────────────────
sync_cursor_settings() {
  local proxy_url="$1"
  local no_proxy="localhost,127.0.0.1"
  local settings_file label="Cursor settings.json"

  if [ "$(uname)" = "Darwin" ]; then
    settings_file="$HOME/Library/Application Support/Cursor/User/settings.json"
  else
    settings_file="$HOME/.config/Cursor/User/settings.json"
  fi

  log "Checking $label ..."

  if [ ! -f "$settings_file" ]; then
    warn "  $settings_file not found, skipping."
    return 1
  fi

  check_cmd jq "apt install jq / brew install jq"

  local changed=false
  for var_name in HTTPS_PROXY HTTP_PROXY NO_PROXY; do
    local want="$proxy_url"
    [ "$var_name" = "NO_PROXY" ] && want="$no_proxy"
    local cur
    cur=$(jq -r --arg n "$var_name" \
      '(."claudeCode.environmentVariables" // [])[] | select(.name == $n) | .value' \
      "$settings_file" 2>/dev/null || true)
    if [ "$cur" != "$want" ]; then
      warn "    $var_name: ${cur:-(not set)} -> $want"
      changed=true
    fi
  done

  if [ "$changed" = true ]; then
    local tmp; tmp=$(mktemp)
    jq --arg hp "$proxy_url" --arg np "$no_proxy" '
      ."claudeCode.environmentVariables" = [
        { "name": "HTTPS_PROXY", "value": $hp },
        { "name": "HTTP_PROXY",  "value": $hp },
        { "name": "NO_PROXY",    "value": $np }
      ] + ([."claudeCode.environmentVariables" // [] | .[]
            | select(.name != "HTTPS_PROXY" and .name != "HTTP_PROXY" and .name != "NO_PROXY")])
    ' "$settings_file" > "$tmp" && mv "$tmp" "$settings_file"
    warn "  Updated $label"
    return 0
  fi
  log "  $label up to date"
  return 1
}

sync_all_settings() {
  local proxy_url="$1"
  local need_restart=false
  sync_claude_cli "$proxy_url"     && need_restart=true
  sync_cursor_settings "$proxy_url" && need_restart=true

  if [ "$need_restart" = true ]; then
    echo ""
    echo -e "${MAGENTA}[proxy] *** Restart Cursor to apply settings changes ***${NC}"
    echo ""
  fi
}

# ════════════════════════════════════════════════════════════════════
#  Main
# ════════════════════════════════════════════════════════════════════

check_cmd pproxy "pip install pproxy"

# ── Sync settings ──────────────────────────────────────────────────
sync_all_settings "$PROXY_URL"

# ── Optional: SSH tunnel ───────────────────────────────────────────
if [ -n "$REMOTE_HOST" ]; then
  check_cmd ssh
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
fi

# ── pproxy foreground (SOCKS5 -> HTTP, -vv logs) ──────────────────
log "pproxy: SOCKS5 :$SOCKS_PORT -> HTTP :$HTTP_PORT"
log "Claude Code proxy URL: $PROXY_URL"
log ""
log "pproxy -vv logs (Ctrl+C to stop):"
log "────────────────────────────────────"

pproxy -l "http://127.0.0.1:$HTTP_PORT" -r "socks5://127.0.0.1:$SOCKS_PORT" -vv
