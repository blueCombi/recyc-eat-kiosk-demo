/**
 * hardware-bridge.js
 * Connects the kiosk to the two ESP32 boards over USB serial. Runs on the kiosk
 * host — a Raspberry Pi, where the boards appear as /dev/ttyUSB0 and friends.
 *
 *   BIN  — weighs, identifies and sorts the inserted item. Pushes events up.
 *   VEND — drives the four coil motors. Takes DISPENSE commands down.
 *
 * Both boards answer a WHO handshake with their role, so the operator can plug
 * them into any USB socket in any order and the bridge still routes correctly.
 *
 * Wire protocol (newline terminated, pipe separated, 115200 baud):
 *   host -> board   WHO | PING | TARE | DISPENSE|<coil>
 *   board -> host   HELLO|BIN|<ver>        HELLO|VEND|<ver>
 *                   EVT|READY              EVT|BUSY
 *                   EVT|DETECT|weight=12.40
 *                   EVT|ACCEPT|material=PLASTIC|size=MEDIUM|weight=24.50
 *                   EVT|REJECT|reason=TOO_LIGHT|weight=2.10
 *                   EVT|SORTED|material=PLASTIC
 *                   OK|DISPENSE|<coil>     ERR|DISPENSE|<coil>|<why>
 *                   LOG|<free text>
 */
const { SerialPort } = require("serialport");
const { WebSocketServer } = require("ws");
const claims = require("./serial-claims");
const { attachLineReader } = require("./serial-lines");

const OWNER = "hardware";
const BAUD = 115200;
const RESCAN_MS = 3000;
const WHO_EVERY_MS = 800;
const PROBE_TIMEOUT_MS = 6000;
const DISPENSE_TIMEOUT_MS = 20000;
const COIL_COUNT = 4;

// USB-serial chips found on ESP32 dev boards: CP210x, CH340/CH9102, FTDI,
// Espressif native USB, and the Arduino-branded clones.
const ESP32_VIDS = new Set([0x10c4, 0x1a86, 0x0403, 0x303a, 0x2341, 0x1b4f]);

// A USB board on Linux, which is what the Raspberry Pi kiosk host sees.
const USB_SERIAL_PATH = /^\/dev\/(ttyUSB|ttyACM)\d+$/i;

// Never touch the host's own serial hardware. On a Pi 3, ttyAMA0 is wired to
// the onboard Bluetooth and ttyS0 / serial0 are the GPIO header pins — opening
// either one would knock out Bluetooth and never answer WHO.
const ONBOARD_SERIAL_PATH = /^\/dev\/(ttyAMA\d+|ttyS\d+|serial\d+|ttyprintk|console)$/i;

const ROLE_BY_TOKEN = { BIN: "bin", VEND: "vend" };

const REJECT_REASONS = {
  TOO_LIGHT: "That felt too light to be a bottle or can.",
  OVERWEIGHT: "That was too heavy — please empty it first.",
  INVALID_SIZE: "The sensors could not size that item.",
  UNKNOWN_ITEM: "The bin could not identify that item.",
};

function vidOf(portInfo) {
  if (!portInfo.vendorId) return null;
  const vid = parseInt(String(portInfo.vendorId).replace(/^0x/i, ""), 16);
  return Number.isFinite(vid) ? vid : null;
}

// Worth opening and asking WHO. Linux names USB adapters distinctly, so the
// path is enough there; Windows calls everything COMx, so the chip has to be
// recognised instead. Either way a board only counts once it answers.
function looksLikeBoard(portInfo) {
  const path = portInfo.path || "";
  if (!path || ONBOARD_SERIAL_PATH.test(path)) return false;
  if (USB_SERIAL_PATH.test(path)) return true;

  const labels = `${portInfo.manufacturer || ""} ${portInfo.friendlyName || ""} ${portInfo.pnpId || ""}`;
  if (/BTHENUM|Bluetooth/i.test(`${labels} ${path}`)) return false;

  const vid = vidOf(portInfo);
  if (vid != null && ESP32_VIDS.has(vid)) return true;
  return /CP210|CH340|CH910|Silicon Labs|Espressif|USB Serial|USB-SERIAL/i.test(labels);
}

// "material=PLASTIC" pairs after the event name.
function parseFields(parts) {
  const fields = {};
  for (const part of parts) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    fields[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
  }
  return fields;
}

function asWeight(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : null;
}

function coilOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const coil = Math.round(n);
  return coil >= 1 && coil <= COIL_COUNT ? coil : 0;
}

function createHardwareBridge({ server, onItem, onBroadcast, allowSimulation = false } = {}) {
  const clients = new Set();

  const state = {
    bin: {
      connected: false,
      path: null,
      state: "searching",
      detail: "Looking for the sorting bin on USB…",
      lastEvent: null,
      lastWeight: null,
    },
    vend: {
      connected: false,
      path: null,
      detail: "Looking for the vending board on USB…",
      lastCoil: null,
    },
    simulation: Boolean(allowSimulation),
  };

  const boards = new Map();   // role -> { port, path }
  const probing = new Set();  // device paths mid-handshake
  let pendingDispense = null;
  let openHint = null;        // why a port that exists could not be opened

  // Handing `server` straight to ws would make this instance abort upgrades
  // meant for /ws/scanner, so each bridge routes its own path and ignores the
  // rest.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const pathname = String(req.url || "").split("?")[0];
    if (pathname !== "/ws/hardware") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "status", ...snapshot() }));
    ws.on("close", () => clients.delete(ws));
  });

  function snapshot() {
    return {
      bin: { ...state.bin },
      vend: { ...state.vend },
      simulation: state.simulation,
    };
  }

  function broadcast(message) {
    const raw = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(raw);
    }
    if (typeof onBroadcast === "function") {
      try {
        onBroadcast(message);
      } catch (err) {
        console.warn("[hardware] broadcast hook failed:", err.message);
      }
    }
  }

  function pushStatus() {
    broadcast({ type: "status", ...snapshot() });
  }

  function send(role, line) {
    const board = boards.get(role);
    if (!board) return false;
    try {
      board.port.write(`${line}\n`);
      return true;
    } catch (err) {
      console.warn(`[hardware] write to ${role} failed:`, err.message);
      return false;
    }
  }

  // ── bin events ──────────────────────────────────────────────────
  function setBinState(next, detail) {
    state.bin.state = next;
    if (detail) state.bin.detail = detail;
    pushStatus();
  }

  function emitItem({ material, size, weight, source = "bin" }) {
    const payload = {
      type: "item",
      material: String(material || "").toUpperCase(),
      size: String(size || "").toUpperCase(),
      weight: asWeight(weight),
      source,
      at: Date.now(),
    };
    state.bin.lastEvent = payload;
    state.bin.lastWeight = payload.weight;
    console.log(`[hardware] accepted ${payload.material} ${payload.size} (${payload.weight ?? "?"}g)`);
    broadcast(payload);
    if (typeof onItem === "function") onItem(payload);
  }

  function emitReject({ reason, weight, source = "bin" }) {
    const code = String(reason || "UNKNOWN_ITEM").toUpperCase();
    const payload = {
      type: "reject",
      reason: code,
      message: REJECT_REASONS[code] || REJECT_REASONS.UNKNOWN_ITEM,
      weight: asWeight(weight),
      source,
      at: Date.now(),
    };
    state.bin.lastEvent = payload;
    console.log(`[hardware] rejected: ${code}`);
    broadcast(payload);
  }

  function handleBinEvent(name, fields) {
    switch (name) {
      case "READY":
        setBinState("ready", "Bin ready. Waiting for an item.");
        break;
      case "BUSY":
        setBinState("busy", "Bin is sorting the last item.");
        break;
      case "DETECT":
        state.bin.lastWeight = asWeight(fields.weight);
        setBinState("weighing", "Weighing the item…");
        broadcast({ type: "detect", weight: state.bin.lastWeight, at: Date.now() });
        break;
      case "ACCEPT":
        emitItem(fields);
        break;
      case "REJECT":
        emitReject(fields);
        break;
      case "SORTED":
        broadcast({ type: "sorted", material: String(fields.material || "").toUpperCase(), at: Date.now() });
        break;
      default:
        break;
    }
  }

  // ── dispensing ──────────────────────────────────────────────────
  function settleDispense(result) {
    if (!pendingDispense) return;
    const { resolve, timer } = pendingDispense;
    clearTimeout(timer);
    pendingDispense = null;
    resolve(result);
  }

  function dispense(coilNumber) {
    const coil = coilOf(coilNumber);
    if (!coil) {
      return Promise.resolve({ success: false, error: `Coil must be 1 to ${COIL_COUNT}.` });
    }
    if (!boards.has("vend")) {
      return Promise.resolve({ success: false, error: "Vending board is not connected." });
    }
    if (pendingDispense) {
      return Promise.resolve({ success: false, error: "Another coil is still turning." });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingDispense = null;
        resolve({ success: false, error: "Vending board did not confirm in time." });
      }, DISPENSE_TIMEOUT_MS);

      pendingDispense = { coil, resolve, timer };

      if (!send("vend", `DISPENSE|${coil}`)) {
        clearTimeout(timer);
        pendingDispense = null;
        resolve({ success: false, error: "Could not reach the vending board." });
        return;
      }
      state.vend.lastCoil = coil;
      broadcast({ type: "dispensing", coilNumber: coil, at: Date.now() });
    });
  }

  // ── serial plumbing ─────────────────────────────────────────────
  function handleLine(role, raw) {
    const line = String(raw || "").trim();
    if (!line) return;

    const [head, ...rest] = line.split("|");
    const command = head.trim().toUpperCase();

    if (command === "LOG") {
      console.log(`[${role}] ${rest.join("|")}`);
      return;
    }

    if (command === "EVT" && role === "bin") {
      const name = String(rest[0] || "").trim().toUpperCase();
      handleBinEvent(name, parseFields(rest.slice(1)));
      return;
    }

    if (command === "OK" && String(rest[0] || "").toUpperCase() === "DISPENSE") {
      settleDispense({ success: true, coilNumber: coilOf(rest[1]) || state.vend.lastCoil });
      return;
    }

    if (command === "ERR") {
      const detail = rest.slice(1).join(" ") || "Board reported an error.";
      console.warn(`[${role}] error: ${detail}`);
      if (String(rest[0] || "").toUpperCase() === "DISPENSE") {
        settleDispense({ success: false, error: detail });
      }
      return;
    }

    if (command === "PONG" || command === "HELLO") return;

    console.log(`[${role}] ${line}`);
  }

  function dropBoard(role, why) {
    const board = boards.get(role);
    if (!board) return;
    boards.delete(role);
    claims.release(board.path);
    try {
      board.port.close();
    } catch {
      /* already gone */
    }

    if (role === "bin") {
      Object.assign(state.bin, {
        connected: false,
        path: null,
        state: "searching",
        detail: why || "Sorting bin disconnected.",
      });
    } else {
      Object.assign(state.vend, {
        connected: false,
        path: null,
        detail: why || "Vending board disconnected.",
      });
      settleDispense({ success: false, error: "Vending board disconnected." });
    }
    pushStatus();
  }

  function adoptBoard(role, path, port, reader) {
    if (boards.has(role)) return false;

    boards.set(role, { port, path });
    reader.setHandler((line) => handleLine(role, line));

    port.on("close", () => dropBoard(role));
    port.on("error", (err) => dropBoard(role, err.message));

    if (role === "bin") {
      Object.assign(state.bin, {
        connected: true,
        path,
        state: "ready",
        detail: `Sorting bin on ${path}. Waiting for an item.`,
      });
    } else {
      Object.assign(state.vend, {
        connected: true,
        path,
        detail: `Vending board on ${path}.`,
      });
    }
    console.log(`[hardware] ${role} board on ${path}`);
    pushStatus();
    return true;
  }

  // Open the port, ask WHO until the board names itself, and hand the port back
  // if it stays quiet — it is probably the QR scanner or something unrelated.
  function probe(path) {
    if (probing.has(path)) return;
    if (claims.isClaimedByOther(path, OWNER)) return;
    if (!claims.claim(path, OWNER)) return;

    probing.add(path);

    const port = new SerialPort({ path, baudRate: BAUD, autoOpen: false });

    let settled = false;
    let asker = null;
    let timer = null;

    function giveUp(why) {
      if (settled) return;
      settled = true;
      clearInterval(asker);
      clearTimeout(timer);
      probing.delete(path);
      claims.release(path);
      try {
        port.close();
      } catch {
        /* never opened */
      }
      if (why) console.log(`[hardware] ${path}: ${why}`);
    }

    const reader = attachLineReader(port, (line) => {
      if (settled) return;
      const parts = line.split("|");
      if (parts[0].trim().toUpperCase() !== "HELLO") return;

      const role = ROLE_BY_TOKEN[String(parts[1] || "").trim().toUpperCase()];
      if (!role) return;

      settled = true;
      clearInterval(asker);
      clearTimeout(timer);
      probing.delete(path);

      if (!adoptBoard(role, path, port, reader)) {
        // A second board claiming a role we already have: leave it alone.
        claims.release(path);
        try {
          port.close();
        } catch {
          /* ignore */
        }
      }
    });

    port.open((err) => {
      if (err) {
        // On the Pi this is almost always the dialout group, and it is silent
        // otherwise: the port exists, it just cannot be opened.
        if (/permission|denied|EACCES/i.test(err.message)) {
          openHint = `${path} cannot be opened: ${err.message}. Add the kiosk user to the "dialout" group, then reboot.`;
          console.warn(`[hardware] ${openHint}`);
        }
        giveUp(null);
        return;
      }
      // Opening the port resets most ESP32 boards, so keep asking while it boots.
      asker = setInterval(() => {
        try {
          port.write("WHO\n");
        } catch {
          giveUp("write failed during handshake");
        }
      }, WHO_EVERY_MS);
      timer = setTimeout(() => giveUp("no HELLO, not one of ours"), PROBE_TIMEOUT_MS);
    });

    port.on("error", () => giveUp(null));
  }

  async function scan() {
    if (boards.size >= 2) return;

    let list = [];
    try {
      list = await SerialPort.list();
    } catch (err) {
      console.warn("[hardware] port list failed:", err.message);
      return;
    }

    const mine = new Set([...boards.values()].map((board) => board.path));

    for (const portInfo of list) {
      const path = portInfo.path;
      if (!path || mine.has(path) || probing.has(path)) continue;
      if (claims.isClaimedByOther(path, OWNER)) continue;
      if (!looksLikeBoard(portInfo)) continue;

      probe(path);
    }

    if (probing.size) return;

    const before = `${state.bin.detail}${state.vend.detail}`;
    if (!state.bin.connected) {
      state.bin.detail = openHint
        || (list.length
          ? "No sorting bin answered yet. Check the USB cable, then re-plug."
          : "No USB serial ports found. Plug the ESP32 boards into the kiosk host.");
    }
    if (!state.vend.connected) {
      state.vend.detail = openHint || "No vending board answered yet. Check the USB cable.";
    }
    if (`${state.bin.detail}${state.vend.detail}` !== before) pushStatus();
  }

  // The QR scanner bridge grabs any USB-serial port it does not recognise, and a
  // CH340 could be either device, so it waits on this before it starts looking.
  const ready = scan()
    .catch(() => {})
    .then(() => {
      if (!probing.size) return undefined;
      return new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS + 500));
    });

  const scanner = setInterval(() => {
    scan().catch(() => {});
  }, RESCAN_MS);
  scanner.unref?.();

  return {
    ready: () => ready,
    getStatus: snapshot,
    dispense,
    tare: () => send("bin", "TARE"),
    claimedPaths: () => [...boards.values()].map((board) => board.path),
    // Lets the kiosk be demoed and the screens tested with no boards attached.
    simulate(event = {}) {
      if (!state.simulation) return { success: false, error: "Simulation is off." };
      if (String(event.kind || "item").toLowerCase() === "reject") {
        emitReject({ reason: event.reason, weight: event.weight, source: "simulated" });
      } else {
        emitItem({
          material: event.material || "PLASTIC",
          size: event.size || "MEDIUM",
          weight: event.weight ?? 24,
          source: "simulated",
        });
      }
      return { success: true };
    },
  };
}

module.exports = { createHardwareBridge, REJECT_REASONS, COIL_COUNT };
