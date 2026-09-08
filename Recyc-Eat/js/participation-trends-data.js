// participation-trends-data.js
// A kiosk "participant" is a voucher (one QR). There are no user accounts.
import { db } from "./firebase-config.js";
import { localDateKey } from "./date-utils.js";
import { buildTrendSeries } from "./trend-series.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export { buildTrendSeries };

function toDateKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return localDateKey(d);
}

function sumItemQty(items) {
  if (!Array.isArray(items)) return 0;
  return items.reduce(
    (sum, it) => sum + Number(it?.qty ?? it?.quantity ?? it?.count ?? 1),
    0,
  );
}

export async function loadParticipation() {
  const [vouchersSnap, sessionsSnap, redemptionsSnap] = await Promise.all([
    getDocs(collection(db, "vouchers")),
    getDocs(collection(db, "sessions")),
    getDocs(collection(db, "redemptions")),
  ]);

  const newVouchers = vouchersSnap.docs.reduce((rows, doc) => {
    const entry = doc.data();
    const dateKey = toDateKey(entry.created_at);
    if (!dateKey) return rows;
    rows.push({ id: entry.voucher_id || doc.id, dateKey });
    return rows;
  }, []);

  const collections = sessionsSnap.docs.reduce((rows, doc) => {
    const entry = doc.data();
    const dateKey = toDateKey(entry.session_date);
    const qty = sumItemQty(entry.items);
    if (!dateKey || qty <= 0) return rows;
    rows.push({
      voucherId: entry.voucher_id || null,
      dateKey,
      qty,
    });
    return rows;
  }, []);

  const redemptions = redemptionsSnap.docs.reduce((rows, doc) => {
    const entry = doc.data();
    const dateKey = toDateKey(entry.redeemed_at);
    if (!dateKey) return rows;
    rows.push({
      voucherId: entry.voucher_id || doc.id,
      dateKey,
    });
    return rows;
  }, []);

  return { newVouchers, collections, redemptions };
}
