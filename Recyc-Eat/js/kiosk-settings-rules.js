// Shared defaults and checks for kiosk settings, kept free of Firebase.

export const DEFAULT_SETTINGS = {
  pointsSmallBottle: 5,
  pointsBigBottle: 7,
  pointsCan: 5,
  redemptionThreshold: 50,
  minRedemption: 30,
  maxRedemption: 150,
  rewardMealPoints: 50,
  rewardSnackPoints: 30,
  availableRewards: "Tuna\nSardines",
  kioskOpen: true,
  autoPrint: true,
  sessionTimeout: 90,
  lowStockAlert: 15,
};

const INT_FIELDS = [
  "pointsSmallBottle",
  "pointsBigBottle",
  "pointsCan",
  "redemptionThreshold",
  "minRedemption",
  "maxRedemption",
  "rewardMealPoints",
  "rewardSnackPoints",
  "sessionTimeout",
  "lowStockAlert",
];

export function sanitizeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS, ...(raw || {}) };

  INT_FIELDS.forEach((key) => {
    const n = Number(next[key]);
    next[key] = Number.isFinite(n) ? Math.round(n) : DEFAULT_SETTINGS[key];
  });

  next.kioskOpen = Boolean(next.kioskOpen);
  next.autoPrint = Boolean(next.autoPrint);
  next.availableRewards = String(next.availableRewards || "").trim()
    || DEFAULT_SETTINGS.availableRewards;

  return next;
}

export function validateSettings(data) {
  if (data.pointsSmallBottle < 1 || data.pointsBigBottle < 1 || data.pointsCan < 1) {
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
  return {
    small_bottle: data.pointsSmallBottle,
    big_bottle:   data.pointsBigBottle,
    aluminum_can: data.pointsCan,
    threshold:    data.redemptionThreshold,
  };
}
