// Shared kiosk visit keys. Home / Start Recycling always begin empty;
// returning shoppers load points only after they scan a QR receipt.
const SESSION_KEYS = [
  "voucherID",
  "returnVoucherID",
  "totalPoints",
  "sessionItems",
  "pendingInsert",
  "dispenseName",
  "dispenseSku",
  "dispenseCoil",
  "resumeVisit",
];

export function clearKioskSession() {
  SESSION_KEYS.forEach((key) => sessionStorage.removeItem(key));
}

export function markReturnVisit(voucherID, points) {
  sessionStorage.setItem("returnVoucherID", voucherID);
  sessionStorage.setItem("totalPoints", String(points ?? 0));
  sessionStorage.setItem("resumeVisit", "1");
}

export function takeReturnVisit() {
  const ok = sessionStorage.getItem("resumeVisit") === "1";
  sessionStorage.removeItem("resumeVisit");
  return ok;
}

// HTTPS camera scan on Hostinger comes back to the Pi insert page with these
// query flags, because sessionStorage does not cross from matarix.store.
export function captureReturnFromQuery() {
  const params = new URLSearchParams(location.search);
  const voucher = String(params.get("voucher") || params.get("id") || "").trim();
  if (!voucher) return false;
  markReturnVisit(voucher, params.get("points"));
  const page = location.pathname.split("/").pop() || "insert.html";
  history.replaceState({}, "", page);
  return true;
}
