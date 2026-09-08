// Pure grouping for the Participation Trends charts — kept free of Firebase
// so the bucket maths can be checked without the network.
import { localDateKey, keyToLocalDate, dayKeysBetween, weekStartKey } from "./date-utils.js";

function bucketOf(dateKey, grain) {
  if (grain === "monthly") return dateKey.slice(0, 7);
  if (grain === "weekly")  return weekStartKey(dateKey);
  return dateKey;
}

// Empty buckets stay in the series so a quiet week shows as a dip, not a skip.
export function periodKeys(fromKey, toKey, grain, limit = 92) {
  if (grain === "daily") return dayKeysBetween(fromKey, toKey, limit);

  if (grain === "monthly") {
    const keys = [];
    const end = keyToLocalDate(`${toKey.slice(0, 7)}-01`);
    let cursor = keyToLocalDate(`${fromKey.slice(0, 7)}-01`);
    while (cursor <= end && keys.length < limit) {
      const month = String(cursor.getMonth() + 1).padStart(2, "0");
      keys.push(`${cursor.getFullYear()}-${month}`);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return keys;
  }

  const keys = [];
  let cursor = weekStartKey(fromKey);
  const end = weekStartKey(toKey);
  while (cursor <= end && keys.length < limit) {
    keys.push(cursor);
    const next = keyToLocalDate(cursor);
    next.setDate(next.getDate() + 7);
    cursor = localDateKey(next);
  }
  return keys;
}

export function labelForPeriod(key, grain) {
  if (grain === "monthly") {
    return keyToLocalDate(`${key}-01`).toLocaleDateString("en-PH", {
      month: "short",
      year: "numeric",
    });
  }
  const label = keyToLocalDate(key).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
  });
  return grain === "weekly" ? `Week of ${label}` : label;
}

export function buildTrendSeries(data, from, to, grain) {
  const keys = periodKeys(from, to, grain);
  const buckets = new Map(keys.map((key) => [key, {
    activeIds: new Set(),
    neu: 0,
    items: 0,
    redeems: 0,
  }]));

  const inRange = (dateKey) => dateKey >= from && dateKey <= to;

  data.newVouchers.forEach((row) => {
    if (!inRange(row.dateKey)) return;
    const bucket = buckets.get(bucketOf(row.dateKey, grain));
    if (bucket) bucket.neu += 1;
  });

  data.collections.forEach((row) => {
    if (!inRange(row.dateKey)) return;
    const bucket = buckets.get(bucketOf(row.dateKey, grain));
    if (!bucket) return;
    bucket.items += row.qty;
    if (row.voucherId) bucket.activeIds.add(row.voucherId);
  });

  data.redemptions.forEach((row) => {
    if (!inRange(row.dateKey)) return;
    const bucket = buckets.get(bucketOf(row.dateKey, grain));
    if (bucket) bucket.redeems += 1;
  });

  const rangeActive = new Set();
  data.collections.forEach((row) => {
    if (inRange(row.dateKey) && row.voucherId) rangeActive.add(row.voucherId);
  });

  const labels  = keys.map((key) => labelForPeriod(key, grain));
  const active  = keys.map((key) => buckets.get(key).activeIds.size);
  const neu     = keys.map((key) => buckets.get(key).neu);
  const items   = keys.map((key) => buckets.get(key).items);
  const redeems = keys.map((key) => buckets.get(key).redeems);

  return {
    labels,
    active,
    neu,
    items,
    redeems,
    stats: {
      active: rangeActive.size,
      neu:    neu.reduce((s, n) => s + n, 0),
      items:  items.reduce((s, n) => s + n, 0),
      redeems: redeems.reduce((s, n) => s + n, 0),
    },
  };
}
