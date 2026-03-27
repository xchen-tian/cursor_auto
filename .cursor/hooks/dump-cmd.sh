#!/bin/bash
input=$(cat)
timestamp=$(date '+%Y-%m-%d %H:%M:%S')
logfile="${CURSOR_PROJECT_DIR:-.}/.cursor/hooks/cmd.log"

echo "[$timestamp] $input" >> "$logfile"
exit 0
