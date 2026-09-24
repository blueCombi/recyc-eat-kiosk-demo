/**
 * scanner-bridge.js
 * Listens for a USB 2D scanner over:
 *   - new serial/COM ports (USB Virtual Com mode)
 *   - HID vendor interfaces (some OEM "USB" modes)
 * and pushes decoded text to WebSocket clients + HTTP subscribers.
 */
const { SerialPort } = require("serialport");
const { ReadlineParser } = require("@serialport/parser-readline");
const HID = require("node-hid");
const { WebSocketServer } = require("ws");

const SCANNER_VIDS = new Set([
  0x3151, // Yichip / some OEM modules
  0x1a86, // CH340 (USB-serial adapters)
  0x067b, // Prolific
  0x0403, // FTDI
  0x1eab, // Newland family (common)
  0x05e0, // Symbol / Zebra
]);

function createScannerBridge({ server, onScan }) {
  const clients = new Set();
  const state = {
    mode: "searching",
    detail: "Waiting for scanner…",
    lastScan: null,
    ports: [],
    hidOpen: 0,
  };

  const openPorts = new Map();
  const openHids = [];
  let knownPorts = new Set();

  const wss = new WebSocketServer({ server, path: "/ws/scanner" });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "status", ...state }));
    ws.on("close", () => clients.delete(ws));
  });

  function broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(raw);
    }
  }

  function setStatus(mode, detail) {
    state.mode = mode;
    state.detail = detail;
    broadcast({ type: "status", ...state });
  }

  function emitScan(text, source) {
    const payload = String(text || "").replace(/[\r\n]+/g, "").trim();
    if (!payload || payload.length < 3) return;
    state.lastScan = { text: payload, source, at: Date.now() };
    console.log(`[scanner] ${source}: ${payload}`);
    broadcast({ type: "scan", text: payload, source });
    if (typeof onScan === "function") onScan(payload, source);
  }

  function asciiFromHid(buf) {
    let out = "";
    for (const b of buf) {
      if (b >= 32 && b < 127) out += String.fromCharCode(b);
    }
    return out.trim();
  }

  async function refreshPorts() {
    const list = await SerialPort.list();
    state.ports = list.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || "",
      vendorId: p.vendorId || "",
      productId: p.productId || "",
      friendlyName: p.friendlyName || p.pnpId || "",
    }));

    const now = new Set(list.map((p) => p.path));

    // Close removed ports
    for (const path of [...openPorts.keys()]) {
      if (!now.has(path)) {
        try {
          openPorts.get(path).close();
        } catch {
          /* ignore */
        }
        openPorts.delete(path);
      }
    }

    for (const portInfo of list) {
      const path = portInfo.path;
      if (openPorts.has(path)) continue;

      // Skip long-lived Bluetooth serial links unless they just appeared
      const isBluetooth = /BTHENUM|Bluetooth/i.test(portInfo.pnpId || "")
        || /Bluetooth/i.test(portInfo.friendlyName || "");
      const isNew = !knownPorts.has(path);
      const vid = portInfo.vendorId
        ? parseInt(String(portInfo.vendorId).replace(/^0x/i, ""), 16)
        : null;
      const interestingVid = vid != null && SCANNER_VIDS.has(vid);
      const looksUsbSerial = /USB|CH340|Serial|CDC|QR|Scan|Barcode/i.test(
        `${portInfo.manufacturer || ""} ${portInfo.friendlyName || ""} ${portInfo.pnpId || ""}`,
      );

      if (isBluetooth && !isNew) continue;
      if (!isNew && !interestingVid && !looksUsbSerial) continue;

      // Try common baud rates for Virtual Com scanners
      const baudRates = [9600, 115200, 57600];
      let opened = null;
      for (const baudRate of baudRates) {
        try {
          const port = new SerialPort({ path, baudRate, autoOpen: false });
          await new Promise((resolve, reject) => {
            port.open((err) => (err ? reject(err) : resolve()));
          });
          opened = { port, baudRate };
          break;
        } catch {
          /* try next baud */
        }
      }

      if (!opened) continue;

      const { port, baudRate } = opened;
      const parser = port.pipe(new ReadlineParser({ delimiter: /[\r\n]+/ }));
      parser.on("data", (line) => emitScan(line, `${path}@${baudRate}`));
      port.on("error", (err) => {
        console.warn(`[scanner] ${path} error:`, err.message);
        try {
          port.close();
        } catch {
          /* ignore */
        }
        openPorts.delete(path);
      });
      openPorts.set(path, port);
      setStatus(
        "serial",
        `Listening on ${path} (${baudRate} baud). Scan a receipt QR.`,
      );
      console.log(`[scanner] opened ${path} at ${baudRate}`);
    }

    knownPorts = now;
  }

  function refreshHid() {
    // Close and reopen keyboard / scanner-like HID interfaces only.
    // Ignore YICHIP wireless mouse dongles (VID 3151 mouse/consumer) — they are
    // not barcode scanners and were giving a false "connected" status.
    while (openHids.length) {
      const dev = openHids.pop();
      try {
        dev.close();
      } catch {
        /* ignore */
      }
    }

    let opened = 0;
    const devices = HID.devices().filter((d) => {
      if (d.usagePage === 1 && d.usage === 6) return true; // HID keyboard
      if (d.usagePage === 0x8c) return true; // USB HID POS barcode page
      // Vendor page, but skip known wireless mouse chip
      if (d.usagePage >= 0xff00 && !(d.vendorId === 0x3151 && d.productId === 0x1002)) {
        return true;
      }
      return false;
    });

    for (const info of devices) {
      try {
        const dev = new HID.HID(info.path);
        let buf = "";
        let lastAt = 0;
        let flushTimer = null;
        dev.on("data", (data) => {
          const chunk = asciiFromHid(data);
          if (!chunk) return;
          const now = Date.now();
          if (now - lastAt > 120) buf = "";
          lastAt = now;
          buf += chunk;
          if (flushTimer) clearTimeout(flushTimer);
          flushTimer = setTimeout(() => {
            if (buf.length >= 6) {
              emitScan(buf, `hid:${info.vendorId.toString(16)}`);
              buf = "";
            }
          }, 80);
        });
        dev.on("error", () => {
          try {
            dev.close();
          } catch {
            /* ignore */
          }
        });
        openHids.push(dev);
        opened += 1;
      } catch {
        /* device busy */
      }
    }
    state.hidOpen = opened;
    if (opened) {
      setStatus("hid", `Listening on ${opened} HID keyboard/scanner interface(s).`);
    } else if (!openPorts.size) {
      setStatus(
        "searching",
        "Windows does not see a barcode scanner yet. Check USB (+ 5V DC if available), then unplug/replug.",
      );
    }
  }

  // Seed known ports so we only auto-open newly appearing ones + USB-looking ones
  SerialPort.list()
    .then((list) => {
      knownPorts = new Set(list.map((p) => p.path));
      // Still try USB-looking ports immediately
      return refreshPorts();
    })
    .catch((err) => console.warn("[scanner] port list failed:", err.message));

  refreshHid();
  setInterval(() => {
    refreshPorts().catch(() => {});
    refreshHid();
  }, 2500);

  if (!openPorts.size && !state.hidOpen) {
    setStatus(
      "searching",
      "No scanner keyboard/COM yet. Use the setup page, or plug USB (+ DC power if needed).",
    );
  }

  return {
    getStatus: () => ({ ...state }),
    emitScan,
  };
}

module.exports = { createScannerBridge };
