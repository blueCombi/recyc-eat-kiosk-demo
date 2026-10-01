#!/usr/bin/env bash
#
# fix-printer.sh — give the kiosk user access to the USB thermal printer
# without a full reinstall. Run on the Raspberry Pi as the normal user:
#   bash scripts/fix-printer.sh
#
set -euo pipefail

[ "$(uname -s)" = "Linux" ] \
  || { echo "Run this on the Raspberry Pi." >&2; exit 1; }

command -v sudo >/dev/null || { echo "sudo is required." >&2; exit 1; }

USER_NAME="$(id -un)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SERVICE_NAME=econova-kiosk

echo "==> Adding ${USER_NAME} to dialout, plugdev, lp"
for group in dialout plugdev lp; do
  getent group "$group" >/dev/null || continue
  sudo usermod -aG "$group" "$USER_NAME"
done

echo "==> Installing udev rule"
printf '%s\n' \
  '# EcoNova kiosk: dedicated machine — open USB devices for the print server.' \
  'SUBSYSTEM=="usb", MODE="0666"' \
  'SUBSYSTEM=="usb", ATTR{bDeviceClass}=="07", MODE="0666", GROUP="plugdev"' \
  'SUBSYSTEM=="usb", ATTRS{bInterfaceClass}=="07", MODE="0666", GROUP="plugdev"' \
  'KERNEL=="lp[0-9]*", SUBSYSTEM=="usbmisc", MODE="0666", GROUP="lp"' \
  'KERNEL=="usb/lp[0-9]*", MODE="0666", GROUP="lp"' \
  | sudo tee /etc/udev/rules.d/60-econova-printer.rules >/dev/null

sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --action=add || true
sudo chmod 666 /dev/usb/lp* 2>/dev/null || true
sudo chmod 666 /dev/bus/usb/*/* 2>/dev/null || true

echo "==> Printer nodes"
ls -l /dev/usb/lp* 2>/dev/null || echo "  no /dev/usb/lp* yet (libusb path will be used)"
lsusb | grep -i -E 'print|pos|thermal|epson|xprinter|rongta|gprinter|zj' || lsusb || true

if [ -f "${ROOT}/scripts/${SERVICE_NAME}.service" ] && [ -f "/etc/systemd/system/${SERVICE_NAME}.service" ]; then
  echo "==> Refreshing ${SERVICE_NAME} groups and restarting"
  NODE_BIN="$(command -v node)"
  sed -e "s|__USER__|${USER_NAME}|g" \
      -e "s|__DIR__|${ROOT}|g" \
      -e "s|__NODE__|${NODE_BIN}|g" \
      "${ROOT}/scripts/${SERVICE_NAME}.service" \
    | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2
  sudo systemctl --no-pager --lines=8 status "$SERVICE_NAME" || true
fi

echo
echo "Done. Print again from the kiosk. If it still says permission denied, unplug the printer, plug it back in, then retry."
