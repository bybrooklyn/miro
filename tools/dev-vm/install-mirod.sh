#!/usr/bin/env bash
# Installs mirod as a systemd unit on the dev VM, running the SOURCE tree at /home/miro/miro through
# a wrapper at the unit's stable ExecStart path (production ships the compiled binary there,
# PLAN.md §5.16). Run once per fresh disk, and again whenever apps/mirod/mirod.service changes.
# An optional argument names a different unit file to install (the flag-by-flag verification pass
# feeds it variants). Dev-only, not shipped.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="${1:-$DIR/../../apps/mirod/mirod.service}"
[[ -f "$UNIT" ]] || { echo "unit file not found: $UNIT" >&2; exit 1; }

"$DIR/ssh.sh" 'sudo tee /usr/local/bin/mirod >/dev/null && sudo chmod 755 /usr/local/bin/mirod' <<'EOF'
#!/bin/sh
cd /home/miro/miro/apps/mirod && exec /home/miro/.bun/bin/bun run src/index.ts
EOF
"$DIR/ssh.sh" 'sudo tee /etc/systemd/system/mirod.service >/dev/null' < "$UNIT"
# Anchored: an unanchored pkill -f would match this ssh command's own shell (AGENTS.md gotcha).
"$DIR/ssh.sh" 'sudo pkill -f "^/home/miro/.bun/bin/bun run src/index.ts" || true
  sudo systemctl daemon-reload && sudo systemctl reset-failed mirod 2>/dev/null || true
  sudo systemctl enable mirod >/dev/null 2>&1 && sudo systemctl restart mirod && systemctl --no-pager status mirod | head -12'
