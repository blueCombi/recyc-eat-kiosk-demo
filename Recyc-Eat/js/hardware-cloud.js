/**
 * Firestore channel between the Hostinger website (HTTPS) and the Pi.
 * The browser cannot call http://192.168.1.8 from matarix.store, so commands
 * and bin events travel through kiosk_hardware/live instead.
 */
import { db } from "./firebase-config.js";
import {
  doc,
  onSnapshot,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const LIVE = doc(db, "sessions", "econova-hardware");

export function usesCloudHardware() {
  const { protocol, hostname, port } = location;
  if (port === "4000") return false;
  if (/\.trycloudflare\.com$/i.test(hostname)) return false;
  if (hostname === "localhost" || hostname === "127.0.0.1") return false;
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return false;
  return protocol === "https:";
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(String(raw || "") || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

export async function sendCloudCommand(type, payload = {}, timeoutMs = 25000) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await setDoc(LIVE, {
    commandId: id,
    commandType: String(type || ""),
    commandPayload: JSON.stringify(payload || {}),
    commandStatus: "pending",
    commandError: "",
    commandResult: "",
    commandAt: Date.now(),
  }, { merge: true });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error("The kiosk hardware did not respond in time."));
    }, timeoutMs);

    const unsub = onSnapshot(LIVE, (snap) => {
      const data = snap.data() || {};
      if (data.commandId !== id) return;
      if (data.commandStatus === "pending") return;
      clearTimeout(timer);
      unsub();
      if (data.commandStatus === "done") {
        resolve(parseJson(data.commandResult, { success: true }));
        return;
      }
      reject(new Error(data.commandError || "Hardware command failed."));
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function listenCloudHardware(handlers = {}) {
  const started = Date.now();
  let seenEventAt = 0;
  const fire = (name, payload) => {
    const fn = handlers[name];
    if (typeof fn === "function") fn(payload);
  };

  return onSnapshot(LIVE, (snap) => {
    const data = snap.data() || {};
    fire("onStatus", {
      type: "status",
      bin: {
        connected: data.binConnected === true || data.binConnected === "true",
        state: data.binState || "searching",
        detail: data.binDetail || "",
      },
      vend: {
        connected: data.vendConnected === true || data.vendConnected === "true",
        detail: data.vendDetail || "",
        lastCoil: Number(data.vendLastCoil) || null,
      },
    });

    const eventAt = Number(data.eventAt) || 0;
    if (!eventAt || eventAt <= seenEventAt) return;
    seenEventAt = eventAt;
    if (eventAt < started - 800) return;

    const event = parseJson(data.lastEvent, null);
    if (!event || !event.type) return;
    const name = ({
      detect: "onDetect",
      item: "onItem",
      reject: "onReject",
      sorted: "onSorted",
      dispensing: "onDispensing",
    })[event.type];
    if (name) fire(name, event);
  }, (err) => {
    fire("onOffline", err);
  });
}
