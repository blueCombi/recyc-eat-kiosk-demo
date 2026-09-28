// Shared defaults and checks for kiosk settings, kept free of Firebase.
import {
  ITEM_TYPES,
  ITEM_POINT_FIELDS,
  DEFAULT_ITEM_POINTS,
} from "./item-types.js";

const POINT_DEFAULTS = ITEM_TYPES.reduce((fields, item) => {
  fields[item.settingsKey] = item.points;
  return fields;
}, {});

export const DEFAULT_SETTINGS = {
  ...POINT_DEFAULTS,
  redemptionThreshold: 50,
  minRedemption: 30,
  maxRedemption: 150,
  rewardMealPoints: 50,
  rewardSnackPoints: 30,
  availableRewards: "Spaghetti pack\nCanned sardines\nCanned tuna\nCorned beef",
  kioskOpen: true,
  autoPrint: true,
  sessionTimeout: 90,
  lowStockAlert: 15,
};

const INT_FIELDS = [
  ...ITEM_POINT_FIELDS,
  "redemptionThreshold",
  "minRedemption",
  "maxRedemption",
  "rewardMealPoints",
  "rewardSnackPoints",
  "sessionTimeout",
  "lowStockAlert",
];

// Saved settings from before the bin reported sizes only had three point
// fields. Carry those values over so nobody's tuned values reset to default;
// the three new sizes start on the defaults above.
const LEGACY_POINT_FIELDS = {
  pointsPlasticSmall: "pointsSmallBottle",
  pointsPlasticLarge: "pointsBigBottle",
  pointsCanMedium: "pointsCan",
};

function migrateLegacyPoints(raw, next) {
  Object.entries(LEGACY_POINT_FIELDS).forEach(([field, legacyField]) => {
    if (raw?.[field] != null) return;
    const legacy = Number(raw?.[legacyField]);
    if (Number.isFinite(legacy) && legacy > 0) next[field] = Math.round(legacy);
  });
}

export function sanitizeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS, ...(raw || {}) };

  migrateLegacyPoints(raw, next);

  INT_FIELDS.forEach((key) => {
    const n = Number(next[key]);
    next[key] = Number.isFinite(n) ? Math.round(n) : DEFAULT_SETTINGS[key];
  });

  next.kioskOpen = Boolean(next.kioskOpen);
  next.autoPrint = Boolean(next.autoPrint);
  next.availableRewards = String(next.availableRewards || "").trim()
    || DEFAULT_SETTINGS.availableRewards;

  // The old field names are not written back, so a saved doc drops them.
  Object.values(LEGACY_POINT_FIELDS).forEach((legacyField) => {
    delete next[legacyField];
  });

  return next;
}

export function validateSettings(data) {
  if (ITEM_POINT_FIELDS.some((key) => data[key] < 1)) {
    return "Item points must be at least 1.";
  }
  if (data.redemptionThreshold < 1) {
    return "The redemption threshold must be at least 1.";
  }
  if (data.minRedemption > data.maxRedemption) {
    return "Minimum redemption cannot exceed maximum.";
  }
  if (data.sessionTimeout < 30 || data.sessionTimeout > 600) {
    return "Idle timeout must be between 30 and 600 seconds.";
  }
  if (data.lowStockAlert < 1) {
    return "The low-stock alert must be at least 1.";
  }
  return null;
}

export function pointsFromSettings(data) {
  const points = { threshold: data.redemptionThreshold };
  ITEM_TYPES.forEach((item) => {
    const value = Number(data[item.settingsKey]);
    points[item.key] = Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_ITEM_POINTS[item.key];
  });
  return points;
}
