/**
 * hardware-client.js
 * Browser side of the ESP32 bridge. Both boards hang off the kiosk host (the
 * Raspberry Pi) over USB, so everything goes through its Node server on port
 * 4000 — the same one the thermal printer uses.
 *
 * The screen is a tablet on the same WiFi as the Pi. Open the kiosk from the
 * Pi's address (http://192.168.x.x:4000/html/recycling.html) and this resolves
 * itself; there is nothing to configure on the tablet.
 *
 * Optional override when the pages come from somewhere else entirely:
 *   localStorage.setItem("econovaHardwareApi", "http://192.168.1.50:4000")
 */
const REQUEST_TIMEOUT_MS = 25000;
const RECONNECT_MS = 1500;
const BRIDGE_PORT = "4000";

function isLanHost(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
}

function servedByKioskHost() {
  const { hostname, port, protocol } = location;
  if (!protocol.startsWith("http")) return false;
  if (port === BRIDGE_PORT) return true;
  return /\.trycloudflare\.com$/i.test(hostname);
}

export function getHardwareBase() {
  const { origin, hostname, protocol } = location;

  if (servedByKioskHost()) return origin.replace(/\/+$/, "");

  try {
    const override = localStorage.getItem("econovaHardwareApi");
    if (override) return override.replace(/\/+$/, "");
  } catch {
    /* private mode */
  }

  if (protocol.startsWith("http") && isLanHost(hostname)) {
    return `http://${hostname}:${BRIDGE_PORT}`;
  }

  return `http://192.168.1.8:${BRIDGE_PORT}`;
}

export async function ensureHardwareBase() {
  if (location.port === BRIDGE_PORT) return getHardwareBase();
  try {
    const { loadKioskSettings } = await import("./kiosk-settings-data.js");
    await loadKioskSettings();
  } catch {
    /* keep localStorage / LAN fallback */
  }
  return getHardwareBase();
}

function socketUrl() {
  const base = getHardwareBase();
  return `${base.replace(/^http/, "ws")}/ws/hardware`;
}

async function postJson(route, body) {
  const { usesCloudHardware, sendCloudCommand } = await import("./hardware-cloud.js");
  if (usesCloudHardware()) {
    if (route === "/api/dispense") return sendCloudCommand("dispense", body);
    if (route === "/api/bin/tare") return sendCloudCommand("tare", body);
    if (route === "/api/print") return sendCloudCommand("print", body);
  }

  await ensureHardwareBase();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${getHardwareBase()}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body || {}),
    });
    let result = {};
    try {
      result = await response.json();
    } catch {
      result = {};
    }
    if (!response.ok || !result.success) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }
    return result;
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("The kiosk hardware did not respond in time.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getHardwareStatus() {
  const { usesCloudHardware, listenCloudHardware } = await import("./hardware-cloud.js");
  if (usesCloudHardware()) {
    return new Promise((resolve, reject) => {
      const stop = listenCloudHardware({
        onStatus(status) {
          stop();
          resolve(status);
        },
        onOffline(err) {
          stop();
          reject(err || new Error("Hardware status is offline."));
        },
      });
      setTimeout(() => {
        stop();
        reject(new Error("Hardware status timed out."));
      }, 8000);
    });
  }
  await ensureHardwareBase();
  const response = await fetch(`${getHardwareBase()}/api/hardware/status`);
  if (!response.ok) throw new Error(`Status failed (${response.status})`);
  return response.json();
}

export function dispenseCoil(coilNumber) {
  return postJson("/api/dispense", { coilNumber });
}

export function tareBin() {
  return postJson("/api/bin/tare", {});
}

export function simulateBinEvent(event) {
  return postJson("/api/bin/simulate", event);
}

/**
 * Opens the bin feed and keeps it open. Returns a handle with close(), because
 * kiosk screens navigate away mid-session and must not leave a socket retrying.
 *
 * Handlers: onStatus, onDetect, onItem, onReject, onSorted, onDispensing,
 * onOffline. Every one is optional.
 */
export function connectBin(handlers = {}) {
  let socket = null;
  let retry = null;
  let closed = false;

  // Somebody feeding the machine never touches the screen, so real bin traffic
  // has to count as activity or kiosk-guard.js times the session out from under
  // them. Reconnect churn deliberately does not count.
  const ACTIVITY = new Set(["onDetect", "onItem", "onReject", "onSorted"]);

  const fire = (name, payload) => {
    if (ACTIVITY.has(name)) {
      document.dispatchEvent(new CustomEvent("kiosk-activity"));
    }
    const fn = handlers[name];
    if (typeof fn !== "function") return;
    try {
      fn(payload);
    } catch (err) {
      console.error(`hardware ${name} handler failed:`, err);
    }
  };

  function open() {
    if (closed) return;

    import("./hardware-cloud.js").then(({ usesCloudHardware, listenCloudHardware }) => {
      if (closed) return;
      if (usesCloudHardware()) {
        const stop = listenCloudHardware({
          onStatus: (payload) => fire("onStatus", payload),
          onDetect: (payload) => fire("onDetect", payload),
          onItem: (payload) => fire("onItem", payload),
          onReject: (payload) => fire("onReject", payload),
          onSorted: (payload) => fire("onSorted", payload),
          onDispensing: (payload) => fire("onDispensing", payload),
          onOffline: (err) => fire("onOffline", err),
        });
        socket = { close: stop };
        return;
      }

      return ensureHardwareBase().then(() => {
      if (closed) return;
      try {
        socket = new WebSocket(socketUrl());
      } catch (err) {
        fire("onOffline", err);
        retry = setTimeout(open, RECONNECT_MS);
        return;
      }

      socket.addEventListener("message", (event) => {
        let message = null;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (message.type) {
          case "status": fire("onStatus", message); break;
          case "detect": fire("onDetect", message); break;
          case "item": fire("onItem", message); break;
          case "reject": fire("onReject", message); break;
          case "sorted": fire("onSorted", message); break;
          case "dispensing": fire("onDispensing", message); break;
          default: break;
        }
      });

      socket.addEventListener("close", () => {
        if (closed) return;
        fire("onOffline", null);
        retry = setTimeout(open, RECONNECT_MS);
      });

      socket.addEventListener("error", () => {});
      });
    }).catch((err) => {
      fire("onOffline", err);
      retry = setTimeout(open, RECONNECT_MS);
    });
  }

  open();

  return {
    close() {
      closed = true;
      clearTimeout(retry);
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
    },
  };
}
