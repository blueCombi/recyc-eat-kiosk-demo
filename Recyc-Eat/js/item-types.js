// item-types.js
// One table for the six things the bin can accept. The sorting ESP32 reports a
// material (PLASTIC or CAN) and a size (SMALL, MEDIUM or LARGE); the kiosk
// labels, the receipt lines and the admin point fields all come from here so
// the hardware and the app can never drift apart.

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
    key: "can_small",
    material: "CAN",
    size: "SMALL",
    label: "Small Aluminum Can",
    settingsKey: "pointsCan",
    settingsLabel: "Aluminum Can",
    settingsDetail: "Any size.",
    points: 7,
    img: "../images/can.png",
    alt: "Small aluminum can",
  },
  {
    key: "can_medium",
    material: "CAN",
    size: "MEDIUM",
    label: "Medium Aluminum Can",
    settingsKey: "pointsCan",
    points: 7,
    img: "../images/can.png",
    alt: "Medium aluminum can",
  },
  {
    key: "can_large",
    material: "CAN",
    size: "LARGE",
    label: "Large Aluminum Can",
    settingsKey: "pointsCan",
    points: 7,
    img: "../images/canwitname.png",
    alt: "Large aluminum can",
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
  return (
    ITEM_TYPES.find(
      (item) => item.material === wantMaterial && item.size === wantSize,
    ) || null
  );
}

// Firestore rows written before the bin could tell sizes apart still carry the
// old three keys. Kept so Items Collected and the receipt can label them.
const LEGACY_LABELS = {
  small_bottle: "Small Plastic Bottle",
  big_bottle: "Large Plastic Bottle",
  aluminum_can: "Medium Aluminum Can",
};

export function labelForKey(key) {
  return itemTypeByKey(key)?.label || LEGACY_LABELS[key] || "Item";
}
