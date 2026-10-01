/**
 * print-voucher.js
 * Prints an EcoNova QR voucher on a USB ESC/POS thermal printer.
 *
 * Windows: the printer is owned by usbprint.sys, so receipts are sent
 * through the USBPRINT device interface (see print-windows-usbprint.ps1).
 * Other platforms: USB bulk transfer via the `usb` package.
 *
 * Run from the project root:
 *   node Recyc-Eat/js/server.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const escpos = require("escpos");

const getPixels = require("get-pixels");

const USBPRINT_SCRIPT = path.join(__dirname, "print-windows-usbprint.ps1");
const LOGO_PATH = path.join(__dirname, "..", "images", "logo.png");
const PRINTER_CLASS = 0x07;
const RECEIPT_WIDTH = 32;
const LOGO_WIDTH = 240;

let cachedLogo = undefined;

class MemoryAdapter {
  constructor() {
    this.chunks = [];
  }

  open(callback) {
    callback && callback(null);
    return this;
  }

  write(data, callback) {
    this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    callback && callback(null);
    return this;
  }

  close(callback) {
    callback && callback(null);
    return this;
  }

  toBuffer() {
    return Buffer.concat(this.chunks);
  }
}

function countItems(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  return items.reduce((sum, item) => {
    const qty = Number(item?.quantity ?? item?.qty ?? 1);
    return sum + (Number.isFinite(qty) ? qty : 0);
  }, 0);
}

function sumItemPoints(items) {
  if (!Array.isArray(items) || !items.length) return 0;
  return items.reduce((sum, item) => {
    const pts = Number(item?.points ?? item?.pts ?? 0);
    return sum + (Number.isFinite(pts) ? pts : 0);
  }, 0);
}

function wrapLines(text, width) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word.length > width ? word.slice(0, width) : word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function pairLine(left, right, width) {
  const l = String(left);
  const r = String(right);
  if (l.length + 1 + r.length > width) {
    const room = Math.max(8, width - r.length - 1);
    const clipped = l.length > room ? `${l.slice(0, Math.max(1, room - 1))}.` : l;
    const space = width - clipped.length - r.length;
    return space > 0 ? `${clipped}${" ".repeat(space)}${r}` : `${clipped} ${r}`.slice(0, width);
  }
  return `${l}${" ".repeat(width - l.length - r.length)}${r}`;
}

function printCentered(printer, text) {
  wrapLines(text, RECEIPT_WIDTH).forEach((line) => printer.text(line));
}

function resizePixels(pixels, targetWidth) {
  const srcW = pixels.shape[0];
  const srcH = pixels.shape[1];
  const srcC = pixels.shape[2];
  const width = targetWidth - (targetWidth % 8);
  const height = Math.max(8, Math.round((srcH * width) / srcW));
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / width));
      const sy = Math.min(srcH - 1, Math.floor((y * srcH) / height));
      const si = (sy * srcW + sx) * srcC;
      const di = (y * width + x) * 4;
      data[di] = pixels.data[si];
      data[di + 1] = pixels.data[si + 1];
      data[di + 2] = pixels.data[si + 2];
      data[di + 3] = srcC > 3 ? pixels.data[si + 3] : 255;
    }
  }

  return { data, shape: [width, height, 4] };
}

function loadReceiptLogo() {
  if (cachedLogo !== undefined) {
    return Promise.resolve(cachedLogo);
  }

  return new Promise((resolve) => {
    getPixels(LOGO_PATH, (err, pixels) => {
      if (err || !pixels) {
        cachedLogo = null;
        return resolve(null);
      }
      try {
        cachedLogo = new escpos.Image(resizePixels(pixels, LOGO_WIDTH));
      } catch {
        cachedLogo = null;
      }
      resolve(cachedLogo);
    });
  });
}

async function buildVoucherBytes({ points, itemsRecycled, items, voucherCode, redeemUrl }) {
  const code = String(voucherCode || "").trim();
  const qrPayload = String(redeemUrl || code).trim() || code;
  const totalPts = Number(points) || 0;
  const earnedPts = sumItemPoints(items) || totalPts;
  const sessionItems = Array.isArray(items) ? items : [];
  const now = new Date();
  const when = now.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const logo = await loadReceiptLogo();

  return new Promise((resolve, reject) => {
    const adapter = new MemoryAdapter();
    const printer = new escpos.Printer(adapter, { width: RECEIPT_WIDTH });

    adapter.open((err) => {
      if (err) return reject(err);

      try {
        printer.font("a").align("ct").style("NORMAL").size(0, 0);

        if (logo) {
          printer.raster(logo);
          printer.text(" ");
        } else {
          printer.style("b").size(1, 1).text("EcoNova");
          printer.style("NORMAL").size(0, 0);
          printer.text("Every Recycle Feeds.");
          printer.text(" ");
        }

        printer.style("b").size(1, 1).text("THANK YOU!");
        printer.style("NORMAL").size(0, 0);
        printCentered(printer, "You're helping the environment and earning rewards.");
        printer.drawLine();

        printer.align("lt").style("b").text("DATE");
        printer.style("NORMAL");
        wrapLines(when, RECEIPT_WIDTH).forEach((line) => printer.text(line));
        printer.style("b").text("RECEIPT ID");
        printer.style("NORMAL");
        wrapLines(code || "Not issued", RECEIPT_WIDTH).forEach((line) => printer.text(line));
        printer.drawLine();

        printer.style("b").text("ITEMS RECYCLED");
        printer.style("NORMAL");
        if (!sessionItems.length) {
          printer.text("No items recorded this visit.");
        } else {
          sessionItems.forEach((item) => {
            const n = Number(item?.quantity ?? item?.qty ?? 1) || 1;
            const label = item?.label || item?.name || item?.type || "Item";
            const itemPts = Number(item?.points ?? item?.pts ?? 0) || 0;
            printer.text(pairLine(`${n}x ${label}`, `+${itemPts} pts`, RECEIPT_WIDTH));
          });
        }
        printer.drawLine();

        printer.text(pairLine("Points earned", String(earnedPts), RECEIPT_WIDTH));
        printer.align("ct").style("b").text("TOTAL POINTS");
        printer.size(1, 1).text(String(totalPts));
        printer.style("NORMAL").size(0, 0);
        printer.drawLine();

        printer.align("ct").style("b").text("SCAN TO REDEEM");
        printer.style("NORMAL");
        printer.qrcode(qrPayload, 3, "M", 6);
        printer.text(" ");
        printCentered(printer, "Scan this code on your next visit.");
        printer.drawLine();

        printer.style("b");
        printCentered(printer, "Every Recycle Feeds");
        printer.style("NORMAL").text(" ").feed(2).cut().close((closeErr) => {
          if (closeErr) {
            return reject(new Error(`Printer command failed: ${closeErr.message || closeErr}`));
          }
          resolve(adapter.toBuffer());
        });
      } catch (printErr) {
        reject(new Error(`Printer command failed: ${printErr.message}`));
      }
    });
  });
}

function runPowershellFile(scriptPath, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...extraArgs],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (code === 0) {
        resolve(output);
        return;
      }
      const detail = output || `PowerShell exited ${code}`;
      reject(new Error(detail.split(/\r?\n/).filter(Boolean).pop() || detail));
    });
  });
}

async function sendWindowsUsbPrint(bytes) {
  const tmp = path.join(os.tmpdir(), `econova-voucher-${Date.now()}.bin`);
  fs.writeFileSync(tmp, bytes);
  try {
    await runPowershellFile(USBPRINT_SCRIPT, ["-BinPath", tmp]);
  } catch (err) {
    const msg = String(err.message || err);
    throw new Error(
      msg.includes("No USB printer")
        ? msg
        : `Windows USB print failed: ${msg}`,
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function describeUsbTarget(device, iface, alternate, endpoint) {
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    interfaceNumber: iface.interfaceNumber,
    endpointNumber: endpoint.endpointNumber,
    configurationValue: device.configuration?.configurationValue,
  };
}

function listPrinterTargets(devices) {
  const found = [];
  for (const device of devices) {
    const configs = device.configurations || [];
    for (const config of configs) {
      for (const iface of config.interfaces || []) {
        for (const alternate of iface.alternates || []) {
          if (alternate.interfaceClass !== PRINTER_CLASS) continue;
          const endpoint = (alternate.endpoints || []).find(
            (ep) => ep.direction === "out" && ep.type === "bulk",
          );
          if (!endpoint) continue;
          found.push({ device, config, iface, alternate, endpoint });
        }
      }
    }
  }
  return found;
}

function listLinuxLpPaths() {
  const dir = "/dev/usb";
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^lp\d+$/i.test(name))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function sendLinuxLp(bytes) {
  const paths = listLinuxLpPaths();
  if (!paths.length) {
    const err = new Error("NO_LP");
    err.code = "NO_LP";
    throw err;
  }
  let lastErr;
  for (const lp of paths) {
    try {
      fs.writeFileSync(lp, bytes);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function isAccessError(err) {
  const code = err && err.code;
  const msg = String(err && (err.message || err));
  return code === "EACCES"
    || code === "EPERM"
    || /permission denied|LIBUSB_ERROR_ACCESS|errno 13/i.test(msg);
}

function accessHint(msg) {
  if (!isAccessError({ message: msg })) return msg;
  return "The Pi can see the printer but cannot open it (permission denied). Run bash scripts/fix-printer.sh on the Pi, then print again.";
}

function sendClassicLibUsb(bytes) {
  const usbApi = require("usb");
  if (typeof usbApi.getDeviceList !== "function") {
    throw new Error("USB library mismatch: getDeviceList() is missing.");
  }

  const devices = usbApi.getDeviceList();
  let lastErr = new Error("No USB thermal printer found. Plug it in, power it on, then retry.");

  for (const device of devices) {
    let opened = false;
    try {
      device.open();
      opened = true;
    } catch (err) {
      lastErr = err;
      continue;
    }

    const interfaces = device.interfaces || [];
    for (const iface of interfaces) {
      const ifaceClass = iface.descriptor && iface.descriptor.bInterfaceClass;
      if (ifaceClass !== PRINTER_CLASS) continue;

      try {
        if (typeof iface.isKernelDriverActive === "function" && iface.isKernelDriverActive()) {
          iface.detachKernelDriver();
        }
      } catch {
        /* some hosts do not allow detach; usblp write is the fallback */
      }

      try {
        iface.claim();
      } catch (err) {
        lastErr = err;
        continue;
      }

      const endpoint = (iface.endpoints || []).find((ep) => ep.direction === "out");
      if (!endpoint) {
        try { iface.release(); } catch { /* ignore */ }
        continue;
      }

      return new Promise((resolve, reject) => {
        endpoint.transfer(bytes, (err) => {
          try { iface.release(true, () => { try { device.close(); } catch { /* ignore */ } }); }
          catch { try { device.close(); } catch { /* ignore */ } }
          if (err) reject(err);
          else resolve();
        });
      });
    }

    if (opened) {
      try { device.close(); } catch { /* ignore */ }
    }
  }

  throw lastErr;
}

async function sendLibUsb(bytes) {
  let usbApi;
  try {
    usbApi = require("usb");
  } catch (err) {
    throw new Error(`USB library is not available: ${err.message}`);
  }

  try {
    return await sendClassicLibUsb(bytes);
  } catch (classicErr) {
    const webusb = usbApi.usb;
    if (!webusb || typeof webusb.getDevices !== "function") {
      throw classicErr;
    }

    const devices = await webusb.getDevices();
    const targets = listPrinterTargets(devices);
    if (!targets.length) {
      throw classicErr;
    }

    const { device, config, iface, endpoint } = targets[0];
    const target = describeUsbTarget(device, iface, targets[0].alternate, endpoint);

    try {
      await device.open();
      try {
        await device.selectConfiguration(config.configurationValue);
      } catch {
        /* already selected */
      }
      await device.claimInterface(target.interfaceNumber);
      await device.transferOut(target.endpointNumber, bytes);
    } catch (err) {
      const msg = String(err.message || err);
      if (/incompatible driver/i.test(msg)) {
        throw new Error(
          "Windows USB Printing Support is blocking direct USB access. Receipts should use the USBPRINT path instead.",
        );
      }
      throw new Error(`Failed to send to the USB printer: ${accessHint(msg)}`);
    } finally {
      try {
        await device.releaseInterface(target.interfaceNumber);
      } catch {
        /* ignore */
      }
      try {
        await device.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function sendToPrinter(bytes) {
  if (process.platform === "win32") {
    return sendWindowsUsbPrint(bytes);
  }
  if (process.platform === "linux") {
    try {
      sendLinuxLp(bytes);
      return;
    } catch (err) {
      if (err && err.code !== "NO_LP") {
        try {
          await sendLibUsb(bytes);
          return;
        } catch {
          throw new Error(`Failed to send to the USB printer: ${accessHint(String(err.message || err))}`);
        }
      }
    }
  }
  return sendLibUsb(bytes);
}

async function printVoucher(payload) {
  const bytes = await buildVoucherBytes(payload);
  if (!bytes.length) {
    throw new Error("Nothing to print.");
  }
  await sendToPrinter(bytes);
}

module.exports = { printVoucher };
