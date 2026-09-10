/**
 * print-button-snippet.js
 * Browser helper the print screen uses to talk to the local print server.
 */
export const PRINT_API = "http://localhost:4000/api/print";

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
  const response = await fetch(PRINT_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: Number(points) || 0,
      itemsRecycled: Number(itemsRecycled) || countSessionItems(items),
      items: Array.isArray(items) ? items : [],
      voucherCode,
      redeemUrl: redeemUrl || voucherCode,
    }),
  });

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
