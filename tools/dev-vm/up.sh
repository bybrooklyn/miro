#!/usr/bin/env bash
# Boots a disposable, minimal Debian 13 (genericcloud arm64) VM under QEMU for testing Miro's SSH
# bootstrap end to end. Not part of the shipped product - dev-only tooling. See ../../README or
# the plan this was built from for context.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DIR/state"
CLOUD_INIT="$DIR/cloud-init"
mkdir -p "$STATE"

IMAGE_NAME="debian-13-genericcloud-arm64.qcow2"
IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/latest/$IMAGE_NAME"
SUMS_URL="https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS"
BASE_IMAGE="$STATE/$IMAGE_NAME"

QEMU_SHARE="$(brew --prefix qemu)/share/qemu"
FIRMWARE_CODE="$QEMU_SHARE/edk2-aarch64-code.fd"
FIRMWARE_VARS_TEMPLATE="$QEMU_SHARE/edk2-arm-vars.fd"

# 1. Base image: download once, verify against Debian's own published SHA512SUMS (not a value
# hardcoded into this script, since "latest" is a rolling pointer that gets rebuilt).
if [[ ! -f "$BASE_IMAGE" ]]; then
  echo "Downloading $IMAGE_NAME..."
  curl -fL -o "$BASE_IMAGE.tmp" "$IMAGE_URL"
  EXPECTED="$(curl -fsL "$SUMS_URL" | grep " $IMAGE_NAME\$" | awk '{print $1}')"
  ACTUAL="$(shasum -a 512 "$BASE_IMAGE.tmp" | awk '{print $1}')"
  if [[ -z "$EXPECTED" || "$EXPECTED" != "$ACTUAL" ]]; then
    echo "Checksum mismatch - expected [$EXPECTED] got [$ACTUAL]" >&2
    rm -f "$BASE_IMAGE.tmp"
    exit 1
  fi
  mv "$BASE_IMAGE.tmp" "$BASE_IMAGE"
  echo "Verified SHA512."
fi

# 2. Throwaway SSH keypair - only ever used for this VM, never the user's real ~/.ssh.
if [[ ! -f "$STATE/id_ed25519" ]]; then
  ssh-keygen -t ed25519 -N "" -C "miro-dev-vm" -f "$STATE/id_ed25519" >/dev/null
fi

if [[ -f "$STATE/qemu.pid" ]] && kill -0 "$(cat "$STATE/qemu.pid")" 2>/dev/null; then
  echo "VM already running (pid $(cat "$STATE/qemu.pid"))."
else
  # Copy-on-write overlay so the pristine downloaded image is never mutated and re-runs are cheap.
  # 12G virtual size (the base cloud image's own default is ~3G, too small for Docker + any real
  # container image - found live sizing up Stage D's Docker install) - sparse, so this costs
  # near-nothing on the host disk until actually written. Debian's cloud-init growpart/resizefs
  # modules expand the partition/filesystem to fill it automatically on first boot.
  if [[ ! -f "$STATE/disk.qcow2" ]]; then
    qemu-img create -f qcow2 -F qcow2 -b "$BASE_IMAGE" "$STATE/disk.qcow2" 12G >/dev/null
  fi

  # Fresh UEFI vars each boot - this VM is throwaway, nothing needs to persist across boots.
  cp "$FIRMWARE_VARS_TEMPLATE" "$STATE/vars.fd"

  # cloud-init NoCloud seed (hdiutil is native to macOS - no genisoimage/xorriso dependency).
  PUBKEY="$(cat "$STATE/id_ed25519.pub")"
  SEED_DIR="$(mktemp -d)"
  trap 'rm -rf "$SEED_DIR"' EXIT
  sed "s|__SSH_PUBKEY__|$PUBKEY|" "$CLOUD_INIT/user-data.yaml" > "$SEED_DIR/user-data"
  cp "$CLOUD_INIT/meta-data" "$SEED_DIR/meta-data"
  hdiutil makehybrid -iso -default-volume-name cidata -o "$STATE/seed.iso" "$SEED_DIR" -ov >/dev/null

  rm -f "$STATE/console.log" "$STATE/known_hosts"

  # Optional cargo disk: MIRO_VM_CARGO=/path/to/file.iso attaches an extra read-only virtio drive
  # at boot - a way to get large files (a Docker image tarball, etc.) onto the VM at real disk-I/O
  # speed instead of through net0's SLIRP link, which caps sustained throughput around 1.2Mbit/s
  # regardless of the host's actual connection speed (measured live sizing up Stage D's container
  # pulls: this Mac's native connection did 12.5Mbps against the same endpoint SLIRP only got
  # 1.2Mbps from). Shows up as an extra /dev/vdX inside the VM - mount it and copy off what you
  # need. Every future Stage D container pull (Sonarr, Radarr, Prowlarr, qBittorrent, Portainer)
  # will want this same trick.
  # Expanded below with the ${arr[@]+"${arr[@]}"} idiom: macOS ships bash 3.2, where expanding an
  # EMPTY array under `set -u` is an "unbound variable" error (found live on the first boot with
  # no cargo drive).
  CARGO_DRIVE_ARGS=()
  if [[ -n "${MIRO_VM_CARGO:-}" ]]; then
    CARGO_DRIVE_ARGS=(-drive "if=virtio,format=raw,file=${MIRO_VM_CARGO},media=cdrom,readonly=on")
  fi

  # 3G RAM: at 1.5G the kernel OOM-killed Chromium (Bun.WebView) mid-learn while a Jellyfin
  # container and mirod were also resident - found in console.log during Stage D slice 1.
  qemu-system-aarch64 \
    -accel hvf \
    -M virt \
    -cpu host \
    -m 3072 \
    -smp 2 \
    -drive if=pflash,format=raw,readonly=on,file="$FIRMWARE_CODE" \
    -drive if=pflash,format=raw,file="$STATE/vars.fd" \
    -drive if=virtio,format=qcow2,file="$STATE/disk.qcow2",discard=unmap,detect-zeroes=unmap \
    -drive if=virtio,format=raw,file="$STATE/seed.iso",media=cdrom \
    ${CARGO_DRIVE_ARGS[@]+"${CARGO_DRIVE_ARGS[@]}"} \
    -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 \
    -device virtio-net-pci,netdev=net0 \
    -display none \
    -serial file:"$STATE/console.log" \
    -daemonize \
    -pidfile "$STATE/qemu.pid"

  echo "VM booting (pid $(cat "$STATE/qemu.pid"))..."
fi

# 3. Wait for SSH - reuses the exact probePort() the SetupScreen wizard itself uses, not a
# reimplementation, so "ready" here means the same thing it means to the real product code.
echo "Waiting for SSH on 127.0.0.1:2222..."
for _ in $(seq 1 90); do
  if bun -e '
import { probePort } from "'"$DIR"'/../../apps/miro/src/setup/reachability.ts";
process.exit((await probePort("127.0.0.1", 2222, 1000)) ? 0 : 1);
' 2>/dev/null; then
    echo "SSH is up. tools/dev-vm/ssh.sh to connect."
    exit 0
  fi
  sleep 2
done
echo "Timed out waiting for SSH - check $STATE/console.log" >&2
exit 1
