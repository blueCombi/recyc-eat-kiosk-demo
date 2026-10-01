#!/usr/bin/env bash
#
# Expose the kiosk server (port 4000) as a public HTTPS URL so
# https://recyceat.matarix.store can drive the ESP32 boards.
#
# Run on the Pi, leave this window open:
#   bash scripts/pi-https-tunnel.sh
#
# Copy the https://*.trycloudflare.com line into Admin → Kiosk Settings
# → Hardware URL, then Save.
#
set -euo pipefail

cd "$(dirname "$0")/.."
ARCH="$(uname -m)"
BIN="$HOME/.local/bin/cloudflared"
mkdir -p "$(dirname "$BIN")"

if [ ! -x "$BIN" ]; then
  case "$ARCH" in
    aarch64|arm64) FILE=cloudflared-linux-arm64 ;;
    armv7l|armv6l) FILE=cloudflared-linux-arm ;;
    x86_64)        FILE=cloudflared-linux-amd64 ;;
    *) echo "Unknown architecture: $ARCH"; exit 1 ;;
  esac
  echo "Downloading $FILE…"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${FILE}" -o "$BIN"
  chmod +x "$BIN"
fi

echo "Kiosk must already be running on port 4000."
echo "Paste the https://….trycloudflare.com URL into Kiosk Settings."
echo
exec "$BIN" tunnel --url http://127.0.0.1:4000
