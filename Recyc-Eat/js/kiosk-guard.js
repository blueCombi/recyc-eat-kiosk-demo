// kiosk-guard.js
// Honors two live settings on public kiosk screens: closed-for-use, and
// the idle timeout that sends a forgotten session back to the home screen.
import { loadKioskSettings, DEFAULT_SETTINGS } from "./kiosk-settings-data.js";

const page = location.pathname.split("/").pop() || "recycling.html";
const HOME = "recycling.html";

// Let a visit already in motion finish even if staff close the kiosk.
const ALLOW_WHEN_CLOSED = new Set([
  HOME,
  "dispensingfood.html",
  "foodrewardready.html",
  "printcomplete.html",
  "printreceipt.html",
  "login.html",
]);

// Don't yank the user off a screen that is already finishing the visit.
const SKIP_IDLE = new Set([
  HOME,
  "dispensingfood.html",
  "foodrewardready.html",
  "printcomplete.html",
  "login.html",
]);

let settings = DEFAULT_SETTINGS;
try {
  settings = await loadKioskSettings();
} catch (err) {
  console.error("Could not load kiosk settings:", err);
}

if (!settings.kioskOpen && !ALLOW_WHEN_CLOSED.has(page)) {
  location.replace(HOME);
} else if (!SKIP_IDLE.has(page)) {
  const ms = Math.max(30, settings.sessionTimeout || 90) * 1000;
  let timer = null;

  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { location.href = HOME; }, ms);
  };

  ["pointerdown", "keydown", "touchstart"].forEach((type) => {
    document.addEventListener(type, arm, { passive: true });
  });
  arm();
}
