/**
 * hardware-relay.js
 * Runs on the Raspberry Pi. Watches Firestore for commands from the Hostinger
 * site and publishes bin / vending status so the website can stay in sync
 * without calling http://192.168.1.8 (browsers block that mix).
 */
const PROJECT = "recyc-eat";
const API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyCAQZstw1qOUltsN_HKPZE7qNI2uRRWpwU";
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/sessions/econova-hardware`;
const POLL_MS = 700;
const STATUS_MS = 1200;

function fieldsToObj(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (value.stringValue != null) out[key] = value.stringValue;
    else if (value.integerValue != null) out[key] = Number(value.integerValue);
    else if (value.doubleValue != null) out[key] = value.doubleValue;
    else if (value.booleanValue != null) out[key] = value.booleanValue;
  }
  return out;
}

function toFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "boolean") fields[key] = { booleanValue: value };
    else if (typeof value === "number" && Number.isInteger(value)) fields[key] = { integerValue: String(value) };
    else if (typeof value === "number") fields[key] = { doubleValue: value };
    else fields[key] = { stringValue: String(value ?? "") };
  }
  return { fields };
}

async function getLive() {
  const response = await fetch(`${DOC_URL}?key=${API_KEY}`);
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`Firestore read ${response.status}`);
  const json = await response.json();
  return fieldsToObj(json.fields);
}

async function patchLive(obj) {
  const names = Object.keys(obj);
  if (!names.length) return;
  const mask = names.map((name) => `updateMask.fieldPaths=${encodeURIComponent(name)}`).join("&");
  const response = await fetch(`${DOC_URL}?key=${API_KEY}&${mask}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toFields(obj)),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firestore write ${response.status}: ${text.slice(0, 180)}`);
  }
}

function startHardwareRelay() {
  const handlers = {
    dispense: null,
    tare: null,
    print: null,
    getStatus: null,
  };

  let lastCommandId = "";
  let busy = false;
  let lastStatusAt = 0;
  let pendingStatus = null;

  async function publishStatus(snapshot) {
    const bin = snapshot?.bin || {};
    const vend = snapshot?.vend || {};
    pendingStatus = {
      binConnected: !!bin.connected,
      binState: String(bin.state || ""),
      binDetail: String(bin.detail || ""),
      vendConnected: !!vend.connected,
      vendDetail: String(vend.detail || ""),
      vendLastCoil: Number(vend.lastCoil) || 0,
      updatedAt: String(Date.now()),
    };
  }

  async function flushStatus() {
    if (!pendingStatus) return;
    const now = Date.now();
    if (now - lastStatusAt < STATUS_MS) return;
    const payload = pendingStatus;
    pendingStatus = null;
    lastStatusAt = now;
    await patchLive(payload);
  }

  async function pushEvent(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "status") {
      await publishStatus(message);
      return;
    }
    try {
      await patchLive({
        lastEvent: JSON.stringify(message),
        eventAt: Number(message.at) || Date.now(),
        updatedAt: String(Date.now()),
      });
    } catch (err) {
      console.warn("[relay] event write failed:", err.message);
    }
  }

  async function runCommand(live) {
    const type = String(live.commandType || "").toLowerCase();
    let payload = {};
    try {
      payload = JSON.parse(live.commandPayload || "{}") || {};
    } catch {
      payload = {};
    }

    try {
      let result = { success: true };
      if (type === "dispense") {
        if (typeof handlers.dispense !== "function") throw new Error("Vending is not ready.");
        result = await handlers.dispense(payload.coilNumber);
        if (!result?.success) throw new Error(result?.error || "Coil did not turn.");
      } else if (type === "print") {
        if (typeof handlers.print !== "function") throw new Error("Printer is not ready.");
        await handlers.print(payload);
        result = { success: true };
      } else if (type === "tare") {
        if (typeof handlers.tare !== "function") throw new Error("Bin is not ready.");
        const sent = handlers.tare();
        if (!sent) throw new Error("Sorting bin is not connected.");
        result = { success: true };
      } else {
        throw new Error(`Unknown hardware command: ${type || "(empty)"}`);
      }

      await patchLive({
        commandStatus: "done",
        commandError: "",
        commandResult: JSON.stringify(result),
        updatedAt: String(Date.now()),
      });
    } catch (err) {
      await patchLive({
        commandStatus: "error",
        commandError: String(err.message || err),
        commandResult: JSON.stringify({ success: false, error: String(err.message || err) }),
        updatedAt: String(Date.now()),
      });
    }
  }

  async function tick() {
    try {
      await flushStatus();
      if (busy) return;
      const live = await getLive();
      const id = String(live.commandId || "");
      if (!id || live.commandStatus !== "pending" || id === lastCommandId) return;
      lastCommandId = id;
      busy = true;
      console.log(`[relay] ${live.commandType} ${id}`);
      await runCommand(live);
    } catch (err) {
      console.warn("[relay]", err.message);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  tick().catch(() => {});

  return {
    attach(next) {
      Object.assign(handlers, next || {});
    },
    pushEvent,
  };
}

module.exports = { startHardwareRelay };
