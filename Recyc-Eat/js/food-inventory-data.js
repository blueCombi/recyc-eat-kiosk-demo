// food-inventory-data.js
// Live canned-food stock for the admin page and the kiosk dispenser.
import { db, POINTS } from "./firebase-config.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  setDoc,
  updateDoc,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { loadKioskSettings, DEFAULT_SETTINGS } from "./kiosk-settings-data.js";

export const UNAVAILABLE_MESSAGE = "Sorry, this reward is temporarily unavailable.";

const INVENTORY = collection(db, "food_inventory");
const LOG = collection(db, "inventory_log");

const DEFAULT_ITEMS = [
  { id: "F-01", name: "Canned Meal A", sku: "CMA-01", qty: 86, capacity: 120, unit: "cans", loaded: true },
  { id: "F-02", name: "Canned Meal B", sku: "CMB-01", qty: 42, capacity: 100, unit: "cans", loaded: false },
  { id: "F-03", name: "Canned Meal C", sku: "CMC-01", qty: 18, capacity: 80, unit: "cans", loaded: false },
  { id: "F-04", name: "Snack Pack", sku: "SNP-01", qty: 7, capacity: 60, unit: "packs", loaded: false },
  { id: "F-05", name: "Rice Meal Box", sku: "RMB-01", qty: 0, capacity: 40, unit: "boxes", loaded: false },
  { id: "F-06", name: "Fruit Cup", sku: "FRC-01", qty: 55, capacity: 70, unit: "cups", loaded: false },
];

export function stockStatus(item, lowAt = 15) {
  const qty = Number(item?.qty) || 0;
  const capacity = Number(item?.capacity) || 0;
  if (qty <= 0) return "out";
  const ratio = capacity > 0 ? qty / capacity : 0;
  if (ratio <= 0.2 || qty <= lowAt) return "low";
  return "ok";
}

function normalizeItem(id, data, lowAt) {
  const qty = Math.max(0, Number(data?.qty) || 0);
  const capacity = Math.max(1, Number(data?.capacity) || 1);
  const item = {
    id,
    name: String(data?.name || "Unnamed item").trim() || "Unnamed item",
    sku: String(data?.sku || id).trim() || id,
    qty,
    capacity,
    unit: String(data?.unit || "cans").trim() || "cans",
    loaded: Boolean(data?.loaded),
    updated: data?.updated || null,
  };
  return { ...item, status: stockStatus(item, lowAt) };
}

async function lowStockThreshold() {
  try {
    const settings = await loadKioskSettings();
    return settings.lowStockAlert || DEFAULT_SETTINGS.lowStockAlert;
  } catch {
    return DEFAULT_SETTINGS.lowStockAlert;
  }
}

async function writeLog({ itemId, item, change, reason, voucherId = null }) {
  await addDoc(LOG, {
    at: new Date().toISOString(),
    itemId: itemId || null,
    item: item || "Item",
    change: Number(change) || 0,
    reason: reason || "Updated",
    voucher_id: voucherId,
  });
}

export async function ensureDefaultInventory() {
  const snap = await getDocs(INVENTORY);
  if (!snap.empty) return;

  const now = new Date().toISOString();
  const batch = writeBatch(db);
  DEFAULT_ITEMS.forEach((item) => {
    batch.set(doc(INVENTORY, item.id), {
      name: item.name,
      sku: item.sku,
      qty: item.qty,
      capacity: item.capacity,
      unit: item.unit,
      loaded: Boolean(item.loaded),
      updated: now,
    });
  });
  await batch.commit();
}

function skuKey(sku) {
  return String(sku || "").trim().toLowerCase();
}

function recency(item) {
  const t = new Date(item.updated || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function pickKeeper(group) {
  return [...group].sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    if (b.qty !== a.qty) return b.qty - a.qty;
    return recency(b) - recency(a);
  })[0];
}

async function mergeDuplicateSkus(items) {
  const groups = new Map();
  items.forEach((item) => {
    const key = skuKey(item.sku);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  const extras = [];
  groups.forEach((group) => {
    if (group.length < 2) return;
    const keeper = pickKeeper(group);
    group.forEach((item) => {
      if (item.id !== keeper.id) extras.push(item);
    });
  });

  if (!extras.length) return false;

  await Promise.all(extras.map(async (item) => {
    await deleteDoc(doc(INVENTORY, item.id));
    await writeLog({
      itemId: item.id,
      item: item.name,
      change: 0,
      reason: "Merged duplicate",
    });
  }));
  return true;
}

async function ensureOneLoaded(items) {
  if (items.some((item) => item.loaded)) return false;
  const candidate = items.find((item) => item.qty > 0) || items[0];
  if (!candidate) return false;
  await setLoadedItem(candidate.id);
  return true;
}

export async function loadInventory() {
  await ensureDefaultInventory();
  const lowAt = await lowStockThreshold();
  let snap = await getDocs(INVENTORY);
  let items = snap.docs.map((entry) => normalizeItem(entry.id, entry.data(), lowAt));

  if (await mergeDuplicateSkus(items)) {
    snap = await getDocs(INVENTORY);
    items = snap.docs.map((entry) => normalizeItem(entry.id, entry.data(), lowAt));
  }
  if (await ensureOneLoaded(items)) {
    snap = await getDocs(INVENTORY);
    items = snap.docs.map((entry) => normalizeItem(entry.id, entry.data(), lowAt));
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadInventoryLog() {
  const snap = await getDocs(LOG);
  return snap.docs
    .map((entry) => ({ id: entry.id, ...entry.data() }))
    .filter((row) => row.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 40);
}

export async function getLoadedReward() {
  const items = await loadInventory();
  return items.find((item) => item.loaded) || null;
}

export async function saveItem(payload) {
  const id = String(payload.id || "").trim() || `F-${Date.now()}`;
  const ref = doc(INVENTORY, id);
  const prev = await getDoc(ref);
  const now = new Date().toISOString();
  const next = {
    name: String(payload.name || "").trim(),
    sku: String(payload.sku || "").trim(),
    qty: Math.max(0, Number(payload.qty) || 0),
    capacity: Math.max(1, Number(payload.capacity) || 1),
    unit: String(payload.unit || "cans").trim() || "cans",
    loaded: prev.exists() ? Boolean(prev.data().loaded) : false,
    updated: now,
  };
  if (!next.name || !next.sku) throw new Error("Name and SKU are required.");
  if (next.qty > next.capacity) next.qty = next.capacity;

  const others = await getDocs(INVENTORY);
  const duplicate = others.docs.find((entry) => {
    if (entry.id === id) return false;
    return skuKey(entry.data().sku) === skuKey(next.sku);
  });
  if (duplicate) {
    throw new Error(`SKU ${next.sku} is already used by ${duplicate.data().name || "another item"}.`);
  }

  await setDoc(ref, next, { merge: true });

  if (!prev.exists()) {
    await writeLog({ itemId: id, item: next.name, change: next.qty, reason: "Added" });
  } else {
    const delta = next.qty - (Number(prev.data().qty) || 0);
    if (delta !== 0) {
      await writeLog({
        itemId: id,
        item: next.name,
        change: delta,
        reason: delta > 0 ? "Restocked" : "Adjusted",
      });
    }
  }

  return id;
}

export async function restockItem(id, amount) {
  const add = Math.round(Number(amount));
  if (!Number.isFinite(add) || add < 1) throw new Error("Enter how many units to add.");

  const ref = doc(INVENTORY, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("That item is no longer in inventory.");

  const data = snap.data();
  const current = Math.max(0, Number(data.qty) || 0);
  const capacity = Math.max(1, Number(data.capacity) || 1);
  const qty = current + add;
  const nextCapacity = Math.max(capacity, qty);

  await updateDoc(ref, {
    qty,
    capacity: nextCapacity,
    updated: new Date().toISOString(),
  });
  await writeLog({ itemId: id, item: data.name, change: add, reason: "Restocked" });
  return { qty, applied: add, capacity: nextCapacity, grew: nextCapacity > capacity };
}

export async function deleteItem(id) {
  const ref = doc(INVENTORY, id);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  await deleteDoc(ref);
  await writeLog({
    itemId: id,
    item: data.name,
    change: -(Number(data.qty) || 0),
    reason: "Removed",
  });
}

export async function setLoadedItem(id) {
  const target = await getDoc(doc(INVENTORY, id));
  if (!target.exists()) throw new Error("That item is no longer in inventory.");

  const snap = await getDocs(INVENTORY);
  const batch = writeBatch(db);
  const now = new Date().toISOString();
  snap.docs.forEach((entry) => {
    batch.update(entry.ref, { loaded: entry.id === id, updated: now });
  });
  await batch.commit();
  await writeLog({
    itemId: id,
    item: target.data().name,
    change: 0,
    reason: "Loaded in kiosk",
  });
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function consumeLoadedReward(voucherID, rewardType = "canned_food") {
  const loaded = await getLoadedReward();
  if (!loaded || loaded.qty < 1) {
    return { success: false, code: "unavailable", message: UNAVAILABLE_MESSAGE };
  }

  const itemRef = doc(INVENTORY, loaded.id);
  const voucherRef = voucherID ? doc(db, "vouchers", voucherID) : null;
  const redemptionRef = voucherID
    ? doc(db, "redemptions", voucherID)
    : doc(collection(db, "redemptions"));
  const logRef = doc(LOG);
  const settingsRef = doc(db, "kiosk_settings", "live");

  try {
    await runTransaction(db, async (transaction) => {
      const itemSnap = await transaction.get(itemRef);
      const settingsSnap = await transaction.get(settingsRef);
      const voucherSnap = voucherRef ? await transaction.get(voucherRef) : null;

      if (!itemSnap.exists()) throw fail("unavailable", UNAVAILABLE_MESSAGE);
      const item = itemSnap.data();
      const qty = Number(item.qty) || 0;
      if (!item.loaded || qty < 1) throw fail("unavailable", UNAVAILABLE_MESSAGE);

      let threshold = POINTS.threshold;
      if (settingsSnap.exists()) {
        const n = Number(settingsSnap.data().redemptionThreshold);
        if (Number.isFinite(n) && n > 0) threshold = n;
      }

      let pointsUsed = 0;
      if (voucherRef) {
        if (!voucherSnap.exists()) throw fail("missing", "QR not found.");
        const voucher = voucherSnap.data();
        if (voucher.status === "redeemed") throw fail("redeemed", "QR already redeemed.");
        if (Number(voucher.total_points) < threshold) {
          throw fail("points", `Not enough points. You need ${threshold}.`);
        }
        pointsUsed = Number(voucher.total_points) || 0;
      }

      const now = new Date().toISOString();
      transaction.update(itemRef, { qty: qty - 1, updated: now });
      if (voucherRef) transaction.update(voucherRef, { status: "redeemed" });
      transaction.set(redemptionRef, {
        voucher_id: voucherID || null,
        points_used: pointsUsed,
        reward_type: rewardType,
        reward_name: item.name,
        item_id: loaded.id,
        redeemed_at: now,
      });
      transaction.set(logRef, {
        at: now,
        itemId: loaded.id,
        item: item.name,
        change: -1,
        reason: "Redeemed",
        voucher_id: voucherID || null,
      });
    });
    } catch (err) {
      const code = err.code;
      const message = String(err.message || "");
      if (code === "unavailable" || message.includes("temporarily unavailable")) {
        return { success: false, code: "unavailable", message: UNAVAILABLE_MESSAGE };
      }
      if (code === "points" || code === "redeemed" || code === "missing") {
        return { success: false, code, message: err.message };
      }
      throw err;
    }

  return { success: true, item: loaded.name };
}
