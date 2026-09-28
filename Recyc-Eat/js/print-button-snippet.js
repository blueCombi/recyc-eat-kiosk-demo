/**
 * print-button-snippet.js
 * Browser helper the print screen uses to talk to the local print server.
 * The thermal printer stays on the kiosk PC. Hostinger only serves the website.
 * Optional override: localStorage.setItem("econovaPrintApi", "http://127.0.0.1:4000/api/print")
 */
const PRINT_TIMEOUT_MS = 4000;

export function getPrintApi() {
  try {
    const override = localStorage.getItem("econovaPrintApi");
    if (override) return override;
  } catch {
    /* ignore */
  }

  const { hostname, port, origin } = location;
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    if (port === "4000") return `${origin}/api/print`;
  }
  return "http://127.0.0.1:4000/api/print";
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
