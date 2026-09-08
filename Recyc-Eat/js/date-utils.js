// Shared day-bucketing helpers for the admin reports.
//
// Firestore stores timestamps as UTC ISO strings. Grouping those with
// toISOString() files anything recycled after local midnight under the
// previous day, so every key here is built from kiosk-local date parts.

export function localDateKey(date) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day   = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// "2026-09-08" -> local midnight on that day (not UTC midnight)
export function keyToLocalDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// every day from fromKey to toKey inclusive, so charts show empty days
// instead of joining across gaps
export function dayKeysBetween(fromKey, toKey, limit = 92) {
  const keys = [];
  const end = keyToLocalDate(toKey);
  let cursor = keyToLocalDate(fromKey);

  while (cursor <= end && keys.length < limit) {
    keys.push(localDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

// Monday of the week a day belongs to
export function weekStartKey(key) {
  const d = keyToLocalDate(key);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDateKey(d);
}
