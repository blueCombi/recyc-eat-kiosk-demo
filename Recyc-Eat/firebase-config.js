// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

// ─── Points config ───────────────────────────────────────────────
export const POINTS = {
  small_bottle: 5,
  big_bottle:   7,
  aluminum_can: 5,
  threshold:    50,
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
  const snap   = await getDoc(ref);
  const newTotal = snap.data().total_points + pointsToAdd;

  await updateDoc(ref, { total_points: newTotal });
  await setDoc(doc(db, "sessions", `${voucherID}_${Date.now()}`), {
    voucher_id:    voucherID,
    items:         logged,
    points_earned: pointsToAdd,
    session_date:  new Date().toISOString(),
    action:        "continued",
  });

  return newTotal;
}

// ─── Redeem food reward ──────────────────────────────────────────
export async function redeemReward(voucherID, rewardType) {
  const ref  = doc(db, "vouchers", voucherID);
  const snap = await getDoc(ref);
  const data = snap.data();

  if (data.total_points < POINTS.threshold)
    return { success: false, message: "Not enough points." };

  await updateDoc(ref, { status: "redeemed" });
  await setDoc(doc(db, "redemptions", voucherID), {
    voucher_id:  voucherID,
    points_used: data.total_points,
    reward_type: rewardType,
    redeemed_at: new Date().toISOString(),
  });

  return { success: true };
}

export { db };  