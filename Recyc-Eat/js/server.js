/**
 * server.js
 * Local kiosk host + USB thermal printer + 2D scanner bridge.
 *
 * From the project root:
 *   npm run print-server
 *
 * Then open:
 *   http://localhost:4000/html/recycling.html
 * Scanner setup:
 *   http://localhost:4000/html/scanner-setup.html
 */
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { printVoucher } = require("./print-voucher");
const { createScannerBridge } = require("./scanner-bridge");

const app = express();
const ROOT = path.join(__dirname, "..");

app.use(cors());
app.use(express.json());
app.use(express.static(ROOT));

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "econova-print" });
});

app.get("/api/scanner/status", (_req, res) => {
  res.json(scanner.getStatus());
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

const PORT = 4000;
const server = http.createServer(app);
const scanner = createScannerBridge({ server });

server.listen(PORT, () => {
  console.log(`Kiosk + print + scanner bridge at http://localhost:${PORT}`);
  console.log(`Kiosk:  http://localhost:${PORT}/html/recycling.html`);
  console.log(`Setup:  http://localhost:${PORT}/html/scanner-setup.html`);
  console.log(`Scan:   http://localhost:${PORT}/html/qrscan.html`);
});
