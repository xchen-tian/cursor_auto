#!/usr/bin/env bash
# Start Cursor with Chrome DevTools Protocol enabled.
# Usage: ./start_cursor.sh [workspace_path]

PORT="${CURSOR_CDP_PORT:-9292}"
WORKSPACE="${1:-.}"

if [[ "$OSTYPE" == "darwin"* ]]; then
  CURSOR_BIN="/Applications/Cursor.app/Contents/MacOS/Cursor"
  if [ ! -x "$CURSOR_BIN" ]; then
    CURSOR_BIN="$HOME/Applications/Cursor.app/Contents/MacOS/Cursor"
  fi
  if [ ! -x "$CURSOR_BIN" ]; then
    CURSOR_BIN="$(command -v cursor 2>/dev/null)"
  fi
else
  CURSOR_BIN="$(command -v cursor 2>/dev/null)"
  if [ -z "$CURSOR_BIN" ]; then
    for p in /opt/cursor/cursor /usr/bin/cursor /usr/share/cursor/cursor "$HOME/.local/bin/cursor"; do
      if [ -x "$p" ]; then CURSOR_BIN="$p"; break; fi
    done
  fi
fi

if [ -z "$CURSOR_BIN" ] || [ ! -x "$CURSOR_BIN" ]; then
  echo "ERROR: Cursor executable not found."
  echo "Make sure Cursor is installed and 'cursor' is in your PATH."
  exit 1
fi

echo "Starting Cursor with --remote-debugging-port=$PORT ..."
exec "$CURSOR_BIN" --remote-debugging-port="$PORT" "$WORKSPACE"
