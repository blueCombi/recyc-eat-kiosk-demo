/**
 * server.js
 * Runs on the kiosk host (Raspberry Pi): static pages, the USB thermal printer,
 * the QR scanner bridge, and the two ESP32 boards (sorting bin + vending coils).
 * The shopper-facing screen is a tablet that loads these pages over WiFi.
 *
 * From the project root:
 *   npm run print-server
 *
 * Then open, on the tablet or on the host:
 *   http://<host-address>:4000/html/recycling.html
 *   http://<host-address>:4000/html/hardware-setup.html   (board diagnostics)
 *
 * Set ECONOVA_ALLOW_SIM=1 to expose /api/bin/simulate for testing the kiosk
 * screens with no boards plugged in.
 */
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { printVoucher } = require("./print-voucher");
const { createHardwareBridge } = require("./hardware-bridge");
const { createScannerBridge } = require("./scanner-bridge");
const { startHardwareRelay } = require("./hardware-relay");

const relay = startHardwareRelay();

const app = express();
const ROOT = path.join(__dirname, "..");

app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.static(ROOT));

const server = http.createServer(app);

const hardware = createHardwareBridge({
  server,
  allowSimulation: process.env.ECONOVA_ALLOW_SIM === "1",
  onBroadcast: (message) => relay.pushEvent(message),
});

relay.attach({
  dispense: (coilNumber) => hardware.dispense(coilNumber),
  tare: () => hardware.tare(),
  print: (payload) => printVoucher(payload),
  getStatus: () => hardware.getStatus(),
});

// Both bridges walk the same COM port list, so let the boards identify
// themselves before the scanner starts opening ports it does not recognise.
let scanner = null;
hardware.ready().then(() => {
  scanner = createScannerBridge({ server });
});

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "econova-print" });
});

app.post("/api/print", async (req, res) => {
  const body = req.body || {};
  const voucherCode = String(body.voucherCode || "").trim();
  const redeemUrl = String(body.redeemUrl || voucherCode).trim();
  const points = asNumber(body.points, 0);
  const items = Array.isArray(body.items) ? body.items : [];
  const itemsRecycled = asNumber(body.itemsRecycled, 0);

  if (!voucherCode) {
    return res.status(400).json({
      success: false,
      error: "Missing voucherCode.",
    });
  }

  try {
    await printVoucher({
      points,
      itemsRecycled,
      items,
      voucherCode,
      redeemUrl,
    });
    console.log(`Printed voucher ${voucherCode} (${points} pts)`);
    res.json({ success: true });
  } catch (err) {
    console.error("Print failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/scanner/status", (_req, res) => {
  if (!scanner) {
    return res.json({ mode: "searching", detail: "Scanner bridge is still starting…" });
  }
  res.json(scanner.getStatus());
});

// ── hardware ─────────────────────────────────────────────────────
app.get("/api/hardware/status", (_req, res) => {
  res.json(hardware.getStatus());
});

// The redeem screen already debited the points and the coil stock, so a failure
// here is reported back but never retried automatically.
app.post("/api/dispense", async (req, res) => {
  const coilNumber = asNumber(req.body?.coilNumber, 0);
  const result = await hardware.dispense(coilNumber);
  res.status(result.success ? 200 : 502).json(result);
});

app.post("/api/bin/tare", (_req, res) => {
  const sent = hardware.tare();
  res.status(sent ? 200 : 502).json({
    success: sent,
    error: sent ? undefined : "Sorting bin is not connected.",
  });
});

app.post("/api/bin/simulate", (req, res) => {
  const result = hardware.simulate(req.body || {});
  res.status(result.success ? 200 : 403).json(result);
});

// The kiosk screen is often a tablet on the same WiFi rather than this PC, so
// print the addresses it should open. Windows Firewall has to allow inbound
// connections on this port for anything but localhost to reach it.
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => net.address);
}

const PORT = 4000;
server.listen(PORT, () => {
  console.log(`Kiosk + print server on port ${PORT}`);
  console.log(`  On this PC:  http://localhost:${PORT}/html/recycling.html`);

  const addresses = lanAddresses();
  if (addresses.length) {
    addresses.forEach((address) => {
      console.log(`  On a tablet: http://${address}:${PORT}/html/recycling.html`);
    });
  } else {
    console.log("  No network address yet — connect this PC to the kiosk WiFi.");
  }

  console.log(`  Scan page:   /html/qrscan.html`);
  console.log(`  Hardware:    /html/hardware-setup.html`);
});
