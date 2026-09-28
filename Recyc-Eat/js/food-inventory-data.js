// food-inventory-data.js
// Four vending coils in Firestore (`food_inventory`). Button N is always coil N.
import { db } from "./firebase-config.js";
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
export const COIL_COUNT = 4;

const INVENTORY = collection(db, "food_inventory");
const LOG = collection(db, "inventory_log");

export const DEFAULT_COILS = [
  { id: "coil-1", sku: "SPAG-01", name: "Spaghetti pack", coilNumber: 1, qty: 24, capacity: 40, unit: "packs", pointCost: 40 },
  { id: "coil-2", sku: "SARD-01", name: "Canned sardines", coilNumber: 2, qty: 36, capacity: 50, unit: "cans", pointCost: 50 },
  { id: "coil-3", sku: "TUNA-01", name: "Canned tuna", coilNumber: 3, qty: 36, capacity: 50, unit: "cans", pointCost: 50 },
  { id: "coil-4", sku: "BEEF-01", name: "Corned beef", coilNumber: 4, qty: 30, capacity: 40, unit: "cans", pointCost: 55 },
];

export function stockStatus(item, lowAt = 15) {
  const qty = Number(item?.qty) || 0;
  const capacity = Number(item?.capacity) || 0;
  if (qty <= 0) return "out";
  const ratio = capacity > 0 ? qty / capacity : 0;
  if (ratio <= 0.2 || qty <= lowAt) return "low";
  return "ok";
}

function skuKey(sku) {
  return String(sku || "").trim().toLowerCase();
}

function coilOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const coil = Math.round(n);
  return coil >= 1 && coil <= COIL_COUNT ? coil : 0;
}

function defaultForCoil(coilNumber) {
  return DEFAULT_COILS.find((item) => item.coilNumber === coilNumber) || DEFAULT_COILS[0];
}

function coilPayload(seed, now) {
  return {
    sku: seed.sku,
    name: seed.name,
    coilNumber: seed.coilNumber,
    qty: seed.qty,
    capacity: seed.capacity,
    unit: seed.unit,
    pointCost: seed.pointCost,
    updated: now,
  };
}

function normalizeItem(id, data, lowAt) {
  const seed = defaultForCoil(coilOf(data?.coilNumber) || Number(String(id).replace("coil-", "")) || 0);
  const qty = Math.max(0, Number(data?.qty) || 0);
  const capacity = Math.max(1, Number(data?.capacity) || seed.capacity || 1);
  const coilNumber = coilOf(data?.coilNumber) || seed.coilNumber || 0;
  const item = {
    id,
    name: String(data?.name || seed.name || "Unnamed item").trim() || "Unnamed item",
    sku: String(data?.sku || seed.sku || id).trim() || id,
    coilNumber,
    qty,
    capacity,
    unit: String(data?.unit || seed.unit || "cans").trim() || "cans",
    pointCost: Math.max(1, Number(data?.pointCost) || seed.pointCost || 50),
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

function mapItems(snap, lowAt) {
  return snap.docs.map((entry) => normalizeItem(entry.id, entry.data(), lowAt));
}

function sortInventory(items) {
  return [...items].sort((a, b) => {
    if (a.coilNumber && b.coilNumber && a.coilNumber !== b.coilNumber) {
      return a.coilNumber - b.coilNumber;
    }
    if (a.coilNumber !== b.coilNumber) return a.coilNumber ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export async function ensureDefaultInventory() {
  const snap = await getDocs(INVENTORY);
  const existing = snap.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  let writes = 0;

  const hasCoils = existing.some((item) => coilOf(item.coilNumber));
  DEFAULT_COILS.forEach((seed) => {
    const match = existing.find((item) => coilOf(item.coilNumber) === seed.coilNumber)
      || existing.find((item) => item.id === seed.id);
    if (match) return;
    const qty = hasCoils ? 0 : seed.qty;
    batch.set(doc(INVENTORY, seed.id), coilPayload({ ...seed, qty }, now));
    writes += 1;
  });

  existing.forEach((item) => {
    if (coilOf(item.coilNumber)) return;
    if (DEFAULT_COILS.some((seed) => seed.id === item.id)) return;
    batch.delete(doc(INVENTORY, item.id));
    writes += 1;
  });

  if (writes) await batch.commit();
}

export async function loadInventory() {
  await ensureDefaultInventory();
  const lowAt = await lowStockThreshold();
  const snap = await getDocs(INVENTORY);
  return sortInventory(mapItems(snap, lowAt));
}

export async function loadCoilInventory() {
  const items = await loadInventory();
  return DEFAULT_COILS.map((seed) => {
    return items.find((item) => item.coilNumber === seed.coilNumber)
      || normalizeItem(seed.id, coilPayload({ ...seed, qty: 0 }, null), 15);
  });
}

export async function getItemByCoil(coilNumber) {
  const coil = coilOf(coilNumber);
  if (!coil) return null;
  const items = await loadCoilInventory();
  return items.find((item) => item.coilNumber === coil) || null;
}

export async function getItemBySku(sku) {
  const key = skuKey(sku);
  if (!key) return null;
  const items = await loadInventory();
  return items.find((item) => skuKey(item.sku) === key) || null;
}

export async function getMinRewardCost() {
  const coils = await loadCoilInventory();
  const costs = coils.map((item) => item.pointCost).filter((n) => n > 0);
  return costs.length ? Math.min(...costs) : 50;
}

export async function loadInventoryLog() {
  const snap = await getDocs(LOG);
  return snap.docs
    .map((entry) => ({ id: entry.id, ...entry.data() }))
    .filter((row) => row.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 40);
}

export async function saveItem(payload) {
  const coilNumber = coilOf(payload.coilNumber);
  const id = String(payload.id || "").trim() || (coilNumber ? `coil-${coilNumber}` : `F-${Date.now()}`);
  const ref = doc(INVENTORY, id);
  const prev = await getDoc(ref);
  const now = new Date().toISOString();
  const seed = defaultForCoil(coilNumber);
  const next = {
    name: String(payload.name || "").trim(),
    sku: String(payload.sku || "").trim(),
    coilNumber,
    qty: Math.max(0, Number(payload.qty) || 0),
    capacity: Math.max(1, Number(payload.capacity) || 1),
    unit: String(payload.unit || seed.unit || "cans").trim() || "cans",
    pointCost: Math.max(1, Number(payload.pointCost) || seed.pointCost || 50),
    updated: now,
  };
  if (!next.name || !next.sku) throw new Error("Name and SKU are required.");
  if (!next.coilNumber) throw new Error("Pick coil 1 through 4.");
  if (next.qty > next.capacity) next.qty = next.capacity;

  const others = await getDocs(INVENTORY);
  const skuClash = others.docs.find((entry) => {
    if (entry.id === id) return false;
    return skuKey(entry.data().sku) === skuKey(next.sku);
  });
  if (skuClash) {
    throw new Error(`SKU ${next.sku} is already used by ${skuClash.data().name || "another item"}.`);
  }
  const coilClash = others.docs.find((entry) => {
    if (entry.id === id) return false;
    return coilOf(entry.data().coilNumber) === next.coilNumber;
  });
  if (coilClash) {
    throw new Error(`Coil ${next.coilNumber} is already ${coilClash.data().name || "in use"}.`);
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

export async function saveCoilCatalog(rows) {
  const coils = await loadCoilInventory();
  const now = new Date().toISOString();

  for (const row of rows || []) {
    const coilNumber = coilOf(row.coilNumber);
    if (!coilNumber) continue;
    const item = coils.find((entry) => entry.coilNumber === coilNumber);
    if (!item) continue;
    const name = String(row.name || "").trim();
    const pointCost = Math.max(1, Number(row.pointCost) || item.pointCost);
    if (!name) throw new Error(`Coil ${coilNumber} needs a name.`);
    await updateDoc(doc(INVENTORY, item.id), { name, pointCost, updated: now });
  }
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
  const coilNumber = coilOf(data.coilNumber);
  await deleteDoc(ref);
  await writeLog({
    itemId: id,
    item: data.name,
    change: -(Number(data.qty) || 0),
    reason: "Removed",
  });
  if (coilNumber) {
    const seed = defaultForCoil(coilNumber);
    const now = new Date().toISOString();
    await setDoc(doc(INVENTORY, seed.id), coilPayload({ ...seed, qty: 0 }, now));
    await writeLog({
      itemId: seed.id,
      item: seed.name,
      change: 0,
      reason: `Reset coil ${coilNumber}`,
    });
  }
}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export async function consumeReward(voucherID, sku) {
  const listed = await getItemBySku(sku);
  if (!listed) {
    return { success: false, code: "unavailable", message: UNAVAILABLE_MESSAGE };
  }

  const itemRef = doc(INVENTORY, listed.id);
  const voucherRef = voucherID ? doc(db, "vouchers", voucherID) : null;
  const redemptionRef = voucherID
    ? doc(db, "redemptions", voucherID)
    : doc(collection(db, "redemptions"));
  const logRef = doc(LOG);

  try {
    await runTransaction(db, async (transaction) => {
      const itemSnap = await transaction.get(itemRef);
      const voucherSnap = voucherRef ? await transaction.get(voucherRef) : null;

      if (!itemSnap.exists()) throw fail("unavailable", UNAVAILABLE_MESSAGE);
      const item = itemSnap.data();
      const qty = Number(item.qty) || 0;
      if (qty <= 0) throw fail("unavailable", "Out of stock");

      const pointCost = Math.max(1, Number(item.pointCost) || listed.pointCost || 50);
      let pointsUsed = pointCost;
      if (voucherRef) {
        if (!voucherSnap.exists()) throw fail("missing", "QR not found.");
        const voucher = voucherSnap.data();
        if (voucher.status === "redeemed") throw fail("redeemed", "QR already redeemed.");
        if (Number(voucher.total_points) < pointCost) {
          throw fail("points", `Not enough points. You need ${pointCost}.`);
        }
        pointsUsed = pointCost;
      }

      const now = new Date().toISOString();
      transaction.update(itemRef, { qty: qty - 1, updated: now });
      if (voucherRef) transaction.update(voucherRef, { status: "redeemed" });
      transaction.set(redemptionRef, {
        voucher_id: voucherID || null,
        points_used: pointsUsed,
        reward_type: item.sku || sku,
        reward_name: item.name,
        item_id: listed.id,
        coil_number: coilOf(item.coilNumber) || listed.coilNumber,
        redeemed_at: now,
      });
      transaction.set(logRef, {
        at: now,
        itemId: listed.id,
        item: item.name,
        change: -1,
        reason: "Redemption",
        voucher_id: voucherID || null,
      });
    });
  } catch (err) {
    const nested = err?.customData?.originalError || err?.cause || err;
    const code = String(nested.code || err.code || "");
    const message = String(nested.message || err.message || "");
    if (code === "unavailable" || message.toLowerCase().includes("out of stock") || message.includes("temporarily unavailable")) {
      return { success: false, code: "unavailable", message: nested.message || UNAVAILABLE_MESSAGE };
    }
    if (code === "points" || code === "redeemed" || code === "missing") {
      return { success: false, code, message: nested.message };
    }
    if (code === "permission-denied" || message.includes("PERMISSION_DENIED") || message.includes("Missing or insufficient permissions")) {
      return {
        success: false,
        code: "permission",
        message: "Firebase blocked the save. In Firestore Rules, allow the kiosk to write vouchers, food_inventory, redemptions, and inventory_log.",
      };
    }
    throw err;
  }

  const fresh = await getDoc(itemRef);
  const data = fresh.exists() ? fresh.data() : listed;
  return {
    success: true,
    item: data.name || listed.name,
    sku: data.sku || listed.sku,
    coilNumber: coilOf(data.coilNumber) || listed.coilNumber,
    pointCost: Number(data.pointCost) || listed.pointCost,
  };
}

export async function consumeLoadedReward(voucherID, rewardType = "") {
  const sku = skuKey(rewardType) && skuKey(rewardType) !== "canned_food"
    ? rewardType
    : (await loadCoilInventory()).find((item) => item.qty > 0)?.sku;
  return consumeReward(voucherID, sku);
}
