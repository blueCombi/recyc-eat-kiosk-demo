/**
 * print-button-snippet.js
 * Browser helper the print screen uses to talk to the local print server.
 * The thermal printer stays on the kiosk PC, which is also where the ESP32
 * boards plug in. Hostinger only serves the website.
 *
 * A tablet on the same WiFi works without setup as long as the kiosk is opened
 * from the PC's address, since the printer answers on the same host as the page.
 * Optional override: localStorage.setItem("econovaPrintApi", "http://192.168.1.50:4000/api/print")
 */
const PRINT_TIMEOUT_MS = 4000;
const PRINT_PORT = "4000";

export function getPrintApi() {
  try {
    const override = localStorage.getItem("econovaPrintApi");
    if (override) return override;
  } catch {
    /* ignore */
  }

  const { hostname, port, origin, protocol } = location;
  if (port === PRINT_PORT && protocol.startsWith("http")) return `${origin}/api/print`;
  if (protocol.startsWith("http") && (
    hostname === "localhost" || hostname === "127.0.0.1"
    || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)
  )) {
    return `http://${hostname}:${PRINT_PORT}/api/print`;
  }
  try {
    const hardware = localStorage.getItem("econovaHardwareApi");
    if (hardware) return `${hardware.replace(/\/+$/, "")}/api/print`;
  } catch {
    /* ignore */
  }
  return `http://127.0.0.1:${PRINT_PORT}/api/print`;
}

export const PRINT_API = getPrintApi();

export function countSessionItems(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const qty = Number(item?.quantity ?? item?.qty ?? 1);
    return sum + (Number.isFinite(qty) ? qty : 0);
  }, 0);
}

export async function printReceipt({
  points,
  itemsRecycled,
  items,
  voucherCode,
  redeemUrl,
}) {
  try {
    const { loadKioskSettings } = await import("./kiosk-settings-data.js");
    await loadKioskSettings();
  } catch {
    /* Pi URL not saved yet */
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRINT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(getPrintApi(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        points: Number(points) || 0,
        itemsRecycled: Number(itemsRecycled) || countSessionItems(items),
        items: Array.isArray(items) ? items : [],
        voucherCode,
        redeemUrl: redeemUrl || voucherCode,
      }),
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Printer did not respond in time.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  let result = {};
  try {
    result = await response.json();
  } catch {
    result = {};
  }

  if (!response.ok || !result.success) {
    throw new Error(result.error || `Print failed (${response.status})`);
  }

  return result;
}
