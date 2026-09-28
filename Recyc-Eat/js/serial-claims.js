/**
 * serial-claims.js
 * Windows hands one COM port to one process at a time, and the kiosk PC has
 * three USB-serial devices on it: the QR scanner, the sorting bin ESP32 and the
 * vending ESP32. Both bridges scan the same port list, so whoever opens a port
 * records it here and the other one leaves it alone.
 */
const owners = new Map();

function claim(path, owner) {
  if (!path) return false;
  const held = owners.get(path);
  if (held && held !== owner) return false;
  owners.set(path, owner);
  return true;
}

function release(path) {
  owners.delete(path);
}

function ownerOf(path) {
  return owners.get(path) || null;
}

function isClaimedByOther(path, owner) {
  const held = owners.get(path);
  return Boolean(held) && held !== owner;
}

module.exports = { claim, release, ownerOf, isClaimedByOther };
