/*
  W&L Athletics Van and MiFi Reservations
  Front end for GitHub Pages. Data lives in the Van Checkout 2026-27 Google Sheet,
  reached through a Google Apps Script web app (Code.gs). Sign-in uses W&L Microsoft 365.

  Layout: Vans and MiFi tabs; List or Calendar view; Display options;
  a one-step-at-a-time booking form; "Modify or Cancel Reservation" for bookings.
  A van and MiFi booked together are one reservation and always change or cancel together.
*/
(function () {
  "use strict";

  const CFG = window.VAN_CONFIG || {};
  const VANS = CFG.vans || [];
  const MIFIS = CFG.mifis || [];
  const AUTH = CFG.auth || {};
  const AUTH_ON = !!AUTH.clientId;
  const DEMO = !/^https:\/\//.test(CFG.apiUrl || "");   // no real web app link yet = demo mode
  const DOMAIN = (CFG.emailDomain || "").toLowerCase();

  const DEMO_KEY = "wlu-van-demo-v3";
  const PREFS_KEY = "wlu-van-prefs-v1";
  const DISPLAY_KEY = "wlu-van-display-v1";
  const PENDING_KEY = "wlu-van-pending-v1";
  const REFRESH_MS = 60000;
  const STEP_NAMES = ["Dates", "Van and MiFi", "Details", "Review"];

  const state = {
    reservations: [],
    tab: "vans",
    view: "table",
    listFrom: todayISO(),
    listTo: todayISO(),
    month: todayISO().slice(0, 8) + "01",
    selectedDay: todayISO(),
    anchor: null,       // first day tapped on the calendar while choosing a range
    mine: [],
    mineAdmin: false,
    highlight: "",      // reservation to point out when someone arrives from a confirmation email
    loadPromise: null
  };
  let wiz = null;      // the booking form in progress
  let msalApp = null;
  let account = null;
  let demoMemory = null;

  /* ================= Helpers ================= */

  function $(sel) { return document.querySelector(sel); }
  function pad(n) { return String(n).padStart(2, "0"); }
  function toISO(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function fromISO(s) { const p = s.split("-").map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function todayISO() { return toISO(new Date()); }
  function addDays(s, n) { const d = fromISO(s); d.setDate(d.getDate() + n); return toISO(d); }
  function addMonths(s, n) { const d = fromISO(s); d.setDate(1); d.setMonth(d.getMonth() + n); return toISO(d); }
  function fmt(s, opts) { return fromISO(s).toLocaleDateString("en-US", opts); }
  function fmtDay(s) { return fmt(s, { weekday: "short", month: "short", day: "numeric" }); }
  function fmtLong(s) { return fmt(s, { weekday: "long", month: "long", day: "numeric", year: "numeric" }); }
  function fmtRange(a, b) {
    if (a === b) return fmt(a, { month: "short", day: "numeric", year: "numeric" });
    const sameYear = a.slice(0, 4) === b.slice(0, 4);
    return fmt(a, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }) +
      " to " + fmt(b, { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtStamp(s) {
    if (!s) return "";
    const parts = s.split(" ");
    let out = fmt(parts[0], { month: "short", day: "numeric" });
    if (parts[1]) {
      const hm = parts[1].split(":").map(Number);
      out += ", " + ((hm[0] % 12) || 12) + ":" + pad(hm[1]) + (hm[0] < 12 ? " AM" : " PM");
    }
    return out;
  }
  function dayCount(a, b) { return Math.round((fromISO(b) - fromISO(a)) / 86400000) + 1; }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function vanName(id) { const v = VANS.find(function (x) { return x.id === id; }); return v ? v.name : "Van " + id; }
  function mifiName(id) { const m = MIFIS.find(function (x) { return x.id === id; }); return m ? m.name : "MiFi " + id; }
  function itemName(kind, id) { return kind === "van" ? vanName(id) : mifiName(id); }
  // "Van 208 + MiFi 3", "Van 208", or "MiFi 3"
  function itemLabel(r) {
    return [r.van ? vanName(r.van) : "", r.mifi ? mifiName(r.mifi) : ""].filter(Boolean).join(" and ");
  }
  // Words for buttons: "van and MiFi", "van", or "MiFi"
  function bundleWords(r) { return r.van && r.mifi ? "van and MiFi" : (r.van ? "van" : "MiFi"); }

  function storageGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
  function storageDel(k) { try { localStorage.removeItem(k); } catch (e) { /* storage blocked */ } }

  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 8000);
  }
  function setStatus(msg) { $("#status").textContent = msg; }

  /* ================= Reservation status ================= */

  function isReturned(r) { return r.status === "Returned" && !!r.returnedAt; }
  // Flag a missing return for two weeks after the last day (older history is not flagged)
  function isOverdue(r) { const t = todayISO(); return !isReturned(r) && r.endDate < t && r.endDate >= addDays(t, -14); }
  // Last day a reservation blocks its items. An early return frees the remaining days.
  function blockEnd(r) {
    if (isReturned(r)) {
      const rd = r.returnedAt.slice(0, 10);
      if (rd < r.endDate) return rd < r.startDate ? r.startDate : rd;
    }
    return r.endDate;
  }
  // Reservations holding this van or MiFi for any day in start..end
  function overlapping(kind, id, start, end, ignoreId) {
    return state.reservations.filter(function (r) {
      return r[kind] === id && (!ignoreId || r.id !== ignoreId) && r.startDate <= end && blockEnd(r) >= start;
    });
  }
  function isFree(kind, id, start, end, ignoreId) { return overlapping(kind, id, start, end, ignoreId).length === 0; }
  function nextFreeDay(kind, id, date) {
    let d = date;
    for (let i = 0; i < 730; i++) { if (isFree(kind, id, d, d)) return d; d = addDays(d, 1); }
    return null;
  }
  function statusOf(r) {
    const t = todayISO();
    if (isReturned(r)) return { cls: "done", text: "Returned" };
    if (r.endDate < t) return { cls: "busy", text: "Reserved" };   // past trips: no "not returned" flag
    if (r.startDate <= t) return { cls: "busy", text: "In use" };
    return { cls: "busy", text: "Reserved" };
  }
  function stTag(cls, text) { return '<span class="st ' + cls + '">' + esc(text) + "</span>"; }
  function lastReturn(kind, id) {
    return state.reservations.filter(function (r) { return r[kind] === id && isReturned(r); })
      .sort(function (a, b) { return b.returnedAt.localeCompare(a.returnedAt); })[0];
  }
  function returnLine(r) {
    if (!r) return "";
    const bits = ["Last returned " + fmtStamp(r.returnedAt)];
    if (r.returnMileage) bits.push(r.returnMileage + " mi");
    if (r.fullTank) bits.push("full tank: " + r.fullTank);
    let html = '<span class="sub">' + esc(bits.join(", ")) + "</span>";
    if (r.issues && !/^(none|no|n\/a|na|-)\.?$/i.test(r.issues.trim())) {
      html += '<span class="sub issue">Issue reported: ' + esc(r.issues) + "</span>";
    }
    return html;
  }

  /* ================= Display options ================= */

  function loadDisplay() {
    const d = storageGet(DISPLAY_KEY) || {};
    if (d.dark === undefined) {
      try { d.dark = window.matchMedia("(prefers-color-scheme: dark)").matches; } catch (e) { d.dark = false; }
    }
    if (d.rm === undefined) {
      try { d.rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { d.rm = false; }
    }
    return { size: d.size || 1, hc: !!d.hc, dark: !!d.dark, rm: !!d.rm };
  }
  function applyDisplay(d) {
    const html = document.documentElement;
    html.classList.remove("size-1", "size-2", "size-3");
    html.classList.add("size-" + d.size);
    html.classList.toggle("hc", d.hc);
    html.classList.toggle("dark", d.dark && !d.hc);
    html.classList.toggle("rm", d.rm);
    document.querySelectorAll("[data-size]").forEach(function (b) { b.setAttribute("aria-pressed", String(Number(b.dataset.size) === d.size)); });
    $("#contrastBtn").setAttribute("aria-checked", String(d.hc));
    $("#darkBtn").setAttribute("aria-checked", String(d.dark && !d.hc));
    $("#motionBtn").setAttribute("aria-checked", String(d.rm));
  }
  function setDisplay(change) {
    const d = Object.assign(loadDisplay(), change);
    if (change.hc) d.dark = false;     // high contrast and dark mode are separate looks
    if (change.dark) d.hc = false;
    storageSet(DISPLAY_KEY, d);
    applyDisplay(d);
  }

  /* ================= W&L sign-in (Microsoft 365) ================= */

  function signedInEmail() { return account ? String(account.username || "").toLowerCase() : ""; }
  function redirectUri() { return AUTH.redirectUri || (location.origin + location.pathname); }

  async function initAuth() {
    if (!AUTH_ON) { renderAuth(); return; }
    if (!window.msal) { setStatus("The W&L sign-in service did not load. Refresh the page to try again."); return; }
    msalApp = new msal.PublicClientApplication({
      auth: {
        clientId: AUTH.clientId,
        authority: "https://login.microsoftonline.com/" + (AUTH.tenantId || "organizations"),
        redirectUri: redirectUri()
      },
      cache: { cacheLocation: "localStorage" }
    });
    try {
      const result = await msalApp.handleRedirectPromise();
      if (result && result.account) account = result.account;
    } catch (e) {
      console.error(e);
      toast("Sign-in did not finish. Please try again.");
    }
    if (!account) {
      const all = msalApp.getAllAccounts();
      if (all.length) account = all[0];
    }
    if (account) msalApp.setActiveAccount(account);
    renderAuth();

    // Resume what the person started before signing in
    const pending = storageGet(PENDING_KEY);
    if (account && pending) {
      storageDel(PENDING_KEY);
      await load(true);
      if (pending.mine) openMine(); else openWizard(pending);
    }
  }
  function signIn(pending) {
    if (pending) storageSet(PENDING_KEY, pending);
    msalApp.loginRedirect({ scopes: ["User.Read"], prompt: "select_account" });
  }
  function signOut() { msalApp.logoutRedirect({ account: account, postLogoutRedirectUri: redirectUri() }); }
  // Token the Google Sheet uses to confirm who is booking (it asks Microsoft directly)
  async function getToken() {
    if (!AUTH_ON || !account) return null;
    const req = { scopes: ["User.Read"], account: account };
    try {
      return (await msalApp.acquireTokenSilent(req)).accessToken;
    } catch (e) {
      if (e instanceof msal.InteractionRequiredAuthError) { msalApp.acquireTokenRedirect(req); }
      throw e;
    }
  }
  function renderAuth() {
    const area = $("#authArea");
    if (!AUTH_ON) { area.innerHTML = ""; return; }
    area.innerHTML = account
      ? "<span>Signed in as " + esc(account.name || account.username) + '</span><button type="button" class="btn" id="signOutBtn">Sign out</button>'
      : '<button type="button" class="btn" id="signInBtn">Sign in with W&amp;L</button>';
  }

  /* ================= Data ================= */

  function normalize(r) {
    function s(v) { return v == null ? "" : String(v).trim(); }
    return {
      id: s(r.id), van: s(r.van), mifi: s(r.mifi),
      startDate: s(r.startDate).slice(0, 10), endDate: s(r.endDate).slice(0, 10),
      team: s(r.team), driver: s(r.driver), destination: s(r.destination), purpose: s(r.purpose),
      notes: s(r.notes), email: s(r.email),
      status: s(r.status) || "Reserved",
      returnedAt: s(r.returnedAt), returnMileage: s(r.returnMileage), fullTank: s(r.fullTank), issues: s(r.issues)
    };
  }

  function demoSeed() {
    const t = todayISO();
    return [
      { id: "R0001", van: "206", startDate: addDays(t, -6), endDate: addDays(t, -5), team: "Volleyball", driver: "Sample Coach", destination: "Away match",
        status: "Returned", returnedAt: addDays(t, -5) + " 21:40", returnMileage: "48210", fullTank: "Yes", issues: "None" },
      { id: "R0002", van: "97", startDate: addDays(t, -3), endDate: addDays(t, -2), team: "Men's Soccer", driver: "Sample Coach", destination: "Away game", status: "Reserved" },
      { id: "R0003", van: "208", startDate: t, endDate: t, team: "Men's Tennis", driver: "Sample Coach", destination: "Recruiting", status: "Reserved" },
      { id: "R0004", van: "140", mifi: "3", startDate: addDays(t, 1), endDate: addDays(t, 3), team: "Field Hockey", driver: "Sample Coach", destination: "Away game", status: "Reserved" },
      { id: "R0005", van: "203", startDate: addDays(t, 5), endDate: addDays(t, 6), team: "Football", driver: "Sample Coach", destination: "Scouting", status: "Reserved" },
      { id: "R0006", van: "", mifi: "5", startDate: addDays(t, 2), endDate: addDays(t, 2), team: "Volleyball", driver: "Sample Coach", destination: "Recruiting (own car)", status: "Reserved" }
    ];
  }
  function demoLoad() {
    let rows = storageGet(DEMO_KEY);
    if (!Array.isArray(rows)) rows = demoMemory || demoSeed();
    demoMemory = rows;
    storageSet(DEMO_KEY, rows);
    return rows.slice();
  }
  function demoSave(rows) { demoMemory = rows; storageSet(DEMO_KEY, rows); }

  async function fetchReservations() {
    if (DEMO) return demoLoad().map(normalize).filter(function (r) { return r.status !== "Cancelled"; });
    const res = await fetch(CFG.apiUrl + "?action=list&t=" + Date.now());
    if (!res.ok) throw new Error("List request failed (" + res.status + ")");
    const data = await res.json();
    if (data.ok === false) throw new Error(data.message || "List request failed");
    if (Array.isArray(data.teams) && data.teams.length) state.teams = data.teams;   // same choices as the van tab TEAM column
    return (data.reservations || []).map(normalize).filter(function (r) { return (r.van || r.mifi) && r.startDate && r.endDate; });
  }

  // Demo mode: same rules as the Google Sheet, saved only in this browser
  function demoApi(action, p) {
    const all = demoLoad();
    const t = todayISO();
    const clash = function (ignoreId) {
      return all.map(normalize).some(function (r) {
        const same = (p.van && r.van === p.van) || (p.mifi && r.mifi === p.mifi);
        return r.status !== "Cancelled" && same && r.id !== ignoreId && r.startDate <= p.endDate && blockEnd(r) >= p.startDate;
      });
    };
    if (action === "book") {
      if (clash(null)) return { ok: false, conflict: true };
      const id = "R" + String(all.length + 1).padStart(4, "0");
      all.push(Object.assign({}, p, { id: id, status: "Reserved" }));
      demoSave(all);
      return { ok: true, id: id };
    }
    if (action === "mine") {
      return { ok: true, reservations: all.filter(function (r) {
        return (r.status || "Reserved") === "Reserved" && r.endDate >= t && String(r.email || "").toLowerCase() === p.email;
      }) };
    }
    const r = all.find(function (x) { return x.id === p.id; });
    if (!r) return { ok: false, message: "That reservation was not found." };
    if (action === "cancel") { r.status = "Cancelled"; demoSave(all); return { ok: true, id: r.id }; }
    if (action === "update") {
      if (clash(r.id)) return { ok: false, conflict: true };
      ["van", "mifi", "startDate", "endDate", "team", "driver", "destination", "purpose", "notes"].forEach(function (k) { r[k] = p[k]; });
      demoSave(all);
      return { ok: true, id: r.id };
    }
    return { ok: false, message: "Unknown request." };
  }

  // Sends book, update, cancel, or mine to the Google Sheet
  async function api(action, payload) {
    if (DEMO) return demoApi(action, payload);
    const body = Object.assign({ action: action, token: await getToken() }, payload);
    // text/plain keeps this a "simple" request, which Google Apps Script accepts from GitHub Pages
    const res = await fetch(CFG.apiUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error("Request failed (" + res.status + ")");
    return await res.json();
  }

  function load(quiet) {
    if (state.loadPromise) return state.loadPromise;
    if (!quiet) setStatus("Loading reservations...");
    state.loadPromise = fetchReservations()
      .then(function (rows) {
        rows.sort(function (a, b) { return a.startDate.localeCompare(b.startDate); });
        state.reservations = rows;
        setStatus("Last updated " + new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
        render();
      })
      .catch(function (e) {
        console.error(e);
        setStatus("Could not load reservations. Check your connection and refresh the page.");
      })
      .finally(function () { state.loadPromise = null; });
    return state.loadPromise;
  }

  /* ================= Main page ================= */

  function rangeText() {
    const n = dayCount(state.listFrom, state.listTo);
    return state.listFrom === state.listTo ? fmtDay(state.listFrom) : fmtRange(state.listFrom, state.listTo) + " (" + plural(n, "day") + ")";
  }
  function items() {
    return state.tab === "vans"
      ? VANS.map(function (v) { return { kind: "van", id: v.id, name: v.name }; })
      : MIFIS.map(function (m) { return { kind: "mifi", id: m.id, name: m.name }; });
  }
  function anyMifiFree(start, end) { return MIFIS.some(function (m) { return isFree("mifi", m.id, start, end); }); }

  function render() {
    const vans = state.tab === "vans";
    document.querySelectorAll("[data-tab]").forEach(function (b) {
      const on = b.dataset.tab === state.tab;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $("#panel").setAttribute("aria-labelledby", vans ? "tabVans" : "tabMifi");
    document.querySelectorAll("[data-view]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.view === state.view)); });
    $("#listFrom").value = state.listFrom;
    $("#listTo").value = state.listTo;
    $("#listTo").min = state.listFrom;
    const openCount = function (list, kind) {
      return list.filter(function (x) { return isFree(kind, x.id, state.listFrom, state.listTo); }).length + " of " + list.length + " open";
    };
    $("#countVans").textContent = openCount(VANS, "van");
    $("#countMifi").textContent = openCount(MIFIS, "mifi");
    $("#panelIntro").innerHTML = vans
      ? "<strong>Add MiFi</strong> reserves the van and the next available MiFi as one reservation."
      : "Already have a van reserved? Reserve a MiFi here for the same dates. It will be a separate reservation, so you can change or cancel it on its own.";
    if (state.view === "cards") state.view = "table";
    $("#tableView").hidden = state.view !== "table";
    $("#cardsView").hidden = true;
    $("#calendarView").hidden = state.view !== "calendar";
    if (state.view === "table") renderTable();
    else if (state.view === "cards") renderCards();
    else { renderCalendar(); renderDay(); }
  }

  // Status, holders, dates, and action for one van or MiFi across the chosen range
  function describe(it) {
    const from = state.listFrom, to = state.listTo, today = todayISO();
    const hits = overlapping(it.kind, it.id, from, to);
    const d = { hits: hits, busy: hits.length > 0 };
    if (d.busy) {
      const st = statusOf(hits[0]);
      d.status = stTag(st.cls === "done" ? "done" : "busy", st.text === "Returned" ? "Returned early" : st.text);
      d.details = hits.map(function (r) {
        const other = it.kind === "van" ? (r.mifi ? ", with " + mifiName(r.mifi) : "") : (r.van ? ", with " + vanName(r.van) : "");
        return '<span class="who">' + esc((r.team || r.driver) + other) + '</span><span class="sub">' + esc(fmtRange(r.startDate, r.endDate)) + "</span>";
      }).join("");
      d.who = hits.map(function (r) { return esc(r.team); }).join("<br>");
      d.dates = hits.map(function (r) { return esc(fmtRange(r.startDate, r.endDate)); }).join("<br>");
      const free = nextFreeDay(it.kind, it.id, hits[0].startDate > from ? hits[0].startDate : from);
      d.action = '<span class="na">' + (free ? "Open again " + esc(fmtDay(free)) : "Not available") + "</span>";
    } else {
      d.status = stTag("ok", "Available");
      d.who = "None";
      d.dates = "Open " + (from === to ? "that day" : "all " + plural(dayCount(from, to), "day"));
      d.details = '<span class="na">' + d.dates + "</span>";
      if (from < today) {
        d.action = '<span class="na">Choose today or later to reserve</span>';
      } else if (it.kind === "van") {
        const canMifi = anyMifiFree(from, to);
        d.action = '<span class="grp">' +
          '<button type="button" class="btn green sm" data-reserve="van" data-id="' + esc(it.id) + '" aria-label="Reserve ' + esc(it.name) + '">Reserve</button>' +
          (canMifi
            ? '<button type="button" class="linkish" data-reserve="van+mifi" data-id="' + esc(it.id) + '" aria-label="Reserve ' + esc(it.name) + ' and add a MiFi">Add MiFi</button>'
            : '<span class="na">No MiFi open</span>') + "</span>";
      } else {
        d.action = '<span class="grp"><button type="button" class="btn green sm" data-reserve="mifi" data-id="' + esc(it.id) + '" aria-label="Reserve ' + esc(it.name) + '">Reserve</button></span>';
      }
    }
    d.extra = 
      (it.kind === "van" ? returnLine(lastReturn("van", it.id)) : "");
    return d;
  }

  function renderTable() {
    const vans = state.tab === "vans";
    const rows = items().map(function (it) {
      const d = describe(it);
      return '<tr class="' + (d.busy ? "busy" : "") + '"><th scope="row">' + esc(it.name) + "</th>" +
        '<td class="status-cell">' + d.status + "</td>" +
        '<td class="details' + (d.busy || d.extra ? "" : " open-row") + '">' + d.details + d.extra + "</td>" +
        '<td class="actions">' + d.action + "</td></tr>";
    }).join("");
    $("#tableView").innerHTML = "<table><caption>" + (vans ? "Vans" : "MiFi") + ", " + esc(rangeText()) + "</caption>" +
      '<thead><tr><th scope="col">' + (vans ? "Van" : "MiFi") + '</th><th scope="col">Status</th><th scope="col">Details</th><th scope="col" class="right">Action</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table>";
  }

  function renderCards() {
    const today = todayISO();
    $("#cardsView").innerHTML = items().map(function (it) {
      const d = describe(it);
      const upcoming = state.reservations.filter(function (r) { return r[it.kind] === it.id && !isReturned(r) && r.endDate >= today; });
      const list = upcoming.length
        ? '<ul class="trips">' + upcoming.map(function (r) {
            return "<li><strong>" + esc(fmtRange(r.startDate, r.endDate)) + "</strong>, " + esc(r.team) + " " + stTag(statusOf(r).cls, statusOf(r).text) + "</li>";
          }).join("") + "</ul>"
        : '<p class="hint">No upcoming reservations.</p>';
      return '<article class="card"><h3>' + esc(it.name) + "</h3><p>" + d.status + "</p>" +
        (d.busy ? "<p>" + d.who + "<br>" + d.dates + "</p>" : "<p>" + d.dates + "</p>") + d.extra +
        "<h4>Upcoming reservations</h4>" + list + "<div>" + d.action + "</div></article>";
    }).join("");
  }

  function renderCalendar() {
    const m = state.month, today = todayISO(), kind = state.tab === "vans" ? "van" : "mifi";
    const first = fromISO(m);
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    const start = addDays(m, -first.getDay());
    $("#calHeading").textContent = fmt(m, { month: "long", year: "numeric" }) + (kind === "van" ? ", vans" : ", MiFi");
    let html = "";
    for (let w = 0; w < weeks; w++) {
      const ws = addDays(start, w * 7), we = addDays(ws, 6);
      // Reservations that touch this week, drawn as one bar across their days
      const res = state.reservations
        .filter(function (r) { return r[kind] && r.startDate <= we && blockEnd(r) >= ws; })
        .sort(function (a, b) { return a.startDate.localeCompare(b.startDate) || blockEnd(b).localeCompare(blockEnd(a)); });
      const laneEnds = [];
      const bars = res.map(function (r) {
        const s0 = r.startDate < ws ? ws : r.startDate;
        const e0 = blockEnd(r) > we ? we : blockEnd(r);
        const c1 = dayCount(ws, s0), c2 = dayCount(ws, e0);
        let lane = laneEnds.findIndex(function (end) { return end < c1; });
        if (lane === -1) { lane = laneEnds.length; laneEnds.push(c2); } else laneEnds[lane] = c2;
        const st = statusOf(r);
        const name = kind === "van" ? vanName(r.van) : mifiName(r.mifi);
        const cls = ["cal-bar", st.cls === "busy" ? "" : st.cls, r.startDate < ws ? "cont-l" : "", blockEnd(r) > we ? "cont-r" : ""].join(" ");
        return '<span class="' + cls + '" aria-hidden="true" title="' + esc(name + ", " + r.team + ", " + fmtRange(r.startDate, r.endDate)) + '" style="grid-column:' + c1 + " / " + (c2 + 1) +
          ";grid-row:" + (lane + 2) + '"><span class="bar-text">' + esc(name) + " &middot; " + esc(r.team) + "</span></span>";
      });
      let days = "";
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i);
        const here = res.filter(function (r) { return r.startDate <= d && blockEnd(r) >= d; });
        const cls = ["day"];
        if (d.slice(0, 7) !== m.slice(0, 7)) cls.push("out");
        if (d < today) cls.push("past");
        if (d === today) cls.push("today");
        const inRange = d >= state.listFrom && d <= state.listTo;
        if (inRange) cls.push("in-range");
        if (d === state.listFrom) cls.push("range-start");
        if (d === state.listTo) cls.push("range-end");
        const label = fmtLong(d) + ": " + (here.length
          ? here.length + " reserved. " + here.map(function (r) { return itemName(kind, r[kind]) + ", " + r.team + ", " + fmtRange(r.startDate, r.endDate) + ", " + statusOf(r).text; }).join("; ")
          : "everything open");
        days += '<button type="button" class="' + cls.join(" ") + '" style="grid-column:' + (i + 1) + '" data-day="' + d + '" aria-pressed="' + inRange + '" aria-label="' + esc(label) + '">' +
          '<span class="daynum" aria-hidden="true">' + fromISO(d).getDate() + "</span></button>";
      }
      html += '<div class="cal-week" style="--lanes:' + Math.max(1, laneEnds.length) + '">' + days + bars.join("") + "</div>";
    }
    $("#calGrid").innerHTML = html;
  }

  // Below the calendar: what is open for the dates chosen above (or tapped on the calendar)
  function renderDay() {
    $("#dayHeading").textContent = rangeText();
    $("#dayDetail").innerHTML = '<ul class="day-list">' + items().map(function (it) {
      const d = describe(it);
      return '<li><span class="name">' + esc(it.name) + "</span>" + d.status +
        '<span class="info">' + d.details + "</span>" + '<span class="act">' + d.action + "</span></li>";
    }).join("") + "</ul>";
  }

  /* ================= Booking and modifying: one step at a time ================= */

  // opts: { mode: "van"|"mifi", van, mifi, start, end, editing, step }
  function openWizard(opts) {
    opts = opts || {};
    if (AUTH_ON && !account) { signIn({ mode: opts.mode, van: opts.van, mifi: opts.mifi, start: opts.start, end: opts.end }); return; }
    const today = todayISO();
    const prefs = storageGet(PREFS_KEY) || {};
    const ed = opts.editing ? state.mine.find(function (x) { return x.id === opts.editing; }) : null;
    const start = opts.start && opts.start >= today ? opts.start : today;
    const end = opts.end && opts.end >= start ? opts.end : start;
    wiz = {
      step: opts.step || 1,
      editing: ed,
      started: !!(ed && ed.startDate < today),
      mode: ed ? (ed.van ? "van" : "mifi") : (opts.mode || "van"),
      start: ed ? ed.startDate : start,
      end: ed ? ed.endDate : end,
      van: ed ? ed.van : (opts.van || ""),
      mifi: ed ? ed.mifi : (opts.mifi || ""),
      // A MiFi on its own starts clean: nothing from a van reservation carries over except your name and email
      team: ed ? ed.team : ((opts.mode || "van") === "mifi" ? "" : (prefs.team || "")),
      driver: ed ? ed.driver : (prefs.driver || (account ? account.name || "" : "")),
      email: ed ? ed.email : (prefs.email || ""),
      destination: ed ? ed.destination : "",
      purpose: ed ? ed.purpose : "",
      notes: ed ? ed.notes : ""
    };
    $("#bookKicker").textContent = ed ? "Modify reservation " + ed.id : "New reservation";
    $("#bookTitle").textContent = ed ? "Modify " + itemLabel(ed) : (wiz.mode === "mifi" ? "Reserve a MiFi" : "Reserve a van");
    $("#formError").textContent = "";
    $("#signedInAs").hidden = !(AUTH_ON && account);
    if (AUTH_ON && account) $("#signedInAs").textContent = "Reserving as " + (account.name || "") + " (" + signedInEmail() + ")";
    renderWizard();
    if (!$("#bookDialog").open) $("#bookDialog").showModal();
    const first = $("#wizBody").querySelector("input:not([disabled]), select");
    if (first) first.focus();
  }

  // Why a van or MiFi can't be picked for the chosen dates (empty if it can)
  function whyNot(kind, id) {
    if (wiz.started && wiz.editing && wiz.editing[kind] !== id) return "Your trip has already started, so this can't be switched.";
    const hit = overlapping(kind, id, wiz.start, wiz.end, wiz.editing ? wiz.editing.id : null)[0];
    return hit ? "Reserved: " + hit.team + ", " + fmtRange(hit.startDate, hit.endDate) : "";
  }

  function choiceHtml(name, value, label, reason, checked) {
    return '<label class="choice' + (reason ? " unavailable" : "") + '"><input type="radio" name="' + name + '" value="' + esc(value) + '"' +
      (checked && !reason ? " checked" : "") + (reason ? " disabled" : "") + "><span>" + esc(label) +
      (reason ? '<span class="why">' + esc(reason) + "</span>" : "") + "</span></label>";
  }

  function renderWizard() {
    const s = wiz.step;
    $("#steps").innerHTML = STEP_NAMES.map(function (n, i) {
      const k = i + 1;
      return '<li class="' + (k < s ? "done" : k === s ? "now" : "") + '"' + (k === s ? ' aria-current="step"' : "") +
        '><span class="bar"></span><span>' + (k === 2 && wiz.mode === "mifi" ? "MiFi" : n) + (k < s ? '<span class="vh"> (done)</span>' : "") + "</span></li>";
    }).join("");
    $("#backBtn").hidden = s === 1;
    $("#nextBtn").textContent = s < 4 ? "Continue" : (wiz.editing ? "Save changes" : "Reserve");
    $("#nextBtn").className = "btn " + (s < 4 ? "navy" : "green");
    $("#wizHint").hidden = s === 4;
    $("#wizHint").textContent = wiz.editing ? "Nothing changes until you save on the last step." : "Nothing is reserved until you confirm on the last step.";
    const body = $("#wizBody");
    const n = dayCount(wiz.start, wiz.end);
    const datesBar = '<div class="summary-bar"><span><strong>' + esc(fmtRange(wiz.start, wiz.end)) + '</strong> <span class="na">&nbsp;' + plural(n, "day") + "</span></span>" +
      '<button type="button" class="linkish" data-goto="1">Change dates</button></div>';

    if (s === 1) {
      body.innerHTML =
        "<fieldset><legend>When do you need it?</legend>" +
        '<p class="hint">Reservations are for full days, from 12:00 AM on the first day to 11:59 PM on the last day.</p>' +
        '<div class="row2"><label for="wStart">First day<input type="date" id="wStart" value="' + wiz.start + '" min="' + (wiz.started ? wiz.start : todayISO()) + '"' + (wiz.started ? " disabled" : "") + "></label>" +
        '<label for="wEnd">Last day<input type="date" id="wEnd" value="' + wiz.end + '" min="' + (wiz.start > todayISO() ? wiz.start : todayISO()) + '"></label></div>' +
        '<p class="hint" id="wDays">' + plural(n, "full day") + ": " + esc(fmtRange(wiz.start, wiz.end)) + "</p>" +
        (wiz.started ? '<p class="note-box">This trip has already started, so the first day, van, and MiFi stay the same. You can change the last day and your details.</p>' : "") +
        "</fieldset>";
    } else if (s === 2) {
      let html = datesBar;
      if (wiz.mode === "van") {
        const open = VANS.filter(function (v) { return !whyNot("van", v.id); }).length;
        html += '<fieldset><legend>Van</legend><p class="hint">' + open + " of " + VANS.length + " open for these dates. Unavailable vans show who has them.</p>" +
          '<div class="choices">' + VANS.map(function (v) { return choiceHtml("wVan", v.id, v.name, whyNot("van", v.id), wiz.van === v.id); }).join("") + "</div></fieldset>";
        html += '<fieldset><legend>MiFi <span class="opt">optional</span></legend><p class="hint">Reserved with a van, it stays with the van if you modify or cancel.</p>' +
          '<div class="choices">' + choiceHtml("wMifi", "", "No MiFi", wiz.started && wiz.editing && wiz.editing.mifi ? "Your trip has already started, so this can't be switched." : "", !wiz.mifi) +
          MIFIS.map(function (m) { return choiceHtml("wMifi", m.id, m.name, whyNot("mifi", m.id), wiz.mifi === m.id); }).join("") + "</div></fieldset>";
      } else {
        const open = MIFIS.filter(function (m) { return !whyNot("mifi", m.id); }).length;
        html += '<fieldset><legend>MiFi</legend><p class="hint">' + open + " of " + MIFIS.length + " open for these dates. Unavailable MiFis show who has them.</p>" +
          '<div class="choices">' + MIFIS.map(function (m) { return choiceHtml("wMifi", m.id, m.name, whyNot("mifi", m.id), wiz.mifi === m.id); }).join("") + "</div></fieldset>";
      }
      body.innerHTML = html;
    } else if (s === 3 && wiz.mode === "mifi") {
      // MiFi on its own: the same questions as the MiFi sign-out tabs (Name, Sport if applicable, Reason)
      const sports = (state.teams || CFG.teams || []).filter(function (t) { return !/^other/i.test(t); });
      body.innerHTML =
        '<fieldset><legend>Your details</legend><div class="wiz-body">' +
        '<label for="wDriver">Your name<input type="text" id="wDriver" autocomplete="name" value="' + esc(wiz.driver) + '"></label>' +
        (AUTH_ON ? "" : '<label for="wEmail">W&amp;L email<span class="field-hint">Your confirmation is sent here</span><input type="email" id="wEmail" autocomplete="email" placeholder="name@wlu.edu" value="' + esc(wiz.email) + '"></label>') +
        '<label for="wSport">Sport (if applicable)<select id="wSport"><option value="">Not applicable</option>' +
        sports.map(function (t) { return '<option value="' + esc(t) + '"' + (t === wiz.team ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") +
        "</select></label>" +
        '<label for="wPurpose">Reason<span class="field-hint">For example team travel or recruiting</span><input type="text" id="wPurpose" value="' + esc(wiz.purpose) + '"></label>' +
        "</div></fieldset>";
    } else if (s === 3) {
      const teams = state.teams || CFG.teams || [];
      // "Other / Non-Athletics" (from the sheet's list) is for lending to other departments: it asks for their name,
      // which is saved as the team. The van tab shows "Other / Non-Athletics" with that name in PURPOSE.
      const otherOpt = teams.filter(function (t) { return /^other/i.test(t); })[0] || "";
      const regular = teams.filter(function (t) { return t !== otherOpt; });
      const isOther = !!wiz.team && regular.indexOf(wiz.team) === -1;
      const group = isOther && wiz.team !== otherOpt ? wiz.team : "";
      body.innerHTML =
        '<fieldset><legend>Your details</legend><div class="wiz-body">' +
        '<label for="wTeam">Team<select id="wTeam"><option value="">Choose a team</option>' +
        regular.map(function (t) { return '<option value="' + esc(t) + '"' + (t === wiz.team ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") +
        '<option value="__other"' + (isOther ? " selected" : "") + ">" + esc(otherOpt || "Other / Non-Athletics") + "</option></select></label>" +
        '<label for="wOther"' + (isOther ? "" : " hidden") + ' id="wOtherWrap">Department or group borrowing the van<span class="field-hint">For example Dining Services or Admissions</span><input type="text" id="wOther" value="' + esc(group) + '"></label>' +
        '<label for="wDriver">Driver name<input type="text" id="wDriver" autocomplete="name" value="' + esc(wiz.driver) + '"></label>' +
        (AUTH_ON ? "" : '<label for="wEmail">W&amp;L email<input type="email" id="wEmail" autocomplete="email" placeholder="name@wlu.edu" value="' + esc(wiz.email) + '"></label>') +
        '<label for="wDest">Location<span class="field-hint">Where you are going, for example Gettysburg, PA</span><input type="text" id="wDest" value="' + esc(wiz.destination) + '"></label>' +
        '<label for="wPurpose">Purpose<span class="field-hint">For example away game, recruiting, or practice</span><input type="text" id="wPurpose" value="' + esc(wiz.purpose) + '"></label>' +
        '<label for="wNotes">Notes (optional)<textarea id="wNotes" rows="2">' + esc(wiz.notes) + "</textarea></label></div></fieldset>";
    } else {
      const row = function (label, value, step) {
        return "<dt>" + label + "</dt><dd>" + value + "</dd>" + (step ? '<dd class="edit"><button type="button" class="linkish" data-goto="' + step + '" aria-label="Edit ' + label + '">Edit</button></dd>' : "<dd></dd>");
      };
      const email = esc(AUTH_ON && account ? signedInEmail() : wiz.email);
      if (wiz.mode === "mifi") {
        body.innerHTML =
          '<fieldset><legend>Review</legend><dl class="review">' +
          row("Dates", esc(fmtRange(wiz.start, wiz.end)) + " (" + plural(n, "full day") + ")", 1) +
          row("MiFi", esc(mifiName(wiz.mifi)), 2) +
          row("Name", esc(wiz.driver), 3) +
          row("Email", email, AUTH_ON ? 0 : 3) +
          row("Sport", esc(wiz.team || "Not applicable"), 3) +
          row("Reason", esc(wiz.purpose), 3) +
          "</dl></fieldset>" +
          '<p class="note-box">' + (wiz.editing
            ? "Nothing changes until you press <strong>Save changes</strong>."
            : "Nothing is reserved until you press <strong>Reserve</strong>. You can modify or cancel later.") + "</p>";
        return;
      }
      body.innerHTML =
        '<fieldset><legend>Review</legend><dl class="review">' +
        row("Dates", esc(fmtRange(wiz.start, wiz.end)) + " (" + plural(n, "full day") + ")", 1) +
        (wiz.mode === "van" ? row("Van", esc(vanName(wiz.van)), 2) : "") +
        row("MiFi", wiz.mifi ? esc(mifiName(wiz.mifi)) : "None", 2) +
        row("Team", esc(wiz.team), 3) +
        row("Driver", esc(wiz.driver), 3) +
        row("Email", esc(AUTH_ON && account ? signedInEmail() : wiz.email), AUTH_ON ? 0 : 3) +
        row("Location", esc(wiz.destination), 3) +
        row("Purpose", esc(wiz.purpose), 3) +
        row("Notes", esc(wiz.notes || "None"), 3) +
        "</dl></fieldset>" +
        '<p class="note-box">' + (wiz.editing
          ? "Nothing changes until you press <strong>Save changes</strong>."
          : "Nothing is reserved until you press <strong>Reserve</strong>. You can modify or cancel later.") + "</p>";
    }
  }

  // Save what is on screen into wiz
  function collect() {
    const s = wiz.step;
    if (s === 1) {
      if (!wiz.started) wiz.start = $("#wStart").value;
      wiz.end = $("#wEnd").value;
    } else if (s === 2) {
      const v = document.querySelector('input[name="wVan"]:checked');
      const m = document.querySelector('input[name="wMifi"]:checked');
      if (wiz.mode === "van") wiz.van = v ? v.value : "";
      wiz.mifi = m ? m.value : "";
    } else if (s === 3 && wiz.mode === "mifi") {
      wiz.team = $("#wSport").value;
      wiz.driver = $("#wDriver").value.trim();
      if (!AUTH_ON) wiz.email = $("#wEmail").value.trim().toLowerCase();
      wiz.purpose = $("#wPurpose").value.trim();
      wiz.destination = ""; wiz.notes = "";
    } else if (s === 3) {
      wiz.team = $("#wTeam").value === "__other" ? ($("#wOther") ? $("#wOther").value.trim() : "") : $("#wTeam").value;
      wiz.driver = $("#wDriver").value.trim();
      if (!AUTH_ON) wiz.email = $("#wEmail").value.trim().toLowerCase();
      wiz.destination = $("#wDest").value.trim();
      wiz.purpose = $("#wPurpose").value.trim();
      wiz.notes = $("#wNotes").value.trim();
    }
  }

  function checkStep() {
    const s = wiz.step, today = todayISO();
    if (s === 1) {
      if (!wiz.start || !wiz.end) return "Choose a first and last day.";
      if (wiz.start < today && !wiz.started) return "The first day can't be in the past.";
      if (wiz.end < wiz.start) return "The last day must be on or after the first day.";
      if (wiz.end < today) return "The last day can't be in the past.";
      if (CFG.maxDays && dayCount(wiz.start, wiz.end) > CFG.maxDays) return "Reservations can be at most " + CFG.maxDays + " days.";
    } else if (s === 2) {
      if (wiz.mode === "van" && !wiz.van) return "Choose a van. Greyed-out vans are already reserved for these dates.";
      if (wiz.mode === "mifi" && !wiz.mifi) return "Choose a MiFi. Greyed-out MiFis are already reserved for these dates.";
      if (wiz.van && whyNot("van", wiz.van)) return vanName(wiz.van) + " is not open for these dates. Please choose another.";
      if (wiz.mifi && whyNot("mifi", wiz.mifi)) return mifiName(wiz.mifi) + " is not open for these dates. Please choose another.";
    } else if (s === 3 && wiz.mode === "mifi") {
      if (!wiz.driver) return "Enter your name.";
      const em = AUTH_ON && account ? signedInEmail() : wiz.email;
      if (!/^[^@\s]+@[^@\s]+$/.test(em) || (DOMAIN && !em.endsWith("@" + DOMAIN))) {
        return AUTH_ON ? "Please sign in with your W&L account." : "Enter your @" + DOMAIN + " email address.";
      }
      if (!wiz.purpose) return "Enter the reason, for example team travel or recruiting.";
    } else if (s === 3) {
      if ($("#wTeam") && $("#wTeam").value === "__other" && !wiz.team) return "Enter the department or group borrowing the van.";
      if (!wiz.team) return "Choose your team.";
      if (!wiz.driver) return "Enter the driver's name.";
      if (!wiz.destination) return "Enter the location (where you are going).";
      if (!wiz.purpose) return "Enter the purpose of the trip.";
      const email = AUTH_ON && account ? signedInEmail() : wiz.email;
      if (!/^[^@\s]+@[^@\s]+$/.test(email) || (DOMAIN && !email.endsWith("@" + DOMAIN))) {
        return AUTH_ON ? "Please sign in with your W&L account." : "Enter your @" + DOMAIN + " email address.";
      }
    }
    return "";
  }

  function goStep(n) {
    wiz.step = n;
    $("#formError").textContent = "";
    // Dates changed: drop a picked van or MiFi that is no longer open
    if (n === 2) {
      if (wiz.van && whyNot("van", wiz.van)) wiz.van = "";
      if (wiz.mifi && whyNot("mifi", wiz.mifi)) wiz.mifi = "";
    }
    renderWizard();
    const h = $("#wizBody").querySelector("legend");
    if (h) { h.tabIndex = -1; h.focus(); }
  }

  async function onNext(ev) {
    ev.preventDefault();
    collect();
    const problem = checkStep();
    if (problem) { $("#formError").textContent = problem; return; }
    if (wiz.step < 4) { goStep(wiz.step + 1); return; }
    await submitWizard();
  }

  async function submitWizard() {
    const btn = $("#nextBtn");
    btn.disabled = true;
    btn.textContent = "Checking...";
    try {
      await load(true);   // latest reservations, so nobody books over someone else
      const taken = (wiz.van && whyNot("van", wiz.van)) || (wiz.mifi && whyNot("mifi", wiz.mifi));
      if (taken) {
        goStep(2);
        $("#formError").textContent = "Sorry, something you picked was just reserved by someone else. Please choose again.";
        return;
      }
      btn.textContent = wiz.editing ? "Saving..." : "Reserving...";
      const email = AUTH_ON && account ? signedInEmail() : wiz.email;
      const payload = {
        id: wiz.editing ? wiz.editing.id : undefined,
        van: wiz.mode === "van" ? wiz.van : "",
        mifi: wiz.mifi,
        startDate: wiz.start, endDate: wiz.end,
        team: wiz.team, driver: wiz.driver, email: email,
        reservedBy: account ? (account.name || email) : wiz.driver,
        destination: wiz.destination, purpose: wiz.purpose, notes: wiz.notes
      };
      const result = await api(wiz.editing ? "update" : "book", payload);
      if (!result.ok) {
        const msg = result.message || "Sorry, something you picked was just reserved. Please choose again.";
        await load(true);
        if (result.conflict) goStep(2);
        $("#formError").textContent = msg;
        return;
      }
      storageSet(PREFS_KEY, Object.assign(storageGet(PREFS_KEY) || {}, { team: wiz.team, driver: wiz.driver, email: AUTH_ON ? "" : email }));
      const label = itemLabel(payload);
      const editing = wiz.editing;
      $("#bookDialog").close();
      showDone(editing ? "modified" : "booked", {
        id: editing ? editing.id : (result.id || ""), label: label, team: payload.team,
        start: payload.startDate, end: payload.endDate, email: email
      });
      await load(true);
    } catch (x) {
      console.error(x);
      $("#formError").textContent = "Something went wrong and nothing was saved. Please try again.";
    } finally {
      btn.disabled = false;
      if (wiz) btn.textContent = wiz.step < 4 ? "Next: " + STEP_NAMES[wiz.step] : (wiz.editing ? "Save changes" : "Reserve");
    }
  }

  /* ================= Modify or Cancel Reservation ================= */

  function mineEmail() {
    if (AUTH_ON && account) return signedInEmail();
    return String($("#mineEmail").value || (storageGet(PREFS_KEY) || {}).email || "").trim().toLowerCase();
  }
  function openMine() {
    if (AUTH_ON && !account) { signIn({ mine: true }); return; }
    $("#mineList").innerHTML = "";
    $("#mineStatus").textContent = "";
    $("#mineLookup").hidden = AUTH_ON;
    if (!AUTH_ON) $("#mineEmail").value = (storageGet(PREFS_KEY) || {}).email || "";
    if (!$("#mineDialog").open) $("#mineDialog").showModal();
    if (AUTH_ON || $("#mineEmail").value) refreshMine();
  }
  async function refreshMine() {
    const email = mineEmail();
    if (!AUTH_ON && (!email || (DOMAIN && !email.endsWith("@" + DOMAIN)))) {
      $("#mineStatus").textContent = "Enter the @" + DOMAIN + " email you used when you booked.";
      return;
    }
    $("#mineStatus").textContent = "Loading...";
    try {
      const res = await api("mine", { email: email });
      if (!res.ok) { $("#mineStatus").textContent = res.message || "Could not load your reservations."; return; }
      state.mine = (res.reservations || []).map(normalize);
      state.mineAdmin = !!res.admin;
      renderMine();
      const hl = document.querySelector(".mine-item.highlight");
      if (hl) hl.scrollIntoView({ block: "nearest" });
    } catch (x) {
      console.error(x);
      $("#mineStatus").textContent = "Could not load your reservations. Please try again.";
    }
  }
  function renderMine() {
    const today = todayISO();
    $("#mineStatus").textContent = state.mine.length
      ? (state.mineAdmin ? "Admin view: all upcoming reservations." : "")
      : "You have no upcoming reservations.";
    $("#mineList").innerHTML = state.mine.map(function (r) {
      const started = r.startDate < today;
      const label = esc(itemLabel(r));
      return '<li class="mine-item' + (started ? " started" : "") + (r.id === state.highlight ? " highlight" : "") + '"><div><p class="what">' + label + (started ? '<span class="tag">In progress</span>' : "") + "</p>" +
        "<p>" + esc(fmtRange(r.startDate, r.endDate)) + "</p>" +
        '<p class="id">' + esc(r.team || r.driver) + (r.destination ? ", " + esc(r.destination) : (r.purpose ? ", " + esc(r.purpose) : "")) + " &middot; Confirmation " + esc(r.id) +
        (state.mineAdmin && r.email ? " &middot; " + esc(r.email) : "") + "</p></div>" +
        '<div class="btn-row">' +
        (started && !state.mineAdmin ? "" : '<button type="button" class="btn danger sm" data-cancel="' + esc(r.id) + '" aria-label="Cancel ' + label + '">Cancel</button>') +
        '<button type="button" class="btn ' + (started ? "quiet" : "navy") + ' sm" data-modify="' + esc(r.id) + '" aria-label="Modify ' + label + '">' + (started ? "Change end date" : "Modify") + "</button>" +
        "</div></li>";
    }).join("");
  }
  async function cancelReservation(id) {
    const r = state.mine.find(function (x) { return x.id === id; });
    if (!r) return;
    const both = r.van && r.mifi ? "\n\nThe van and MiFi are booked together, so both will be cancelled." : "";
    if (!window.confirm("Cancel " + itemLabel(r) + " for " + r.team + ", " + fmtRange(r.startDate, r.endDate) + "?" + both)) return;
    $("#mineStatus").textContent = "Cancelling...";
    try {
      const res = await api("cancel", { id: id, email: mineEmail() });
      if (!res.ok) { $("#mineStatus").textContent = res.message || "Could not cancel. Please try again."; return; }
      $("#mineDialog").close();
      showDone("canceled", { id: id, label: itemLabel(r), team: r.team, start: r.startDate, end: r.endDate, email: mineEmail() });
      await load(true);
    } catch (x) {
      console.error(x);
      $("#mineStatus").textContent = "Could not cancel. Please try again.";
    }
  }

  // A clear confirmation after reserving, modifying, or canceling
  function showDone(kind, d) {
    const text = {
      booked: ["Your reservation is confirmed", "You're all set. Keep your confirmation number for your records."],
      modified: ["Your reservation has been modified", "Your changes are saved. The details below replace the earlier reservation."],
      canceled: ["Your reservation has been canceled", "It's no longer reserved, and it's open for others to reserve for those dates."]
    }[kind];
    $("#doneIcon").className = "done-icon " + kind;
    $("#doneTitle").textContent = text[0];
    $("#doneMsg").textContent = text[1];
    $("#doneDetails").innerHTML =
      "<dt>Confirmation</dt><dd>" + esc(d.id) + "</dd>" +
      "<dt>" + (kind === "canceled" ? "Was reserved" : "Reserved") + "</dt><dd>" + esc(d.label) + "</dd>" +
      "<dt>Dates</dt><dd>" + esc(fmtRange(d.start, d.end)) + "</dd>" +
      (d.team ? "<dt>Team</dt><dd>" + esc(d.team) + "</dd>" : "");
    $("#doneEmail").textContent = DEMO ? "" : "A " + (kind === "booked" ? "confirmation" : kind === "modified" ? "confirmation of the change" : "cancellation notice") +
      " email is on its way" + (d.email ? " to " + d.email : "") + ".";
    $("#doneMine").hidden = kind === "booked";
    if (!$("#doneDialog").open) $("#doneDialog").showModal();
    $("#doneClose").focus();
  }

  /* ================= Events ================= */

  // Attach a listener only if the element exists, so an older index.html never stops the whole page
  function on(sel, type, fn) { const el = $(sel); if (el) el.addEventListener(type, fn); }

  function wire() {
    document.addEventListener("click", function (ev) {
      const t = ev.target;
      const reserve = t.closest("[data-reserve]");
      if (reserve) {
        const kind = reserve.dataset.reserve, id = reserve.dataset.id;
        const start = reserve.dataset.date || state.listFrom, end = reserve.dataset.date || state.listTo;
        if (kind === "mifi") openWizard({ mode: "mifi", mifi: id, start: start, end: end, step: 2 });
        else {
          let mifi = "";
          if (kind === "van+mifi") { const m = MIFIS.find(function (x) { return isFree("mifi", x.id, start, end); }); mifi = m ? m.id : ""; }
          openWizard({ mode: "van", van: id, mifi: mifi, start: start, end: end, step: 2 });
        }
        return;
      }
      const go = t.closest("[data-goto]");
      if (go && wiz) { collect(); goStep(Number(go.dataset.goto)); return; }
      const modify = t.closest("[data-modify]");
      if (modify) { $("#mineDialog").close(); openWizard({ editing: modify.dataset.modify, step: 1 }); return; }
      const cancel = t.closest("[data-cancel]");
      if (cancel) { cancelReservation(cancel.dataset.cancel); return; }
      const day = t.closest("[data-day]");
      if (day) {
        if (ev.detail === 2) return;   // second click of a double-click: keep the range, the dblclick handler opens the form
        const picked = day.dataset.day;
        if (state.anchor && picked >= state.anchor) {
          state.listFrom = state.anchor; state.listTo = picked; state.anchor = null;   // second tap ends the range
        } else {
          state.listFrom = picked; state.listTo = picked; state.anchor = picked;       // first tap starts it
        }
        state.selectedDay = picked;
        if (picked.slice(0, 7) !== state.month.slice(0, 7)) state.month = picked.slice(0, 8) + "01";
        render();
        $("#calHint").textContent = state.anchor
          ? "Showing " + fmtDay(picked) + ". Tap a later day to make it a range, or double-click to reserve."
          : "Showing " + rangeText() + ". Tap any day to start a new range, or double-click to reserve.";
        const again = document.querySelector('[data-day="' + picked + '"]');
        if (again) again.focus();
        return;
      }
      const tab = t.closest("[data-tab]");
      if (tab) { state.tab = tab.dataset.tab; storageSet(PREFS_KEY + "-tab", state.tab); render(); return; }
      const view = t.closest("[data-view]");
      if (view) { state.view = view.dataset.view; storageSet(PREFS_KEY + "-view", state.view); render(); return; }
      const size = t.closest("[data-size]");
      if (size) { setDisplay({ size: Number(size.dataset.size) }); return; }
      if (t.id === "signInBtn") signIn();
      if (t.id === "signOutBtn") signOut();
    });

    // Double-click a calendar day: open the reservation form for the dates selected (that day, or the range it ends)
    document.addEventListener("dblclick", function (ev) {
      const day = ev.target.closest("[data-day]");
      if (!day) return;
      const today = todayISO();
      let start = state.listFrom, end = state.listTo;
      if (day.dataset.day < start || day.dataset.day > end) { start = end = day.dataset.day; }
      if (end < today) { toast("That day has passed. Choose today or a later day."); return; }
      if (start < today) start = today;
      state.anchor = null;
      openWizard({ mode: state.tab === "mifi" ? "mifi" : "van", start: start, end: end, step: 2 });
    });

    // Arrow keys move between the two tabs
    $(".tabs").addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      state.tab = state.tab === "vans" ? "mifi" : "vans";
      render();
      document.querySelector('[data-tab="' + state.tab + '"]').focus();
    });

    on("#displayBtn", "click", function () { $("#displayDialog").showModal(); });
    on("#closeDisplay", "click", function () { $("#displayDialog").close(); });
    on("#contrastBtn", "click", function () { setDisplay({ hc: !loadDisplay().hc }); });
    on("#darkBtn", "click", function () { setDisplay({ dark: !loadDisplay().dark }); });
    on("#motionBtn", "click", function () { setDisplay({ rm: !loadDisplay().rm }); });

    on("#reserveBtn", "click", function () {
      openWizard({ mode: state.tab === "mifi" ? "mifi" : "van", start: state.listFrom, end: state.listTo, step: 1 });
    });
    on("#mineBtn", "click", openMine);

    on("#listFrom", "change", function (e) {
      if (!e.target.value) return;
      state.listFrom = e.target.value;
      if (state.listTo < state.listFrom) state.listTo = state.listFrom;
      state.anchor = null;
      state.month = state.listFrom.slice(0, 8) + "01";
      render();
    });
    on("#listTo", "change", function (e) {
      if (!e.target.value) return;
      state.listTo = e.target.value < state.listFrom ? state.listFrom : e.target.value;
      state.anchor = null;
      render();
    });
    // Clear dates: back to today only, any half-picked calendar range dropped
    on("#clearDates", "click", function () {
      state.listFrom = todayISO(); state.listTo = todayISO(); state.anchor = null;
      state.selectedDay = todayISO(); state.month = todayISO().slice(0, 8) + "01";
      render();
      $("#calHint").textContent = "Choose dates above, or tap a start day on the calendar and then an end day. Double-click a day to reserve it.";
      setStatus("Dates cleared. Showing today.");
    });
    on("#prevMonth", "click", function () { state.month = addMonths(state.month, -1); renderCalendar(); });
    on("#nextMonth", "click", function () { state.month = addMonths(state.month, 1); renderCalendar(); });
    on("#todayBtn", "click", function () {
      state.selectedDay = todayISO(); state.month = state.selectedDay.slice(0, 8) + "01"; renderCalendar();
    });

    // Booking form
    on("#bookForm", "submit", onNext);
    on("#backBtn", "click", function () { collect(); goStep(Math.max(1, wiz.step - 1)); });
    on("#closeBook", "click", function () { $("#bookDialog").close(); });
    on("#bookDialog", "close", function () { wiz = null; });
    on("#wizBody", "change", function (e) {
      if (!wiz) return;
      if (e.target.id === "wTeam") $("#wOtherWrap").hidden = e.target.value !== "__other";
      if (e.target.id === "wStart" || e.target.id === "wEnd") {
        if (e.target.id === "wStart" && $("#wEnd").value < e.target.value) $("#wEnd").value = e.target.value;
        $("#wEnd").min = $("#wStart").value || todayISO();
        const s = $("#wStart").value, en = $("#wEnd").value;
        if (s && en && en >= s) $("#wDays").textContent = plural(dayCount(s, en), "full day") + ": " + fmtRange(s, en);
      }
    });

    // Modify or cancel
    on("#closeMine", "click", function () { $("#mineDialog").close(); });
    on("#doneClose", "click", function () { $("#doneDialog").close(); });
    on("#doneMine", "click", function () { $("#doneDialog").close(); openMine(); });
    on("#mineLookup", "submit", function (e) {
      e.preventDefault();
      storageSet(PREFS_KEY, Object.assign(storageGet(PREFS_KEY) || {}, { email: $("#mineEmail").value.trim().toLowerCase() }));
      refreshMine();
    });

    // Keep the page current (returns show up within a minute)
    setInterval(function () { if (!document.hidden && !wiz) load(true); }, REFRESH_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden && !wiz) load(true); });
  }

  /* ================= Start ================= */

  async function start() {
    applyDisplay(loadDisplay());
    $("#demoBanner").hidden = !DEMO;
    const v = storageGet(PREFS_KEY + "-view");
    if (v === "table" || v === "calendar") state.view = v;
    const t = storageGet(PREFS_KEY + "-tab");
    if (t === "vans" || t === "mifi") state.tab = t;
    wire();
    render();
    await load(false);
    await initAuth();
    fromEmailLink();
  }

  // Links in confirmation emails: ?manage=R0007&email=name@wlu.edu opens Modify or Cancel Reservation
  function fromEmailLink() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    const id = (q.get("manage") || "").trim();
    if (!id) return;
    const email = (q.get("email") || "").trim().toLowerCase();
    if (email && !AUTH_ON) storageSet(PREFS_KEY, Object.assign(storageGet(PREFS_KEY) || {}, { email: email }));
    state.highlight = id.toUpperCase();
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* keep the address as is */ }
    openMine();
  }

  start();
})();
