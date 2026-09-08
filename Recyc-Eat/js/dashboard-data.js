// dashboard-data.js
// Pulls real data from Firestore for the Dashboard Overview page.
import { db } from "./firebase-config.js";
import { localDateKey } from "./date-utils.js";
import { loadKioskSettings, DEFAULT_SETTINGS } from "./kiosk-settings-data.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ── helpers ─────────────────────────────────────────────────── */

// A "session" doc's items array can look slightly different depending on
// how insert.html writes it. This tries the common field names so totals
// don't silently come out as 0.
function sumItemQty(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce(
    (sum, it) => sum + Number(it?.qty ?? it?.quantity ?? it?.count ?? 1),
    0
  );
}

function summarizeItems(items) {
  if (!Array.isArray(items) || !items.length) return "—";
  // the kiosk stores both a readable label and a machine key, so prefer
  // "Small Plastic Bottle" over "small_bottle"
  return items
    .map((it) => `${it?.qty ?? it?.quantity ?? 1} × ${it?.label || it?.name || it?.type || "item"}`)
    .join(", ");
}

function toDateKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return localDateKey(d);
}

function last7DayKeys() {
  const labels = [];
  const keys = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    keys.push(localDateKey(d));
    labels.push(d.toLocaleDateString("en-PH", { month: "short", day: "numeric" }));
  }
  return { labels, keys };
}

function stockStatus(qty, capacity, lowAt = 15) {
  if (qty <= 0) return "out";
  const ratio = capacity > 0 ? qty / capacity : 0;
  if (ratio <= 0.2 || qty <= lowAt) return "low";
  return "ok";
}

/* ── main export ─────────────────────────────────────────────── */

export async function loadDashboardData() {
  const [vouchersSnap, sessionsSnap, redemptionsSnap, inventorySnap, settings] = await Promise.all([
    getDocs(collection(db, "vouchers")),
    getDocs(collection(db, "sessions")),
    getDocs(collection(db, "redemptions")),
    getDocs(collection(db, "food_inventory")),
    loadKioskSettings().catch(() => DEFAULT_SETTINGS),
  ]);
  const lowAt = settings.lowStockAlert || DEFAULT_SETTINGS.lowStockAlert;

  const vouchers = vouchersSnap.docs.map((d) => d.data());
  const sessions = sessionsSnap.docs.map((d) => d.data());
  const redemptions = redemptionsSnap.docs.map((d) => d.data());
  const inventory = inventorySnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  /* Stat cards */
  const totalItems = sessions.reduce((sum, s) => sum + sumItemQty(s.items), 0);
  const totalRedemptions = redemptions.length;
  const totalParticipants = vouchers.length; // one voucher/QR = one kiosk participant
  const pointsInCirculation = vouchers
    .filter((v) => v.status === "active")
    .reduce((sum, v) => sum + Number(v.total_points || 0), 0);

  /* Inventory */
  const inventoryWithStatus = inventory.map((item) => {
    const qty = Number(item.qty || 0);
    const capacity = Number(item.capacity || 0);
    return { ...item, qty, capacity, status: stockStatus(qty, capacity, lowAt) };
  });
  const inventoryRemaining = inventoryWithStatus.reduce((sum, i) => sum + i.qty, 0);
  const lowStockItems = inventoryWithStatus.filter(
    (i) => i.status === "low" || i.status === "out"
  );

  /* Last 7 days chart */
  const { labels, keys } = last7DayKeys();
  const dayTotals = Object.fromEntries(keys.map((k) => [k, 0]));
  sessions.forEach((s) => {
    const key = toDateKey(s.session_date);
    if (key && key in dayTotals) dayTotals[key] += sumItemQty(s.items);
  });
  const dailySeries = { labels, items: keys.map((k) => dayTotals[k]) };

  /* Recent activity (sessions = collections, redemptions = redemptions) */
  const collectionActivity = sessions
    .filter((s) => s.session_date)
    .map((s) => ({
      when: s.session_date,
      type: "Collection",
      detail: summarizeItems(s.items),
      points: Number(s.points_earned || 0),
      receiptId: s.voucher_id || "—",
      status: "completed",
    }));

  const redemptionActivity = redemptions
    .filter((r) => r.redeemed_at)
    .map((r) => ({
      when: r.redeemed_at,
      type: "Redemption",
      detail: r.reward_type || "Reward",
      points: Number(r.points_used || 0),
      receiptId: r.voucher_id || "—",
      status: "completed",
    }));

  const recentActivity = [...collectionActivity, ...redemptionActivity]
    .sort((a, b) => new Date(b.when) - new Date(a.when))
    .slice(0, 6);

  return {
    totalItems,
    totalRedemptions,
    totalParticipants,
    pointsInCirculation: Math.max(pointsInCirculation, 0),
    inventoryRemaining,
    lowStockItems,
    inventory: inventoryWithStatus,
    dailySeries,
    recentActivity,
  };
}