#!/usr/bin/env bash
# Connects to the dev VM with its dedicated throwaway key. Never the user's real ~/.ssh identity.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DIR/state"

exec ssh \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile="$STATE/known_hosts" \
  -i "$STATE/id_ed25519" \
  -p 2222 \
  miro@127.0.0.1 \
  "$@"
