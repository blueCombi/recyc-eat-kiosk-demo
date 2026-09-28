#!/usr/bin/env bash
#
# pi-setup.sh — prepare a Raspberry Pi to run the EcoNova kiosk.
#
# Installs Node and the USB build libraries, grants the serial and thermal
# printer access the bridges need, installs this project's dependencies for the
# Pi's own architecture, and registers the kiosk server so it survives a reboot.
#
# Run from the project root on the Pi, as your normal user (not with sudo):
#   bash scripts/pi-setup.sh
#
# Options:
#   --no-service   set everything up but skip the systemd service
#   --clean        delete node_modules before installing
#
set -euo pipefail

NODE_MAJOR=20
MIN_NODE_MAJOR=18          # express 5 will not run on anything older
SERVICE_NAME=econova-kiosk
INSTALL_SERVICE=1
CLEAN=0
ADDED_GROUPS=0

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m !  %s\033[0m\n' "$1" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --no-service) INSTALL_SERVICE=0 ;;
    --clean)      CLEAN=1 ;;
    -h|--help)    sed -n '3,15p' "$0"; exit 0 ;;
    *)            die "Unknown option: $arg" ;;
  esac
done

# ── sanity checks ────────────────────────────────────────────────
[ "$(uname -s)" = "Linux" ] \
  || die "This runs on the Raspberry Pi, not on the Windows dev machine."

[ "$(id -u)" -ne 0 ] \
  || die "Run as your normal user, without sudo. Installing npm packages as root leaves them unreadable to the service."

command -v sudo >/dev/null || die "sudo is not installed."

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
grep -q '"print-server"' package.json 2>/dev/null \
  || die "Run this from the kiosk project: package.json with the print-server script was not found in $ROOT."

USER_NAME="$(id -un)"

# ── system packages ──────────────────────────────────────────────
# libudev and libusb are what serialport, node-hid and escpos-usb compile
# against when no prebuilt binary matches the Pi.
say "Installing build tools and USB libraries"
sudo apt-get update
sudo apt-get install -y curl git build-essential libudev-dev libusb-1.0-0-dev

# ── Node ─────────────────────────────────────────────────────────
need_node=1
if command -v node >/dev/null; then
  have="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$have" -ge "$MIN_NODE_MAJOR" ]; then
    need_node=0
    say "Node $(node -v) is already suitable"
  else
    warn "Node $(node -v) is too old; replacing it with Node ${NODE_MAJOR}."
  fi
fi

if [ "$need_node" -eq 1 ]; then
  say "Installing Node ${NODE_MAJOR} LTS"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# ── device access ────────────────────────────────────────────────
# dialout: the ESP32 serial ports. plugdev and lp: the USB thermal printer.
say "Granting serial and printer access to ${USER_NAME}"
for group in dialout plugdev lp; do
  if ! getent group "$group" >/dev/null; then
    continue
  fi
  if id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx "$group"; then
    echo "  already in $group"
  else
    sudo usermod -aG "$group" "$USER_NAME"
    echo "  added to $group"
    ADDED_GROUPS=1
  fi
done

# escpos-usb talks to the printer through libusb, which needs write access to the
# raw USB device. Match the USB printer class (07) rather than one model's IDs.
PRINTER_RULE=/etc/udev/rules.d/60-econova-printer.rules
if [ -f "$PRINTER_RULE" ]; then
  echo "  printer udev rule already in place"
else
  say "Adding a udev rule for the USB thermal printer"
  printf '%s\n' \
    '# EcoNova kiosk: let the plugdev group use a USB class-07 (printer) device,' \
    '# so the print server does not have to run as root.' \
    'SUBSYSTEM=="usb", ENV{ID_USB_INTERFACES}=="*:0701*:*", MODE="0660", GROUP="plugdev"' \
    | sudo tee "$PRINTER_RULE" >/dev/null
  sudo udevadm control --reload-rules
  sudo udevadm trigger
fi

# ── project dependencies ─────────────────────────────────────────
# A node_modules copied from Windows holds win32 binaries that will not load
# here, and npm will not replace them on its own because the versions match.
if [ "$CLEAN" -eq 1 ]; then
  say "Removing node_modules (--clean)"
  rm -rf node_modules
elif [ -d node_modules ]; then
  if ls node_modules/@serialport/bindings-cpp/prebuilds 2>/dev/null | grep -q '^linux'; then
    echo "  existing node_modules looks native to this machine"
  else
    warn "node_modules was built for another platform; removing it."
    rm -rf node_modules
  fi
fi

say "Installing project dependencies"
if [ -f package-lock.json ]; then
  npm ci || npm install
else
  npm install
fi

# ── service ──────────────────────────────────────────────────────
if [ "$INSTALL_SERVICE" -eq 1 ]; then
  say "Installing the ${SERVICE_NAME} service"
  NODE_BIN="$(command -v node)"
  UNIT_SRC="${ROOT}/scripts/${SERVICE_NAME}.service"
  [ -f "$UNIT_SRC" ] || die "Missing $UNIT_SRC"

  sed -e "s|__USER__|${USER_NAME}|g" \
      -e "s|__DIR__|${ROOT}|g" \
      -e "s|__NODE__|${NODE_BIN}|g" \
      "$UNIT_SRC" \
    | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null

  sudo systemctl daemon-reload
  sudo systemctl enable "$SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  sleep 2
  sudo systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
fi

# ── what to do next ──────────────────────────────────────────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
ADDRESS="${IP:-<pi-ip-address>}"

say "Setup finished"
echo "  Kiosk, open this on the tablet:  http://${ADDRESS}:4000/html/recycling.html"
echo "  Check both ESP32 boards:         http://${ADDRESS}:4000/html/hardware-setup.html"
echo
echo "  Live server log:   sudo journalctl -u ${SERVICE_NAME} -f"
echo "  Stop / start:      sudo systemctl stop ${SERVICE_NAME}"
echo "  Boards seen by OS: ls /dev/ttyUSB* /dev/ttyACM*"

if [ -z "$IP" ]; then
  warn "This Pi has no network address yet. A Pi 3 is 2.4 GHz only, so check it is not being pointed at a 5 GHz SSID."
fi

if [ "$ADDED_GROUPS" -eq 1 ]; then
  warn "Group membership changed. Reboot before the serial ports will open: sudo reboot"
fi
