// redemption-history-data.js
// Reads the redemptions the kiosk logged when it dispensed food.
import { db } from "./firebase-config.js";
import { localDateKey } from "./date-utils.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// reward_type is the SKU (or an older "canned_food" key); prefer reward_name
// without needing a lookup table for every reward added later
function rewardLabel(type) {
  const key = String(type || "").trim();
  if (!key) return "Reward";

  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function loadRedemptions() {
  const snap = await getDocs(collection(db, "redemptions"));

  const rows = snap.docs.reduce((acc, doc) => {
    const entry = doc.data();
    if (!entry.redeemed_at) return acc;

    const when = new Date(entry.redeemed_at);
    if (Number.isNaN(when.getTime())) return acc;

    acc.push({
      id: doc.id,
      receiptId: entry.voucher_id || doc.id,
      item: entry.reward_name || rewardLabel(entry.reward_type),
      rewardType: entry.reward_type || "",
      points: Number(entry.points_used || 0),
      date: entry.redeemed_at,
      dateKey: localDateKey(when),
      // redeemReward() only writes this document after the points cleared and
      // the can was released, so anything stored here is a finished redemption
      status: "completed",
    });
    return acc;
  }, []);

  rows.sort((a, b) => new Date(b.date) - new Date(a.date));   // newest first
  return rows;
}
