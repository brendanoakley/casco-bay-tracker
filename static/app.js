/*
 * app.js — all the frontend logic for the Casco Bay dashboard.
 *
 * The flow: set up the Leaflet map once, run the GSAP entrance animation,
 * then poll the backend on timers (/api/vessels every 5 s, /api/ferry every
 * 30 s, /api/tides every 60 s, /api/featured every 60 s) and update the page
 * in place. Markers are MOVED, not recreated, so the CSS transition in
 * index.html slides them smoothly to new positions.
 *
 * Animation split: GSAP handles the choreographed stuff (entrance stagger,
 * number count-ups, panel slide-ins); plain CSS transitions handle hovers
 * and marker movement.
 */

// ───────────────────────── Config ─────────────────────────

// One muted color per vessel category — used for map markers, the KPI
// breakdown dots, and the type badge, so everything matches.
const TYPE_COLORS = {
  ferry:    "#22d3ee", // cyan
  cargo:    "#fbbf24", // amber
  tanker:   "#fb923c", // orange
  fishing:  "#34d399", // emerald
  pleasure: "#94a3b8", // slate
  other:    "#64748b", // darker slate
};

const TYPE_LABELS = {
  ferry: "Ferry / Passenger",
  cargo: "Cargo",
  tanker: "Tanker",
  fishing: "Fishing",
  pleasure: "Pleasure Craft",
  other: "Other",
};

// ───────────────────────── Entrance animation ─────────────────────────

// Everything tagged .animate-in fades up in sequence on page load.
// GSAP's stagger does the "each card 90 ms after the previous" timing.
gsap.from(".animate-in", {
  y: 24,
  opacity: 0,
  duration: 0.7,
  stagger: 0.09,
  ease: "power3.out",
  clearProps: "all", // remove inline styles afterwards so hover transforms work
});

// ───────────────────────── Number animation helper ─────────────────────────

// Smoothly counts an element from its current value to a new one instead of
// snapping. Tracks the live value on the element itself (el._val) because
// the visible text may be mid-animation.
function animateNumber(el, newVal, decimals = 0) {
  if (newVal === null || newVal === undefined || isNaN(newVal)) return;
  const from = el._val ?? 0;
  if (from === newVal && el._val !== undefined) return; // nothing to do
  el._val = newVal;
  const proxy = { v: from };
  gsap.to(proxy, {
    v: newVal,
    duration: 0.8,
    ease: "power2.out",
    onUpdate: () => { el.textContent = proxy.v.toFixed(decimals); },
  });
}

// ───────────────────────── Map setup ─────────────────────────

const map = L.map("map", { zoomControl: true }).setView([43.675, -70.155], 12);

// CartoDB "dark_all" tiles — a dark basemap that matches the slate theme.
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

const markers = {};   // mmsi -> L.Marker
let vesselData = {};  // mmsi -> latest vessel object from /api/vessels
let selectedMmsi = null;

// ───────────────────────── Markers ─────────────────────────

function iconHtml(vessel) {
  const color = TYPE_COLORS[vessel.type] || TYPE_COLORS.other;
  if (vessel.heading !== null && vessel.heading !== undefined) {
    return `<div style="color:${color}; transform: rotate(${vessel.heading}deg);" class="vessel-arrow"></div>`;
  }
  return `<div style="color:${color};" class="vessel-dot"></div>`;
}

function makeIcon(vessel) {
  return L.divIcon({
    html: iconHtml(vessel),
    // marker-selected adds the gold glow ring for the spotlighted vessel
    className: vessel.mmsi === selectedMmsi ? "marker-selected" : "",
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

/** Create a marker for a new vessel, or move/restyle an existing one. */
function upsertMarker(vessel) {
  const pos = [vessel.lat, vessel.lon];
  if (markers[vessel.mmsi]) {
    markers[vessel.mmsi].setLatLng(pos); // CSS transition slides it over
    markers[vessel.mmsi].setIcon(makeIcon(vessel));
  } else {
    const m = L.marker(pos, { icon: makeIcon(vessel) }).addTo(map);
    m.on("click", () => selectVessel(vessel.mmsi));
    markers[vessel.mmsi] = m;
  }
}

// ───────────────────────── Vessel Spotlight ─────────────────────────

// Convert an ISO country code ("US") to its flag emoji. Flag emoji are just
// two "regional indicator" characters, so we shift each letter's codepoint.
function flagEmoji(iso2) {
  if (!iso2 || iso2.length !== 2) return "";
  return [...iso2.toUpperCase()]
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join("");
}

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
const $ = (id) => document.getElementById(id);

function selectVessel(mmsi) {
  const reopened = selectedMmsi !== mmsi;
  selectedMmsi = mmsi;
  renderVesselPanel();
  if (reopened) {
    // Slide the panel in and fetch the rich info for this ship.
    const panel = $("vessel-panel");
    gsap.fromTo(panel, { x: 24, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: "power3.out" });
    loadVesselInfo(mmsi);
    // Refresh marker styling so the gold ring moves to the new selection.
    for (const v of Object.values(vesselData)) upsertMarker(v);
  }
}

function closeVesselPanel() {
  const prev = selectedMmsi;
  selectedMmsi = null;
  hide($("vessel-panel"));
  if (prev && vesselData[prev]) upsertMarker(vesselData[prev]); // drop gold ring
}

/** Fill the live-AIS half of the panel from the latest poll data. */
function renderVesselPanel() {
  const v = vesselData[selectedMmsi];
  if (!v) return;
  show($("vessel-panel"));

  $("vp-name").textContent = v.name || `MMSI ${v.mmsi}`;
  $("vp-mmsi").textContent = v.mmsi;
  $("vp-speed").textContent = v.speed !== null ? `${v.speed.toFixed(1)} kn` : "—";
  $("vp-heading").textContent = v.heading !== null ? `${Math.round(v.heading)}°` : "—";
  $("vp-pos").textContent = `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`;
  $("vp-updated").textContent = new Date(v.last_update).toLocaleTimeString();

  const badge = $("vp-type");
  const color = TYPE_COLORS[v.type] || TYPE_COLORS.other;
  badge.textContent = TYPE_LABELS[v.type] || v.type;
  badge.style.color = color;
  badge.style.backgroundColor = color + "22";
}

/** Fetch photo/specs/history from the backend and fill the lower half. */
async function loadVesselInfo(mmsi) {
  // Reset to the loading state: skeletons on, previous content off.
  hide($("vp-photo-wrap")); hide($("vp-specs")); hide($("vp-history")); hide($("vp-noinfo"));
  show($("vp-photo-skeleton")); show($("vp-specs-skeleton"));
  $("vp-flag").textContent = "";

  try {
    const res = await fetch(`/api/vessel-info?mmsi=${mmsi}`);
    const info = await res.json();
    // Stale guard: user may have clicked another ship while we waited.
    if (selectedMmsi !== mmsi) return;

    hide($("vp-photo-skeleton")); hide($("vp-specs-skeleton"));

    if (!info.found) { show($("vp-noinfo")); return; }

    if (info.flag_code) $("vp-flag").textContent = flagEmoji(info.flag_code);

    if (info.photo_url) {
      $("vp-photo").src = info.photo_url;
      $("vp-photo-credit").textContent = info.photo_credit || "";
      show($("vp-photo-wrap"));
      gsap.from($("vp-photo-wrap"), { opacity: 0, y: 8, duration: 0.4 });
    }

    // Specs: build rows only for the fields the database actually had.
    const specRows = [
      ["Length", info.length_m, (x) => `${x} m`],
      ["Beam", info.beam_m, (x) => `${x} m`],
      ["Gross tonnage", info.gross_tonnage, (x) => `${x.toLocaleString()} t`],
      ["Year built", info.year_built, (x) => x],
      ["Flag", info.flag_name, (x) => x],
      ["IMO", info.imo, (x) => x],
    ].filter(([, val]) => val !== null && val !== undefined);

    if (specRows.length) {
      $("vp-specs-list").innerHTML = specRows
        .map(([label, val, fmt]) => `
          <div class="flex justify-between">
            <dt class="text-slate-400">${label}</dt>
            <dd class="font-mono text-slate-200">${fmt(val)}</dd>
          </div>`)
        .join("");
      show($("vp-specs"));
      gsap.from($("vp-specs"), { opacity: 0, y: 8, duration: 0.4, delay: 0.05 });
    }

    // History: short timeline of dated events (build, renames, service).
    if (info.history && info.history.length) {
      $("vp-history-list").innerHTML = info.history
        .map((h) => `
          <div class="flex gap-2">
            <span class="text-gold-300 font-mono shrink-0">${h.year || "·"}</span>
            <span>${h.event}</span>
          </div>`)
        .join("");
      show($("vp-history"));
      gsap.from($("vp-history"), { opacity: 0, y: 8, duration: 0.4, delay: 0.1 });
    }

    if (!info.photo_url && !specRows.length && !(info.history || []).length) {
      show($("vp-noinfo"));
    }
  } catch (err) {
    if (selectedMmsi !== mmsi) return;
    hide($("vp-photo-skeleton")); hide($("vp-specs-skeleton"));
    show($("vp-noinfo"));
    console.error("vessel info lookup failed:", err);
  }
}

// ───────────────────────── Featured vessels ─────────────────────────

async function pollFeatured() {
  try {
    const res = await fetch("/api/featured");
    const data = await res.json();
    const row = $("featured-row");

    if (!data.featured || data.featured.length === 0) { hide(row); return; }

    const wasHidden = row.classList.contains("hidden");
    $("featured-cards").innerHTML = data.featured
      .map((f) => `
        <div class="glass lift p-3 flex gap-3 items-center cursor-pointer"
             onclick="selectVessel(${f.mmsi}); map.panTo([${f.lat}, ${f.lon}]);">
          ${f.photo_url
            ? `<img src="${f.photo_url}" class="w-16 h-16 object-cover rounded-lg border border-slate-700/60 shrink-0" alt="${f.name}" />`
            : `<div class="w-16 h-16 rounded-lg bg-slate-700/50 shrink-0 flex items-center justify-center text-2xl">⚓</div>`}
          <div class="min-w-0">
            <p class="font-semibold text-slate-100 truncate">${f.name || "MMSI " + f.mmsi}</p>
            <p class="text-xs text-slate-400 truncate">${f.reason}</p>
            <p class="text-xs font-mono text-gold-300 mt-0.5">${f.detail || ""}</p>
          </div>
        </div>`)
      .join("");

    show(row);
    if (wasHidden) {
      gsap.from("#featured-cards > div", { y: 16, opacity: 0, duration: 0.5, stagger: 0.1, ease: "power3.out", clearProps: "all" });
    }
  } catch (err) {
    console.error("featured poll failed:", err);
  }
}

// ───────────────────────── Polling: vessels ─────────────────────────

async function pollVessels() {
  try {
    const res = await fetch("/api/vessels");
    const data = await res.json();

    setStatus(data.connected, data.last_message_utc);

    // KPI: total count, animated.
    animateNumber($("kpi-total"), data.total);

    // KPI: per-type breakdown with colored dots.
    const typesEl = $("kpi-types");
    typesEl.innerHTML = Object.keys(TYPE_COLORS)
      .filter((t) => data.counts[t])
      .map((t) => `
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full" style="background:${TYPE_COLORS[t]}"></span>
          <span class="text-slate-400">${TYPE_LABELS[t].split(" ")[0]}</span>
          <span class="font-mono text-slate-200 ml-auto">${data.counts[t]}</span>
        </div>`)
      .join("") || '<span class="text-slate-500 col-span-2">no vessels yet</span>';

    // Update markers; remember which ships are still present.
    const seen = new Set();
    vesselData = {};
    for (const v of data.vessels) {
      vesselData[v.mmsi] = v;
      seen.add(v.mmsi);
      upsertMarker(v);
    }
    for (const mmsi of Object.keys(markers)) {
      if (!seen.has(Number(mmsi))) {
        map.removeLayer(markers[mmsi]);
        delete markers[mmsi];
      }
    }

    // Sidebar list of every active vessel.
    $("vessel-list").innerHTML = data.vessels
      .slice()
      .sort((a, b) => (a.name || "ZZZ").localeCompare(b.name || "ZZZ"))
      .map((v) => `
        <li class="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-slate-700/50 cursor-pointer transition-colors duration-150"
            onclick="selectVessel(${v.mmsi}); map.panTo([${v.lat}, ${v.lon}]);">
          <span class="w-2 h-2 rounded-full shrink-0" style="background:${TYPE_COLORS[v.type] || TYPE_COLORS.other}"></span>
          <span class="truncate text-slate-300">${v.name || "MMSI " + v.mmsi}</span>
          <span class="ml-auto font-mono text-xs text-slate-500">${v.speed !== null ? v.speed.toFixed(1) + " kn" : ""}</span>
        </li>`)
      .join("") || '<li class="text-slate-500 text-xs px-2">listening for AIS traffic…</li>';

    if (selectedMmsi !== null) renderVesselPanel();
  } catch (err) {
    setStatus(false, null);
    console.error("vessel poll failed:", err);
  }
}

// ───────────────────────── Polling: tides ─────────────────────────

async function pollTides() {
  try {
    const res = await fetch("/api/tides");
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    animateNumber($("kpi-tide-height"), data.height_ft, 1);

    const arrow = $("kpi-tide-arrow");
    if (data.state === "rising") {
      arrow.textContent = "▲ rising";
      arrow.className = "text-sm ml-1 text-emerald-400";
    } else if (data.state === "falling") {
      arrow.textContent = "▼ falling";
      arrow.className = "text-sm ml-1 text-amber-400";
    }

    if (data.next_tide) {
      const t = data.next_tide.time.split(" ")[1];
      $("kpi-tide-next").textContent =
        `next ${data.next_tide.type} ${t} · ${data.next_tide.height_ft.toFixed(1)} ft`;
    }
  } catch (err) {
    $("kpi-tide-next").textContent = "NOAA unavailable";
    console.error("tide poll failed:", err);
  }
}

// ───────────────────────── Polling: ferry ─────────────────────────

async function pollFerry() {
  try {
    const res = await fetch("/api/ferry");
    const data = await res.json();

    const dot = $("ferry-dot");
    const status = $("ferry-status");
    if (data.ferry_present) {
      const names = data.ferries_at_terminal.map((f) => f.name || f.mmsi).join(", ");
      dot.className = "w-2 h-2 rounded-full bg-cyan-400 breathe";
      status.textContent = `At terminal: ${names}`;
    } else {
      dot.className = "w-2 h-2 rounded-full bg-slate-500";
      status.textContent = "No ferry at terminal";
    }

    const ul = $("ferry-departures");
    if (!data.is_weekday) {
      ul.innerHTML = '<li class="text-slate-500 font-sans text-xs">weekend — weekday schedule only</li>';
    } else if (data.next_departures.length === 0) {
      ul.innerHTML = '<li class="text-slate-500 font-sans text-xs">no more departures today</li>';
    } else {
      ul.innerHTML = data.next_departures
        .map((t, i) => `
          <li class="flex justify-between">
            <span>${t}</span>
            <span class="text-xs ${i === 0 ? "text-gold-300" : "text-slate-500"} font-sans">${i === 0 ? "next" : ""}</span>
          </li>`)
        .join("");
    }
  } catch (err) {
    console.error("ferry poll failed:", err);
  }
}

// ───────────────────────── Header status + clock ─────────────────────────

let lastMessageTime = null;

function setStatus(connected, lastMessageUtc) {
  const dot = $("status-dot");
  const text = $("status-text");
  if (connected) {
    dot.className = "w-2 h-2 rounded-full bg-emerald-400 breathe";
    text.textContent = "LIVE";
    text.className = "text-xs font-medium text-emerald-400";
  } else {
    dot.className = "w-2 h-2 rounded-full bg-red-400";
    text.textContent = "DISCONNECTED";
    text.className = "text-xs font-medium text-red-400";
  }
  if (lastMessageUtc) {
    lastMessageTime = new Date(lastMessageUtc);
  } else if (lastMessageTime === null) {
    // No message ever received (quiet night) — show a dash, not a skeleton.
    $("kpi-last-update").textContent = "—";
  }
}

setInterval(() => {
  $("clock").textContent = new Date().toLocaleTimeString();
  if (lastMessageTime) {
    const secs = Math.max(0, Math.round((Date.now() - lastMessageTime) / 1000));
    $("kpi-last-update").textContent = secs; // ticks every second; animating this would be noise
  }
}, 1000);

// ───────────────────────── Sidebar toggle ─────────────────────────

function toggleSidebar() {
  const sidebar = $("sidebar");
  const btn = $("sidebar-toggle");
  const hidden = sidebar.classList.toggle("hidden");
  btn.textContent = hidden ? "Show panel" : "Hide panel";
  setTimeout(() => map.invalidateSize(), 50);
}

// ───────────────────────── Kick everything off ─────────────────────────

pollVessels();
pollTides();
pollFerry();
pollFeatured();
setInterval(pollVessels, 5000);    // every 5 s
setInterval(pollFerry, 30000);     // every 30 s
setInterval(pollTides, 60000);     // every 60 s
setInterval(pollFeatured, 60000);  // every 60 s
