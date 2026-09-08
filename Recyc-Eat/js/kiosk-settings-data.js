// kiosk-settings-data.js
// One Firestore document drives the admin form and the live kiosk.
import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  validateSettings,
  pointsFromSettings,
} from "./kiosk-settings-rules.js";

export { DEFAULT_SETTINGS, sanitizeSettings, validateSettings, pointsFromSettings };

const SETTINGS_REF = doc(db, "kiosk_settings", "live");

let cached = null;

export async function loadKioskSettings() {
  if (cached) return cached;

  const snap = await getDoc(SETTINGS_REF);
  cached = snap.exists()
    ? sanitizeSettings(snap.data())
    : { ...DEFAULT_SETTINGS };
  return cached;
}

export async function saveKioskSettings(raw) {
  const data = sanitizeSettings(raw);
  const problem = validateSettings(data);
  if (problem) throw new Error(problem);

  await setDoc(SETTINGS_REF, {
    ...data,
    updated_at: new Date().toISOString(),
  });
  cached = data;
  return data;
}

export function applySettingsToPoints(POINTS, data) {
  Object.assign(POINTS, pointsFromSettings(data));
  return POINTS;
}
