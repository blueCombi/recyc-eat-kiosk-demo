// item-types.js
// The bin reports plastic as SMALL / MEDIUM / LARGE, and cans as one class
// (size ANY). Labels, receipt lines and admin point fields all come from here.

export const ITEM_TYPES = [
  {
    key: "plastic_small",
    material: "PLASTIC",
    size: "SMALL",
    label: "Small Plastic Bottle",
    settingsKey: "pointsPlasticSmall",
    points: 1,
    img: "../images/bottle.png",
    alt: "Small plastic bottle",
  },
  {
    key: "plastic_medium",
    material: "PLASTIC",
    size: "MEDIUM",
    label: "Medium Plastic Bottle",
    settingsKey: "pointsPlasticMedium",
    points: 2,
    img: "../images/bottle.png",
    alt: "Medium plastic bottle",
  },
  {
    key: "plastic_large",
    material: "PLASTIC",
    size: "LARGE",
    label: "Large Plastic Bottle",
    settingsKey: "pointsPlasticLarge",
    points: 3,
    img: "../images/plasticbottle.png",
    alt: "Large plastic bottle",
  },
  {
    key: "aluminum_can",
    material: "CAN",
    size: "ANY",
    label: "Aluminum Can",
    settingsKey: "pointsCan",
    settingsDetail: "Any size.",
    points: 7,
    img: "../images/can.png",
    alt: "Aluminum can",
  },
];

export const ITEM_POINT_FIELDS = [...new Set(ITEM_TYPES.map((item) => item.settingsKey))];

// One admin row per point value. Cans share a single field for every size.
export function pointSettingsRows() {
  const seen = new Set();
  const rows = [];
  ITEM_TYPES.forEach((item) => {
    if (seen.has(item.settingsKey)) return;
    seen.add(item.settingsKey);
    rows.push({
      settingsKey: item.settingsKey,
      label: item.settingsLabel || item.label,
      detail: item.settingsDetail || `Bin reports ${item.material} at ${item.size} size.`,
      points: item.points,
    });
  });
  return rows;
}

export const DEFAULT_ITEM_POINTS = ITEM_TYPES.reduce((points, item) => {
  points[item.key] = item.points;
  return points;
}, {});

export function itemTypeByKey(key) {
  return ITEM_TYPES.find((item) => item.key === key) || null;
}

// The serial line carries the raw words the ESP32 printed, so normalise before
// matching. An unknown pair means the bin and this table disagree — callers
// treat that the same as a rejected item rather than awarding stray points.
export function itemTypeFor(material, size) {
  const wantMaterial = String(material || "").trim().toUpperCase();
  const wantSize = String(size || "").trim().toUpperCase();
  if (wantMaterial === "CAN") {
    return ITEM_TYPES.find((item) => item.material === "CAN") || null;
  }
  return (
    ITEM_TYPES.find(
      (item) => item.material === wantMaterial && item.size === wantSize,
    ) || null
  );
}

// Firestore rows written before the bin could tell sizes apart still carry the
// old keys. Kept so Items Collected and the receipt can label them.
const LEGACY_LABELS = {
  small_bottle: "Small Plastic Bottle",
  big_bottle: "Large Plastic Bottle",
  aluminum_can: "Aluminum Can",
  can_small: "Aluminum Can",
  can_medium: "Aluminum Can",
  can_large: "Aluminum Can",
};

export function labelForKey(key) {
  return itemTypeByKey(key)?.label || LEGACY_LABELS[key] || "Item";
}
