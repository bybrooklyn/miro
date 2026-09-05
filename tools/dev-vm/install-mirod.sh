#!/usr/bin/env bash
# Installs mirod as a systemd unit on the dev VM with the §5.32 self-update version layout: the unit's
# stable ExecStart=/usr/local/bin/mirod is a wrapper that runs whatever /opt/miro/current points at,
# and an ExecStartPre preflight does the atomic swap + crash-loop revert. Version 0.0.1 is a symlink
# to the live dev tree /home/miro/miro, so sync-and-restart keeps working. Run once per fresh disk,
# and again whenever apps/mirod/mirod.service or preflight.mjs changes. An optional argument names a
# different unit file (the hardening verification pass feeds it variants). Dev-only, not shipped.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="${1:-$DIR/../../apps/mirod/mirod.service}"
[[ -f "$UNIT" ]] || { echo "unit file not found: $UNIT" >&2; exit 1; }

# The /opt/miro version layout. v1 (0.0.1) = the live dev tree; current -> it. The preflight is a
# FIXED copy (never swapped), so a broken new version cannot break its own recovery.
"$DIR/ssh.sh" 'set -e
  sudo mkdir -p /opt/miro/versions
  sudo ln -sfn /home/miro/miro /opt/miro/versions/0.0.1
  [ -e /opt/miro/current ] || sudo ln -sfn /opt/miro/versions/0.0.1 /opt/miro/current
  sudo cp /home/miro/miro/apps/mirod/preflight.mjs /opt/miro/preflight.mjs'

# The main wrapper: resolve current, export its name as MIRO_VERSION, exec bun on it.
"$DIR/ssh.sh" 'sudo tee /usr/local/bin/mirod >/dev/null && sudo chmod 755 /usr/local/bin/mirod' <<'EOF'
#!/bin/sh
cur="$(readlink /opt/miro/current)"
export MIRO_VERSION="${cur##*/}"
dir="$(readlink -f /opt/miro/current)"
cd "$dir/apps/mirod" && exec /home/miro/.bun/bin/bun run src/index.ts
EOF

# The preflight wrapper (ExecStartPre): a stable path that runs the fixed preflight.mjs under bun.
"$DIR/ssh.sh" 'sudo tee /usr/local/bin/mirod-preflight >/dev/null && sudo chmod 755 /usr/local/bin/mirod-preflight' <<'EOF'
#!/bin/sh
exec /home/miro/.bun/bin/bun /opt/miro/preflight.mjs
EOF

"$DIR/ssh.sh" 'sudo tee /etc/systemd/system/mirod.service >/dev/null' < "$UNIT"
# Anchored: an unanchored pkill -f would match this ssh command's own shell (AGENTS.md gotcha).
"$DIR/ssh.sh" 'sudo pkill -f "^/home/miro/.bun/bin/bun run src/index.ts" || true
  sudo systemctl daemon-reload && sudo systemctl reset-failed mirod 2>/dev/null || true
  sudo systemctl enable mirod >/dev/null 2>&1 && sudo systemctl restart mirod && systemctl --no-pager status mirod | head -12'
