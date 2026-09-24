/**
 * Listen on YICHIP / possible scanner HID interfaces and dump reports.
 * Run: node Recyc-Eat/js/probe-scanner.js
 * Then scan a barcode/QR while this is running.
 */
const HID = require("node-hid");

const TARGET_VID = 0x3151;
const SECONDS = 45;

function asciiPreview(buf) {
  return [...buf]
    .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
    .join("");
}

const devices = HID.devices().filter((d) => d.vendorId === TARGET_VID);
if (!devices.length) {
  console.error("No VID_3151 device found. Unplug/replug the scanner USB and retry.");
  process.exit(1);
}

console.log(`Opening ${devices.length} HID interface(s). Scan something in the next ${SECONDS}s...\n`);

const open = [];
for (const info of devices) {
  try {
    const dev = new HID.HID(info.path);
    const label = `iface=${info.interface} usagePage=0x${info.usagePage.toString(16)} usage=${info.usage}`;
    console.log("Listening:", label);
    dev.on("data", (data) => {
      const hex = Buffer.from(data).toString("hex");
      const ascii = asciiPreview(data);
      console.log(`[${new Date().toISOString()}] ${label}`);
      console.log(`  hex:   ${hex}`);
      console.log(`  ascii: ${ascii}`);
    });
    dev.on("error", (err) => console.error("HID error:", label, err.message));
    open.push(dev);
  } catch (err) {
    console.error("Could not open", info.path, err.message);
  }
}

if (!open.length) {
  console.error("Opened zero interfaces.");
  process.exit(1);
}

setTimeout(() => {
  console.log("\nDone listening.");
  open.forEach((d) => {
    try {
      d.close();
    } catch {
      /* ignore */
    }
  });
  process.exit(0);
}, SECONDS * 1000);
