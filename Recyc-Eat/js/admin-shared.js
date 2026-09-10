/* EcoNova Admin — shared shell helpers + demo data */

const AdminUI = (() => {
  function toast(title, message = "", type = "success") {
    let stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    const el = document.createElement("div");
    el.className = `toast is-${type}`;
    el.innerHTML = `<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.remove();
      if (!stack.children.length) stack.remove();
    }, 3200);
  }

  function openModal(id) {
    document.getElementById(id)?.classList.add("is-open");
  }

  function closeModal(id) {
    document.getElementById(id)?.classList.remove("is-open");
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("en-PH", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatDateTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString("en-PH", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatNumber(n) {
    return Number(n).toLocaleString("en-PH");
  }

  function playStockAlertSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();

      const run = () => {
        const now = ctx.currentTime;
        const tone = (freq, start, duration) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.14, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + duration + 0.05);
        };

        // Soft two-note chime
        tone(880, now, 0.16);
        tone(1175, now + 0.18, 0.22);
        setTimeout(() => ctx.close().catch(() => {}), 800);
      };

      if (ctx.state === "suspended") {
        ctx.resume().then(run).catch(() => {});
      } else {
        run();
      }
    } catch (_) {
      /* ignore audio errors (autoplay policy, etc.) */
    }
  }

  let lastAlertItems = [];

  function initStockAlert() {
    const content = document.querySelector(".admin-content");
    if (!content || typeof AdminData === "undefined") return;

    let alertEl = document.getElementById("stockAlert");
    if (!alertEl) {
      alertEl = document.createElement("div");
      alertEl.className = "stock-alert";
      alertEl.id = "stockAlert";
      alertEl.hidden = true;
      alertEl.setAttribute("role", "alert");
      alertEl.innerHTML = `
        <div class="stock-alert__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <path d="M12 9v4M12 17h.01"/>
          </svg>
        </div>
        <div class="stock-alert__body">
          <strong class="stock-alert__title">Low stock reminder</strong>
          <p class="stock-alert__text" id="stockAlertText"></p>
        </div>
        <div class="stock-alert__actions">
          <button class="btn btn-ghost btn-sm" type="button" id="ignoreStockBtn">Ignore</button>
          <a class="btn btn-primary btn-sm" href="food-inventory.html" id="addStockBtn">Add stock</a>
        </div>`;

      const header = content.querySelector(".page-header");
      const crumbs = content.querySelector(".breadcrumbs");
      if (header) header.after(alertEl);
      else if (crumbs) crumbs.after(alertEl);
      else content.prepend(alertEl);
    }

    if (document.body.hasAttribute("data-live-inventory")) return;
    refreshStockAlert(AdminData.getActiveStockAlerts());
  }

  function refreshStockAlert(items) {
    const content = document.querySelector(".admin-content");
    if (!content) return;

    let alertEl = document.getElementById("stockAlert");
    if (!alertEl) {
      initStockAlert();
      alertEl = document.getElementById("stockAlert");
    }
    if (!alertEl) return;

    const ignored = AdminData.getIgnoredStock();
    const activeAlerts = (items || []).filter((item) => {
      if (item.status !== "low" && item.status !== "out") return false;
      if (!(item.id in ignored)) return true;
      return Number(ignored[item.id]) !== Number(item.qty);
    });
    const textEl = document.getElementById("stockAlertText");
    const ignoreBtn = document.getElementById("ignoreStockBtn");

    if (!activeAlerts.length) {
      alertEl.hidden = true;
      return;
    }

    lastAlertItems = activeAlerts;

    const names = activeAlerts.map((i) => i.name).join(", ");
    const hasOut = activeAlerts.some((i) => i.status === "out");
    alertEl.hidden = false;
    alertEl.classList.toggle("is-critical", hasOut);
    if (textEl) {
      textEl.textContent = hasOut
        ? `${names} ${activeAlerts.length === 1 ? "is" : "are"} running low or out of stock. Restock soon so rewards stay available.`
        : `${names} ${activeAlerts.length === 1 ? "is" : "are"} running low. Add stock soon so rewards stay available.`;
    }
    const titleEl = document.getElementById("stockAlertTitle") || alertEl.querySelector(".stock-alert__title");
    if (titleEl) {
      titleEl.textContent = hasOut ? "Out of stock" : "Low stock reminder";
    }

    // Play once per alert set this session (not on every page switch)
    const soundKey = "econova_stock_sound_" + activeAlerts.map((i) => `${i.id}:${i.qty}`).join("|");
    if (sessionStorage.getItem(soundKey) !== "1") {
      sessionStorage.setItem(soundKey, "1");
      playStockAlertSound();
    }

    if (ignoreBtn && !ignoreBtn.dataset.bound) {
      ignoreBtn.dataset.bound = "1";
      ignoreBtn.addEventListener("click", () => {
        AdminData.ignoreStockAlerts(lastAlertItems);
        alertEl.hidden = true;
        toast("Reminder dismissed", "You can restock anytime from Food Inventory.");
      });
    }
  }

  function initShell() {
    const sidebar = document.getElementById("adminSidebar");
    const overlay = document.getElementById("sidebarOverlay");
    const toggle = document.getElementById("menuToggle");
    const close = () => {
      sidebar?.classList.remove("is-open");
      overlay?.classList.remove("is-open");
    };

    toggle?.addEventListener("click", () => {
      sidebar?.classList.toggle("is-open");
      overlay?.classList.toggle("is-open");
    });
    overlay?.addEventListener("click", close);

    document.querySelectorAll(".nav-link").forEach((link) => {
      if (link.getAttribute("href") === location.pathname.split("/").pop()) {
        link.classList.add("is-active");
      }
    });

    initStockAlert();
  }

  return { initShell, initStockAlert, refreshStockAlert, toast, openModal, closeModal, escapeHtml, formatDate, formatDateTime, formatNumber };
})();

/* Demo datasets used across admin pages */
const AdminData = (() => {
  const participants = [
    { id: "P-1001", name: "Ana Reyes", email: "ana.reyes@email.com", joined: "2026-07-12" },
    { id: "P-1002", name: "Ben Cruz", email: "ben.cruz@email.com", joined: "2026-07-18" },
    { id: "P-1003", name: "Carla Santos", email: "carla.s@email.com", joined: "2026-08-02" },
    { id: "P-1004", name: "Diego Lim", email: "diego.lim@email.com", joined: "2026-08-09" },
    { id: "P-1005", name: "Ella Mendoza", email: "ella.m@email.com", joined: "2026-08-15" },
    { id: "P-1006", name: "Felix Ong", email: "felix.ong@email.com", joined: "2026-08-21" },
    { id: "P-1007", name: "Gina Tan", email: "gina.tan@email.com", joined: "2026-08-28" },
    { id: "P-1008", name: "Hiro Nakamura", email: "hiro.n@email.com", joined: "2026-09-01" },
  ];

  const collections = [
    { id: "C-2401", date: "2026-09-01T09:12:00", type: "Plastic bottle", qty: 12, points: 60, receiptId: "EM-20260901-0912-001" },
    { id: "C-2402", date: "2026-09-01T11:40:00", type: "Aluminum can", qty: 8, points: 40, receiptId: "EM-20260901-1140-002" },
    { id: "C-2403", date: "2026-09-02T08:25:00", type: "Plastic bottle", qty: 15, points: 75, receiptId: "EM-20260902-0825-001" },
    { id: "C-2404", date: "2026-09-02T14:05:00", type: "Big bottle", qty: 6, points: 42, receiptId: "EM-20260902-1405-002" },
    { id: "C-2405", date: "2026-09-03T10:18:00", type: "Aluminum can", qty: 20, points: 100, receiptId: "EM-20260903-1018-001" },
    { id: "C-2406", date: "2026-09-03T16:42:00", type: "Plastic bottle", qty: 9, points: 45, receiptId: "EM-20260903-1642-002" },
    { id: "C-2407", date: "2026-09-04T09:55:00", type: "Big bottle", qty: 4, points: 28, receiptId: "EM-20260904-0955-001" },
    { id: "C-2408", date: "2026-09-04T13:20:00", type: "Plastic bottle", qty: 18, points: 90, receiptId: "EM-20260904-1320-002" },
    { id: "C-2409", date: "2026-09-05T08:10:00", type: "Aluminum can", qty: 11, points: 55, receiptId: "EM-20260905-0810-001" },
    { id: "C-2410", date: "2026-09-05T15:33:00", type: "Plastic bottle", qty: 14, points: 70, receiptId: "EM-20260905-1533-002" },
    { id: "C-2411", date: "2026-09-06T10:02:00", type: "Big bottle", qty: 7, points: 49, receiptId: "EM-20260906-1002-001" },
    { id: "C-2412", date: "2026-09-06T17:14:00", type: "Aluminum can", qty: 16, points: 80, receiptId: "EM-20260906-1714-002" },
    { id: "C-2413", date: "2026-09-07T09:28:00", type: "Plastic bottle", qty: 22, points: 110, receiptId: "EM-20260907-0928-001" },
    { id: "C-2414", date: "2026-09-07T12:45:00", type: "Aluminum can", qty: 10, points: 50, receiptId: "EM-20260907-1245-002" },
  ];

  const redemptions = [
    { id: "R-3101", receiptId: "EM-20260902-1015-001", item: "Canned Meal A", points: 50, date: "2026-09-02T10:15:00", status: "completed" },
    { id: "R-3102", receiptId: "EM-20260902-1640-002", item: "Canned Meal B", points: 50, date: "2026-09-02T16:40:00", status: "completed" },
    { id: "R-3103", receiptId: "EM-20260903-1105-001", item: "Canned Meal A", points: 50, date: "2026-09-03T11:05:00", status: "completed" },
    { id: "R-3104", receiptId: "EM-20260904-0950-001", item: "Snack Pack", points: 30, date: "2026-09-04T09:50:00", status: "pending" },
    { id: "R-3105", receiptId: "EM-20260904-1422-002", item: "Canned Meal C", points: 50, date: "2026-09-04T14:22:00", status: "completed" },
    { id: "R-3106", receiptId: "EM-20260905-0835-001", item: "Canned Meal A", points: 50, date: "2026-09-05T08:35:00", status: "pending" },
    { id: "R-3107", receiptId: "EM-20260905-1318-002", item: "Snack Pack", points: 30, date: "2026-09-05T13:18:00", status: "completed" },
    { id: "R-3108", receiptId: "EM-20260906-1044-001", item: "Canned Meal B", points: 50, date: "2026-09-06T10:44:00", status: "completed" },
    { id: "R-3109", receiptId: "EM-20260906-1510-002", item: "Canned Meal A", points: 50, date: "2026-09-06T15:10:00", status: "pending" },
    { id: "R-3110", receiptId: "EM-20260907-0905-001", item: "Canned Meal C", points: 50, date: "2026-09-07T09:05:00", status: "completed" },
    { id: "R-3111", receiptId: "EM-20260907-1130-002", item: "Snack Pack", points: 30, date: "2026-09-07T11:30:00", status: "completed" },
    { id: "R-3112", receiptId: "EM-20260907-1400-003", item: "Canned Meal A", points: 50, date: "2026-09-07T14:00:00", status: "pending" },
  ];

  let inventory = [
    { id: "F-01", name: "Canned Meal A", sku: "CMA-01", qty: 86, capacity: 120, unit: "cans", updated: "2026-09-07T08:00:00" },
    { id: "F-02", name: "Canned Meal B", sku: "CMB-01", qty: 42, capacity: 100, unit: "cans", updated: "2026-09-07T08:00:00" },
    { id: "F-03", name: "Canned Meal C", sku: "CMC-01", qty: 18, capacity: 80, unit: "cans", updated: "2026-09-06T18:20:00" },
    { id: "F-04", name: "Snack Pack", sku: "SNP-01", qty: 7, capacity: 60, unit: "packs", updated: "2026-09-07T07:45:00" },
    { id: "F-05", name: "Rice Meal Box", sku: "RMB-01", qty: 0, capacity: 40, unit: "boxes", updated: "2026-09-05T16:10:00" },
    { id: "F-06", name: "Fruit Cup", sku: "FRC-01", qty: 55, capacity: 70, unit: "cups", updated: "2026-09-07T09:10:00" },
  ];

  const inventoryLog = [
    { id: "L-1", item: "Canned Meal A", change: -1, reason: "Redemption", at: "2026-09-07T09:05:00" },
    { id: "L-2", item: "Snack Pack", change: -2, reason: "Redemption", at: "2026-09-07T11:30:00" },
    { id: "L-3", item: "Canned Meal B", change: +24, reason: "Restock", at: "2026-09-06T17:00:00" },
    { id: "L-4", item: "Rice Meal Box", change: -3, reason: "Redemption", at: "2026-09-05T15:40:00" },
    { id: "L-5", item: "Fruit Cup", change: +20, reason: "Restock", at: "2026-09-05T10:00:00" },
  ];

  const dailySeries = {
    labels: ["Sep 1", "Sep 2", "Sep 3", "Sep 4", "Sep 5", "Sep 6", "Sep 7"],
    items: [20, 21, 29, 22, 25, 23, 32],
    redemptions: [0, 2, 1, 2, 2, 2, 3],
    newParticipants: [1, 0, 1, 1, 1, 1, 0],
    activeParticipants: [12, 14, 15, 16, 18, 19, 21],
  };

  const defaults = {
    pointsSmallBottle: 5,
    pointsBigBottle: 7,
    pointsCan: 5,
    redemptionThreshold: 50,
    minRedemption: 30,
    maxRedemption: 150,
    rewardMealPoints: 50,
    rewardSnackPoints: 30,
    kioskOpen: true,
    autoPrint: true,
    sessionTimeout: 90,
    lowStockAlert: 15,
  };

  function stockStatus(item) {
    if (item.qty <= 0) return "out";
    const ratio = item.qty / item.capacity;
    if (ratio <= 0.2 || item.qty <= 15) return "low";
    return "ok";
  }

  function getInventory() {
    return inventory.map((i) => ({ ...i, status: stockStatus(i) }));
  }

  function setInventory(next) {
    inventory = next;
  }

  function getSettings() {
    const saved = localStorage.getItem("econova_admin_settings");
    return saved ? { ...defaults, ...JSON.parse(saved) } : { ...defaults };
  }

  function saveSettings(data) {
    localStorage.setItem("econova_admin_settings", JSON.stringify(data));
  }

  /* Ignore map: { itemId: qtyWhenIgnored }. Alert returns if qty changes. */
  function getIgnoredStock() {
    try {
      return JSON.parse(localStorage.getItem("econova_ignored_stock") || "{}");
    } catch {
      return {};
    }
  }

  function ignoreStockAlerts(items) {
    const map = getIgnoredStock();
    items.forEach((item) => {
      map[item.id] = item.qty;
    });
    localStorage.setItem("econova_ignored_stock", JSON.stringify(map));
  }

  function getActiveStockAlerts() {
    const ignored = getIgnoredStock();
    return getInventory().filter((item) => {
      if (item.status !== "low" && item.status !== "out") return false;
      if (!(item.id in ignored)) return true;
      return Number(ignored[item.id]) !== Number(item.qty);
    });
  }

  return {
    participants,
    collections,
    redemptions,
    inventoryLog,
    dailySeries,
    getInventory,
    setInventory,
    stockStatus,
    getSettings,
    saveSettings,
    getIgnoredStock,
    ignoreStockAlerts,
    getActiveStockAlerts,
  };
})();

document.addEventListener("DOMContentLoaded", () => AdminUI.initShell());
