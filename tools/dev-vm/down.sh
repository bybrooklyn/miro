#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DIR/state"

if [[ -f "$STATE/qemu.pid" ]]; then
  PID="$(cat "$STATE/qemu.pid")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID"
    echo "Stopped VM (pid $PID)."
  else
    echo "No running VM (stale pidfile)."
  fi
  rm -f "$STATE/qemu.pid"
else
  echo "No VM running."
fi
