#!/bin/sh
# Miro installer. One command, a real server:
#
#   curl -fsSL https://raw.githubusercontent.com/bybrooklyn/miro/master/install.sh | sudo sh
#
# Server mode (default, needs root + systemd) installs the daemon AND the terminal client, laying out
# the /opt/miro version tree the daemon's own self-update machinery expects (PLAN.md §5.32), so the
# very first install and every later update take the same audited path: stage a version, swap the
# `current` symlink atomically, and let the preflight revert a version that cannot boot.
#
#   --client            install only the `miro` terminal client, no root, under ~/.miro (macOS/laptop)
#   --uninstall         remove Miro, keep /var/lib/miro (the DB, secrets, stacks)
#   --purge             remove Miro AND its state, and the miro user/group
#   --dry-run           print every URL, path and system change, touch nothing
#   --non-interactive   never prompt (still honours API-key env vars)
#   --channel beta      follow prereleases too
#   --version X.Y.Z     install exactly this version
#
# Trust: this script arrives over HTTPS from GitHub. It checks the release tarball's sha256 against the
# signed manifest BEFORE unpacking, and then verifies the manifest's Sigstore signature (keyless, the
# identity pinned to Miro's own release workflow) BEFORE the daemon is ever started - a version that
# fails either check is deleted, not run.
set -eu

REPO="${MIRO_REPO:-bybrooklyn/miro}"
BUN_VERSION="${MIRO_BUN_VERSION:-1.4.0}"   # matches CI's setup-bun pin, so the lockfile resolves identically
ROOT="${MIRO_UPDATE_ROOT:-/opt/miro}"
CHANNEL=stable
VERSION=
MODE=server
DRY=0
INTERACTIVE=1
PURGE=0

# `sudo sh` routinely hands us a stripped PATH where groupadd/useradd/setpriv are invisible even
# though they are installed - the daemon hits the same thing with getent at runtime. Found live on a
# stock Debian 13 cloud image: groupadd and useradd were both "missing" until /usr/sbin was added.
PATH="$PATH:/usr/sbin:/sbin"
export PATH

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# Every mutating action goes through run(), so --dry-run is a property of the script rather than a
# parallel code path that can drift from the real one.
run() {
  if [ "$DRY" = 1 ]; then printf 'WOULD_RUN=%s\n' "$*"; else "$@"; fi
}
fact() { printf '%s=%s\n' "$1" "$2"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --client) MODE=client ;;
    --uninstall) MODE=uninstall ;;
    --purge) MODE=uninstall; PURGE=1 ;;
    --dry-run) DRY=1 ;;
    --non-interactive) INTERACTIVE=0 ;;
    --channel) shift; CHANNEL="${1:-stable}" ;;
    --version) shift; VERSION="${1:-}" ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- pure decisions (unit-tested)

# uname -m -> the arch fragment Bun and we use. Kept pure and tiny: `install.sh --dry-run` prints it,
# and the Bun test asserts the whole table including the refusal.
resolve_arch() {
  case "$1" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'aarch64' ;;
    *) return 1 ;;
  esac
}

# Bun ships per-libc and per-CPU-baseline builds; picking the wrong one gets you a binary that dies
# with an illegal instruction or a missing loader rather than a clear error.
resolve_bun_asset() {
  arch="$1"; libc="$2"; baseline="$3"
  suffix=""
  [ "$arch" = x64 ] && [ "$baseline" = 1 ] && suffix="-baseline"
  [ "$libc" = musl ] && suffix="${suffix}-musl"
  printf 'bun-linux-%s%s.zip' "$arch" "$suffix"
}

# Public releases: plain download URLs, no API token, no asset-id dance (that indirection exists in
# the daemon only because the repo used to be private). MIRO_RELEASE_BASE points the fetch somewhere
# else entirely - a mirror, an airgapped copy on a local HTTP server, or a release under test - and is
# expected to hold the same three files under the same names.
release_url() {
  if [ -n "${MIRO_RELEASE_BASE:-}" ]; then printf '%s/%s' "${MIRO_RELEASE_BASE%/}" "$2"; return; fi
  printf 'https://github.com/%s/releases/download/v%s/%s' "$REPO" "$1" "$2"
}
bun_url() { printf 'https://github.com/oven-sh/bun/releases/download/bun-v%s/%s' "$BUN_VERSION" "$1"; }

# Three-way, not two: a run that died before the `current` symlink existed must resume the fresh
# install, NOT be mistaken for an upgrade.
already_installed() {
  current_target="$1"; target_version="$2"
  if [ -z "$current_target" ]; then printf 'fresh'; return; fi
  case "$current_target" in
    */"$target_version") printf 'noop' ;;
    *) printf 'upgrade' ;;
  esac
}

detect_libc() {
  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then printf 'musl'; return; fi
  if ldd --version 2>&1 | head -1 | grep -qi musl; then printf 'musl'; else printf 'glibc'; fi
}

# Bun's default x64 build needs AVX2; boxes without it need the baseline build.
detect_baseline() {
  if [ "$(uname -m)" = x86_64 ] || [ "$(uname -m)" = amd64 ]; then
    grep -qm1 avx2 /proc/cpuinfo 2>/dev/null && printf '0' || printf '1'
  else
    printf '0'
  fi
}

# sha256, from whatever the box actually has. Minimal images ship only one of these.
SHA_CMD=
resolve_sha_cmd() {
  if have sha256sum; then SHA_CMD='sha256sum'
  elif have shasum; then SHA_CMD='shasum -a 256'
  elif have openssl; then SHA_CMD='openssl-dgst'
  else return 1; fi
}
sha256_of() {
  case "$SHA_CMD" in
    openssl-dgst) openssl dgst -sha256 "$1" | sed 's/.*= *//' ;;
    *) $SHA_CMD "$1" | cut -d' ' -f1 ;;
  esac
}

# ---------------------------------------------------------------- shared helpers

fetch_to() { # url dest
  if have curl; then run curl -fsSL --retry 3 -o "$2" "$1"
  elif have wget; then run wget -qO "$2" "$1"
  else die "need curl or wget"; fi
}

# Bun publishes zips, and a stock Debian 13 cloud image has no unzip (found live on a cold box - the
# dev VM had picked one up somewhere, which is exactly the kind of thing a pampered box hides). Every
# cloud image does have python3, because cloud-init is written in it. So: unzip if present, else
# python3's zipfile. Neither means a clear instruction rather than a mysterious failure.
extract_zip() { # zipfile destdir
  if have unzip; then unzip -qo "$1" -d "$2"
  elif have python3; then python3 -m zipfile -e "$1" "$2"
  else die "need unzip or python3 to unpack Bun (apt-get install unzip)"; fi
}
have_unzipper() { have unzip || have python3; }

# Every symlink and binary swap is tmp-then-rename. `ln -sfn` unlinks before it symlinks, and the
# daemon's own preflight.mjs goes out of its way to avoid that window - so this does too.
atomic_symlink() { # target linkpath
  run ln -sfn "$1" "$2.tmp"
  run mv -Tf "$2.tmp" "$2" 2>/dev/null || run mv -f "$2.tmp" "$2"
}

resolve_version() {
  [ -n "$VERSION" ] && { printf '%s' "$VERSION"; return; }
  api="https://api.github.com/repos/$REPO/releases"
  [ "$CHANNEL" = stable ] && api="$api/latest"
  body=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$api" 2>/dev/null) || die "cannot reach the GitHub releases API for $REPO"
  # First tag_name in the response: /latest returns one object; the list is newest-first, and a beta
  # install deliberately takes whatever is newest including a prerelease.
  tag=$(printf '%s' "$body" | grep -o '"tag_name" *: *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$tag" ] || die "no release found for channel $CHANNEL"
  printf '%s' "${tag#v}"
}

# POSIX sh has no locals: every variable here is global, so this function's names are prefixed. An
# unprefixed `url` here silently clobbered the caller's tarball URL and made the client download Bun
# as the release tarball - caught live by the sha256 check, which is exactly what it is for.
install_bun_to() { # destdir  -> installs <destdir>/bun at the pinned version
  _b_dest="$1"
  if [ -x "$_b_dest/bun" ] && [ "$("$_b_dest/bun" --version 2>/dev/null)" = "$BUN_VERSION" ]; then
    say "Bun $BUN_VERSION already at $_b_dest/bun"
    return
  fi
  _b_asset="${2:-$(resolve_bun_asset "$ARCH" "$LIBC" "$BASELINE")}"
  _b_url=$(bun_url "$_b_asset")
  fact BUN_ASSET "$_b_asset"; fact BUN_URL "$_b_url"
  have_unzipper || die "need unzip or python3 to unpack Bun"
  fetch_to "$_b_url" "$TMP/bun.zip"
  fetch_to "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/SHASUMS256.txt" "$TMP/bun.sums"
  if [ "$DRY" != 1 ]; then
    _b_want=$(grep " $_b_asset\$" "$TMP/bun.sums" | cut -d' ' -f1)
    _b_got=$(sha256_of "$TMP/bun.zip")
    [ -n "$_b_want" ] || die "no published checksum for $_b_asset"
    [ "$_b_want" = "$_b_got" ] || die "Bun checksum mismatch: expected $_b_want, got $_b_got"
    rm -rf "$TMP/bunzip"
    extract_zip "$TMP/bun.zip" "$TMP/bunzip"
    mkdir -p "$_b_dest"
    mv -f "$TMP/bunzip"/*/bun "$_b_dest/bun.new"
    chmod 755 "$_b_dest/bun.new"
    mv -f "$_b_dest/bun.new" "$_b_dest/bun"
  else
    fact WOULD_INSTALL_BUN "$_b_dest/bun"
  fi
}

# ---------------------------------------------------------------- uninstall

do_uninstall() {
  [ "$(id -u)" = 0 ] || die "--uninstall needs root"
  say "Stopping and removing Miro..."
  run systemctl disable --now mirod 2>/dev/null || true
  run rm -f /etc/systemd/system/mirod.service
  run systemctl daemon-reload 2>/dev/null || true
  run rm -f /usr/local/bin/mirod /usr/local/bin/mirod-preflight /usr/local/bin/miro
  run rm -rf "$ROOT"
  if [ "$PURGE" = 1 ]; then
    # Loud even under --non-interactive: this is the one step that reaches outside Miro's own paths
    # and it changes the operator's group membership in every shell they have open.
    warn "--purge also removes /var/lib/miro (DB, secrets, stacks) and the miro user/group."
    run rm -rf /var/lib/miro
    [ -n "${SUDO_USER:-}" ] && run gpasswd -d "$SUDO_USER" miro 2>/dev/null || true
    # Only remove the account if it is the system user WE would have created. On a box whose admin
    # happens to be named miro - which is exactly the case on a cloud image where you named your
    # login that - userdel would be aimed at the operator's own account. Found live.
    miro_uid=$(id -u miro 2>/dev/null || echo "")
    if [ -n "$miro_uid" ] && [ "$miro_uid" -lt 1000 ] && [ "${SUDO_USER:-}" != miro ]; then
      run userdel miro 2>/dev/null || true
      run groupdel miro 2>/dev/null || true
    elif [ -n "$miro_uid" ]; then
      say "Left the existing 'miro' account alone (uid $miro_uid) - Miro did not create it."
    fi
    say "Purged. /var/lib/miro is gone."
  else
    say "Removed. /var/lib/miro kept - reinstalling picks it back up."
  fi
}

# ---------------------------------------------------------------- client mode

do_client() {
  home="${HOME:?HOME must be set}"
  dest="$home/.miro"
  bindir="${MIRO_BIN_DIR:-$home/.local/bin}"
  fact MODE client; fact ARCH "$ARCH"; fact CLIENT_DIR "$dest"; fact CLIENT_BIN "$bindir/miro"
  case "$(uname -s)" in
    Darwin) BUN_OS=darwin ;;
    Linux) BUN_OS=linux ;;
    *) die "unsupported OS for the client: $(uname -s)" ;;
  esac
  v=$(resolve_version); fact VERSION "$v"
  tarball="miro-v$v.tar.gz"
  # c_ prefix: install_bun_to below shares this shell's globals.
  c_url=$(release_url "$v" "$tarball"); fact TARBALL_URL "$c_url"
  c_murl=$(release_url "$v" manifest.json); fact MANIFEST_URL "$c_murl"
  # macOS asset naming differs from Linux's, and has no musl/baseline split - otherwise identical, so
  # the same download-verify-extract path handles both.
  if [ "$BUN_OS" = darwin ]; then
    install_bun_to "$dest/bin" "bun-darwin-$ARCH.zip"
  else
    install_bun_to "$dest/bin"
  fi
  fetch_to "$c_url" "$TMP/$tarball"
  fetch_to "$c_murl" "$TMP/manifest.json"
  if [ "$DRY" != 1 ]; then
    want=$(grep -o '"sha256" *: *"[^"]*"' "$TMP/manifest.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    got=$(sha256_of "$TMP/$tarball")
    [ "$want" = "$got" ] || die "tarball checksum mismatch: expected $want, got $got"
    rm -rf "$dest/versions/$v.staging"; mkdir -p "$dest/versions/$v.staging"
    tar xzf "$TMP/$tarball" -C "$dest/versions/$v.staging"
    ( cd "$dest/versions/$v.staging" && "$dest/bin/bun" install --frozen-lockfile ) || {
      rm -rf "$dest/versions/$v.staging"; die "bun install failed"; }
    rm -rf "$dest/versions/$v"; mv "$dest/versions/$v.staging" "$dest/versions/$v"
    mkdir -p "$bindir"
    cat > "$bindir/miro.new" <<EOF
#!/bin/sh
cd "$dest/versions/$v/apps/miro" && exec "$dest/bin/bun" run src/index.tsx "\$@"
EOF
    chmod 755 "$bindir/miro.new"; mv -f "$bindir/miro.new" "$bindir/miro"
  fi
  say ""
  say "Miro client installed: $bindir/miro"
  case ":$PATH:" in *":$bindir:"*) ;; *) say "Add $bindir to your PATH." ;; esac
  say "Point it at a daemon: MIRO_SOCKET=/path/to/mirod.sock miro   (or pair with a remote box)"
}

# ---------------------------------------------------------------- server mode

preconditions() {
  [ "$(uname -s)" = Linux ] || die "the server install needs Linux (use --client on macOS)"
  [ "$(id -u)" = 0 ] || die "the server install needs root: pipe to \`sudo sh\`"
  # systemctl existing is not enough: a container or WSL1 can have the binary with a different PID 1,
  # where `systemctl start` fails in a way nobody can read.
  have systemctl && [ -d /run/systemd/system ] || die "systemd must be PID 1 on this box (this looks like a container or WSL1)"
  for t in tar; do have "$t" || die "need $t"; done
  have_unzipper || die "need unzip or python3 (to unpack Bun)"
  resolve_sha_cmd || die "need sha256sum, shasum or openssl"
  have setpriv || warn "setpriv is missing (util-linux) - the extension host cannot drop privileges without it"
  have groupadd && have useradd || die "need groupadd/useradd (shadow-utils)"
  # The hardened unit and the command sandbox were tuned on Debian family; say so rather than pretend.
  [ -f /etc/debian_version ] || warn "not a Debian-family box: the systemd hardening and bubblewrap sandbox are untested here"
  if have getenforce && [ "$(getenforce 2>/dev/null)" = Enforcing ]; then
    warn "SELinux is enforcing - Miro's unit hardening has not been tested against an SELinux policy"
  fi
}

ensure_accounts() {
  if ! getent group miro >/dev/null 2>&1; then run groupadd --system miro; fi
  if id -u miro >/dev/null 2>&1; then
    # An unrelated `miro` account is a conflict to report, not something to reshape under the owner.
    home=$(getent passwd miro | cut -d: -f6)
    [ -n "$home" ] && [ -d "$home" ] || warn "user 'miro' exists without a home directory - the extension host needs one ($home)"
  else
    run useradd --system --gid miro --home-dir /home/miro --create-home --shell /usr/sbin/nologin miro
  fi
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
    if getent group miro | grep -qw "$SUDO_USER"; then :; else
      run usermod -aG miro "$SUDO_USER"
      ADDED_GROUP="$SUDO_USER"
    fi
  fi
}

write_wrappers() { # versiondir
  bun="$ROOT/bin/bun"
  if [ "$DRY" = 1 ]; then
    fact WOULD_WRITE /usr/local/bin/mirod; fact WOULD_WRITE /usr/local/bin/mirod-preflight; fact WOULD_WRITE /usr/local/bin/miro
    return
  fi
  # MIRO_VERSION must be the basename of what `current` points at - self-update's currentVersion(),
  # staging and blessing all read it, and an empty one silently disables self-update.
  cat > /usr/local/bin/mirod.new <<EOF
#!/bin/sh
cur="\$(readlink $ROOT/current)"
export MIRO_VERSION="\${cur##*/}"
dir="\$(readlink -f $ROOT/current)"
cd "\$dir/apps/mirod" && exec $bun run src/index.ts "\$@"
EOF
  cat > /usr/local/bin/mirod-preflight.new <<EOF
#!/bin/sh
exec $bun $ROOT/preflight.mjs
EOF
  cat > /usr/local/bin/miro.new <<EOF
#!/bin/sh
dir="\$(readlink -f $ROOT/current)"
cd "\$dir/apps/miro" && exec $bun run src/index.tsx "\$@"
EOF
  for w in mirod mirod-preflight miro; do
    chmod 755 "/usr/local/bin/$w.new"; mv -f "/usr/local/bin/$w.new" "/usr/local/bin/$w"
  done
}

seed_credentials() { # versiondir - best effort, never blocks the install
  # Env first (scripted installs), then a /dev/tty prompt: `curl | sh` has stdin taken by the script
  # itself, so /dev/tty is the only way to ask a human anything.
  for pair in "ANTHROPIC_API_KEY provider.anthropic" "OPENAI_API_KEY provider.openai" \
              "GEMINI_API_KEY provider.google" "OPENROUTER_API_KEY provider.openrouter"; do
    env_name=${pair%% *}; ref=${pair##* }
    eval "val=\${$env_name:-}"
    [ -n "$val" ] || continue
    say "Storing $ref from \$$env_name"
    # Piped on stdin: never in argv, never echoed, and `mirod secret set` exits before the daemon boots.
    if [ "$DRY" = 1 ]; then fact WOULD_SEED "$ref"; else printf '%s' "$val" | /usr/local/bin/mirod secret set "$ref" >/dev/null; fi
  done
  [ "$INTERACTIVE" = 1 ] || return 0
  [ "$DRY" = 1 ] && return 0
  [ -r /dev/tty ] || return 0
  printf '\nAn AI provider key lets Miro think. Paste one now, or press enter to skip\n'
  printf 'and add it later with `/provider` inside the TUI.\n'
  printf 'Provider [anthropic/openai/google/openrouter, enter to skip]: '
  read -r prov </dev/tty || return 0
  case "$prov" in
    anthropic|openai|google|openrouter) ;;
    *) return 0 ;;
  esac
  printf 'Key (not echoed): '
  stty -echo 2>/dev/null || true
  read -r key </dev/tty || true
  stty echo 2>/dev/null || true
  printf '\n'
  [ -n "${key:-}" ] || return 0
  printf '%s' "$key" | /usr/local/bin/mirod secret set "provider.$prov" >/dev/null && say "Stored provider.$prov"
}

do_server() {
  preconditions
  fact MODE server; fact ARCH "$ARCH"; fact LIBC "$LIBC"; fact BASELINE "$BASELINE"; fact ROOT "$ROOT"
  v=$(resolve_version); fact VERSION "$v"
  tarball="miro-v$v.tar.gz"
  t_url=$(release_url "$v" "$tarball"); m_url=$(release_url "$v" manifest.json); b_url=$(release_url "$v" manifest.json.sigstore)
  fact TARBALL_URL "$t_url"; fact MANIFEST_URL "$m_url"; fact BUNDLE_URL "$b_url"

  current_target=""
  [ -L "$ROOT/current" ] && current_target=$(readlink "$ROOT/current")
  state=$(already_installed "$current_target" "$v")
  fact INSTALL_STATE "$state"
  if [ "$state" = noop ]; then
    say "Miro $v is already the current version. Nothing to do."
    say "Update later with \`miro\` -> ask Miro to update itself, or run this with --version <newer>."
    [ "$DRY" = 1 ] || return 0
  fi
  if [ "$state" = upgrade ]; then
    # An in-flight update owns the marker and the symlink; a second stage on top of it would race the
    # bless/revert decision.
    if [ -f "$ROOT/update.json" ] && grep -q '"phase"' "$ROOT/update.json" 2>/dev/null; then
      die "an update is already in flight ($ROOT/update.json) - let it settle first"
    fi
    systemctl is-active --quiet mirod || die "Miro is installed but not running; start it (systemctl start mirod), then re-run - the running daemon owns the version swap"
  fi

  # Space and writability before a single byte is downloaded: a mid-install ENOSPC is the messiest
  # failure there is. Two trees' worth, because an upgrade keeps the old one.
  run mkdir -p "$ROOT/versions" "$ROOT/bin"
  [ "$DRY" = 1 ] || [ -w "$ROOT" ] || die "$ROOT is not writable"
  if [ "$DRY" != 1 ]; then
    avail=$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')
    [ "${avail:-0}" -gt 1048576 ] || die "need at least 1GB free on $(df -Ph "$ROOT" | awk 'NR==2 {print $6}')"
  fi
  # Known temp names from an interrupted earlier run. Renames are atomic, so nothing else can be left.
  run rm -rf "$ROOT"/versions/.staging-* "$ROOT/bin/bun.new" "$ROOT/current.tmp"

  install_bun_to "$ROOT/bin"

  fetch_to "$t_url" "$TMP/$tarball"
  fetch_to "$m_url" "$TMP/manifest.json"
  fetch_to "$b_url" "$TMP/manifest.json.sigstore"

  if [ "$DRY" != 1 ]; then
    want=$(grep -o '"sha256" *: *"[^"]*"' "$TMP/manifest.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    got=$(sha256_of "$TMP/$tarball")
    [ -n "$want" ] || die "manifest carries no artifact sha256"
    [ "$want" = "$got" ] || die "tarball checksum mismatch: manifest says $want, download is $got"
    say "Tarball sha256 matches the signed manifest."
  fi

  vdir="$ROOT/versions/$v"
  # "Staged" means unpacked AND installed. A dir without node_modules is a half-install: stageUpdate
  # only checks that the directory exists, so a partial tree left behind could later be swapped in
  # with no checks at all. Delete and redo rather than resume.
  if [ -d "$vdir" ] && [ ! -d "$vdir/node_modules" ]; then
    warn "$vdir exists but was never fully installed - redoing it"
    run rm -rf "$vdir"
  fi
  if [ ! -d "$vdir" ] && [ "$DRY" != 1 ]; then
    staging="$ROOT/versions/.staging-$v"
    rm -rf "$staging"; mkdir -p "$staging"
    tar xzf "$TMP/$tarball" -C "$staging"
    # --ignore-scripts closes the window between unpack and signature verification: nothing from the
    # tarball executes until it has been verified. Miro's native deps (iroh) ship prebuilt, so nothing
    # legitimately needs a lifecycle script.
    ( cd "$staging" && "$ROOT/bin/bun" install --frozen-lockfile --ignore-scripts ) || {
      rm -rf "$staging"; die "bun install failed (registry unreachable, or this arch has no prebuilt native deps)"; }
    mv "$staging" "$vdir"
    say "Staged $vdir"
  fi

  # The signature check needs @sigstore/* from the tree's own node_modules, so it necessarily runs
  # after install - hence --ignore-scripts above. Nothing is started until this passes.
  if [ "$DRY" != 1 ]; then
    if [ ! -f "$vdir/apps/mirod/src/self-update/verify-cli.ts" ]; then
      # Releases older than this installer have no verify-manifest subcommand, and invoking it there
      # would start a whole daemon instead of verifying. Refuse to guess; the sha256 above still held.
      warn "release $v predates install-time signature verification (no verify-manifest) - only the sha256 was checked"
    elif ( cd "$vdir/apps/mirod" && "$ROOT/bin/bun" run src/index.ts verify-manifest "$TMP/manifest.json" "$TMP/manifest.json.sigstore" ); then
      say "Sigstore signature verified: this release was built by $REPO's release workflow."
    else
      rm -rf "$vdir"
      die "release signature verification FAILED - the version has been deleted and nothing was started"
    fi
  fi

  ensure_accounts

  # The preflight is a FIXED copy that runs as root before mirod on every boot, so a broken new
  # version can never break its own recovery. Verified by digest after the rename.
  if [ "$DRY" = 1 ]; then fact WOULD_WRITE "$ROOT/preflight.mjs"; else
    cp "$vdir/apps/mirod/preflight.mjs" "$ROOT/preflight.mjs.new"
    mv -f "$ROOT/preflight.mjs.new" "$ROOT/preflight.mjs"
    [ "$(sha256_of "$ROOT/preflight.mjs")" = "$(sha256_of "$vdir/apps/mirod/preflight.mjs")" ] \
      || die "preflight.mjs copy does not match its source"
  fi

  write_wrappers "$vdir"

  if [ "$state" = upgrade ]; then
    say ""
    say "Version $v is staged and verified. The running daemon owns the swap:"
    say "  ask Miro to install update $v (it stages, restarts, and reverts automatically if the new"
    say "  version is unhealthy). This installer deliberately does not touch the live symlink."
    return 0
  fi

  atomic_symlink "$ROOT/versions/$v" "$ROOT/current"

  if [ "$DRY" = 1 ]; then
    fact WOULD_WRITE /etc/systemd/system/mirod.service
    fact WOULD_RUN "systemctl enable --now mirod"
    return 0
  fi
  cp "$vdir/apps/mirod/mirod.service" /etc/systemd/system/mirod.service.new
  mv -f /etc/systemd/system/mirod.service.new /etc/systemd/system/mirod.service
  systemctl daemon-reload

  seed_credentials "$vdir"

  say "Starting mirod..."
  systemctl enable mirod >/dev/null 2>&1 || true
  if ! systemctl start mirod; then
    say ""
    journalctl -u mirod --no-pager -n 40 || true
    die "mirod failed to start. Diagnose with: systemctl status mirod; journalctl -u mirod -b"
  fi
  # Type=notify, so start returned once the socket was up - but confirm rather than assume, and never
  # reset-failed-and-retry: that would mask the preflight's own crash-loop revert.
  systemctl is-active --quiet mirod || { journalctl -u mirod --no-pager -n 40 || true; die "mirod is not active"; }

  say ""
  say "Miro $v is running."
  say "  socket   /run/miro/mirod.sock (group miro)"
  say "  state    /var/lib/miro"
  say "  logs     journalctl -u mirod -f"
  have docker || say "  note     Docker is not installed - ask Miro to set it up when you want app stacks."
  say ""
  say "Talk to it:            miro"
  say "One-glance readout:    mirod status"
  say "What it has sent out:  mirod egress"
  [ -n "${ADDED_GROUP:-}" ] && say "" && say "Added $ADDED_GROUP to the miro group - run \`newgrp miro\` or log out and back in first."
  return 0
}

# ---------------------------------------------------------------- main

# MIRO_INSTALL_SOURCE_ONLY=1 loads the functions without doing anything, so the pure decisions
# (resolve_arch, resolve_bun_asset, release_url, already_installed) can be exercised directly by
# install.test.ts instead of by parsing a log.
if [ "${MIRO_INSTALL_SOURCE_ONLY:-0}" != 1 ]; then
  if [ "$MODE" = uninstall ]; then
    do_uninstall
    exit 0
  fi

  ARCH=$(resolve_arch "$(uname -m)") || die "unsupported architecture: $(uname -m) (Miro ships x86_64 and aarch64)"
  LIBC=$(detect_libc)
  BASELINE=$(detect_baseline)
  resolve_sha_cmd || die "need sha256sum, shasum or openssl"

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/miro-install.XXXXXX")
  trap 'rm -rf "$TMP"' EXIT INT TERM

  case "$MODE" in
    client) do_client ;;
    server) do_server ;;
  esac
fi
