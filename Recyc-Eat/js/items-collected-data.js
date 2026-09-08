// items-collected-data.js
// Reads the kiosk's session log from Firestore for the Items Collected page.
import { db } from "./firebase-config.js";
import { localDateKey } from "./date-utils.js";
import {
  collection,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// A session document holds one insert event with an items array. The page
// works in rows of one item type, so a session with two types becomes two
// rows that share a timestamp and receipt.
function rowsFromSession(doc) {
  const session = doc.data();
  if (!session.session_date) return [];

  const when = new Date(session.session_date);
  if (Number.isNaN(when.getTime())) return [];

  const items = Array.isArray(session.items) ? session.items : [];
  const shortId = doc.id.slice(0, 6).toUpperCase();

  return items.reduce((rows, item, index) => {
    const qty = Number(item?.quantity ?? item?.qty ?? item?.count ?? 1);
    if (!qty || qty <= 0) return rows;

    rows.push({
      id: items.length > 1 ? `${shortId}-${index + 1}` : shortId,
      sessionId: doc.id,     // several rows can share one insert event
      date: session.session_date,
      dateKey: localDateKey(when),
      // the kiosk writes a readable label next to the machine key
      type: item?.label || item?.name || item?.type || "Item",
      qty,
      points: Number(item?.points ?? 0),
      receiptId: session.voucher_id || "—",
    });
    return rows;
  }, []);
}

export async function loadCollections() {
  const snap = await getDocs(collection(db, "sessions"));

  const rows = snap.docs.flatMap(rowsFromSession);
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  return rows;
}
