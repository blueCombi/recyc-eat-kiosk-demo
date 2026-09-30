// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, increment, collection } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth, setPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { DEFAULT_ITEM_POINTS } from "./item-types.js";

const firebaseConfig = {
  apiKey: "AIzaSyCAQZstw1qOUltsN_HKPZE7qNI2uRRWpwU",
  authDomain: "recyc-eat.firebaseapp.com",
  projectId: "recyc-eat",
  storageBucket: "recyc-eat.firebasestorage.app",
  messagingSenderId: "45738414086",
  appId: "1:45738414086:web:90b0f800476683c77d3387"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// The kiosk laptop is shared, so a sign-in lasts for the browser session only:
// close the browser and the next person has to log in again. Every page must
// wait on this before reading auth state, otherwise the first
// onAuthStateChanged can report "signed out" before the stored session loads.
const authReady = setPersistence(auth, browserSessionPersistence)
  .catch((err) => console.error("Could not set auth persistence:", err));

// ─── Points config ───────────────────────────────────────────────
// One entry per item type the bin can report, keyed the same way as
// item-types.js. Live admin values overwrite these on every kiosk screen.
export const POINTS = {
  ...DEFAULT_ITEM_POINTS,
  threshold: 40,
};

// ─── Generate Receipt ID  e.g. EM-20260821-1413-001 ─────────────
export function generateReceiptID() {
  const now  = new Date();
  const date = now.toISOString().slice(0,10).replace(/-/g,"");
  const hh   = String(now.getHours()).padStart(2,"0");
  const mm   = String(now.getMinutes()).padStart(2,"0");
  const time = hh + mm;

  const todayKey = "em_counter_" + date;
  const count    = parseInt(sessionStorage.getItem(todayKey) || "0") + 1;
  sessionStorage.setItem(todayKey, count);
  const counter  = String(count).padStart(3,"0");

  return `EM-${date}-${time}-${counter}`;
}

// Prevent mutation of items array before Firestore serialises it
function freeze(items) {
  return JSON.parse(JSON.stringify(items || []));
}

// ─── Create a new voucher (first visit) ─────────────────────────
export async function createVoucher(items, totalPoints, pointsEarned = totalPoints) {
  const voucherID = generateReceiptID();
  const now       = new Date();
  const logged    = freeze(items);

  await setDoc(doc(db, "vouchers", voucherID), {
    voucher_id:   voucherID,
    total_points: totalPoints,
    status:       "active",
    created_at:   now.toISOString(),
  });

  await setDoc(doc(db, "sessions", `${voucherID}_${now.getTime()}`), {
    voucher_id:    voucherID,
    items:         logged,
    points_earned: pointsEarned,
    session_date:  now.toISOString(),
    action:        "created",
  });

  return voucherID;
}

// ─── Load existing voucher by scanning QR ───────────────────────
export async function scanVoucher(voucherID) {
  const snap = await getDoc(doc(db, "vouchers", voucherID));
  if (!snap.exists())                    return { success: false, message: "QR not found." };
  if (snap.data().status === "redeemed") return { success: false, message: "QR already redeemed." };
  return { success: true, ...snap.data() };
}

// ─── Add more points to existing voucher (return visit) ─────────
export async function addPoints(voucherID, newItems, pointsToAdd) {
  const ref    = doc(db, "vouchers", voucherID);
  const logged = freeze(newItems);

  await updateDoc(ref, { total_points: increment(pointsToAdd) });
  await setDoc(doc(db, "sessions", `${voucherID}_${Date.now()}`), {
    voucher_id:    voucherID,
    items:         logged,
    points_earned: pointsToAdd,
    session_date:  new Date().toISOString(),
    action:        "continued",
  });

  const snap = await getDoc(ref);
  return snap.exists() ? Number(snap.data().total_points) || 0 : 0;
}

// The kiosk counts points in the browser first. If the page moved on before
// every insert finished uploading, Firestore can lag behind the ring. Bring
// the saved receipt up to the session total before Redeem checks it.
export async function ensureVoucherMatchesSession(voucherID, sessionTotal, sessionItems = []) {
  const total = Number(sessionTotal) || 0;
  const items = freeze(sessionItems);
  const now = new Date().toISOString();

  if (!voucherID) {
    return createVoucher(items, total, total);
  }

  const ref = doc(db, "vouchers", voucherID);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      voucher_id: voucherID,
      total_points: total,
      status: "active",
      created_at: now,
    });
    await setDoc(doc(db, "sessions", `${voucherID}_${Date.now()}`), {
      voucher_id: voucherID,
      items,
      points_earned: total,
      session_date: now,
      action: "synced",
    });
    return voucherID;
  }

  if (snap.data().status === "redeemed") return voucherID;

  const current = Number(snap.data().total_points) || 0;
  if (total > current) {
    await updateDoc(ref, { total_points: total });
    await setDoc(doc(db, "sessions", `${voucherID}_${Date.now()}`), {
      voucher_id: voucherID,
      items,
      points_earned: total - current,
      session_date: now,
      action: "synced",
    });
  }

  return voucherID;
}

// ─── Redeem food reward ──────────────────────────────────────────
// Marks the voucher redeemed and subtracts 1 from the chosen coil SKU.
// Fails when that SKU is out of stock or the receipt is short of its cost.
export async function redeemReward(voucherID, sku) {
  const { consumeReward } = await import("./food-inventory-data.js");
  return consumeReward(voucherID, sku);
}

export { db, auth, authReady };  