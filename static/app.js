/*
 * app.js — all the frontend logic for the Casco Bay dashboard.
 *
 * The flow: set up the Leaflet map once, then poll the backend on timers
 * (/api/vessels every 5 s, /api/ferry every 30 s, /api/tides every 60 s)
 * and update the page in place. Markers are MOVED, not recreated, so the
 * CSS transition in index.html slides them smoothly to new positions.
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

// ───────────────────────── Map setup ─────────────────────────

// Center the view on the middle of Casco Bay.
const map = L.map("map", { zoomControl: true }).setView([43.675, -70.155], 12);

// CartoDB "dark_all" tiles — a dark basemap that matches the slate theme.
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

// Live state: Leaflet marker objects keyed by MMSI, plus the latest vessel
// data so the sidebar can show details without refetching.
const markers = {};   // mmsi -> L.Marker
let vesselData = {};  // mmsi -> vessel object from the API
let selectedMmsi = null;

// ───────────────────────── Markers ─────────────────────────

/**
 * Build the HTML for a vessel's map icon: an arrow rotated to its heading,
 * or a plain dot if the ship isn't reporting a heading. The color comes
 * from `currentColor`, so we just set CSS `color` on the wrapper.
 */
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
    className: "", // suppress Leaflet's default white-box styling
    iconSize: [16, 16],
    iconAnchor: [8, 8], // anchor at the center so rotation looks right
  });
}

/** Create a marker for a new vessel, or move/restyle an existing one. */
function upsertMarker(vessel) {
  const pos = [vessel.lat, vessel.lon];
  if (markers[vessel.mmsi]) {
    // Existing ship: slide it to the new position (CSS handles the easing)
    // and refresh the icon in case its heading or type changed.
    markers[vessel.mmsi].setLatLng(pos);
    markers[vessel.mmsi].setIcon(makeIcon(vessel));
  } else {
    const m = L.marker(pos, { icon: makeIcon(vessel) }).addTo(map);
    m.on("click", () => selectVessel(vessel.mmsi));
    markers[vessel.mmsi] = m;
  }
}

// ───────────────────────── Sidebar: vessel details ─────────────────────────

function selectVessel(mmsi) {
  selectedMmsi = mmsi;
  renderVesselPanel();
}

function closeVesselPanel() {
  selectedMmsi = null;
  document.getElementById("vessel-panel").classList.add("hidden");
}

/** Fill the details panel from the latest data for the selected ship. */
function renderVesselPanel() {
  const v = vesselData[selectedMmsi];
  if (!v) return;
  const panel = document.getElementById("vessel-panel");
  panel.classList.remove("hidden");

  document.getElementById("vp-name").textContent = v.name || `MMSI ${v.mmsi}`;
  document.getElementById("vp-mmsi").textContent = v.mmsi;
  document.getElementById("vp-speed").textContent =
    v.speed !== null ? `${v.speed.toFixed(1)} kn` : "—";
  document.getElementById("vp-heading").textContent =
    v.heading !== null ? `${Math.round(v.heading)}°` : "—";
  document.getElementById("vp-pos").textContent =
    `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`;
  document.getElementById("vp-updated").textContent =
    new Date(v.last_update).toLocaleTimeString();

  // Colored type badge — translucent background of the type color.
  const badge = document.getElementById("vp-type");
  const color = TYPE_COLORS[v.type] || TYPE_COLORS.other;
  badge.textContent = TYPE_LABELS[v.type] || v.type;
  badge.style.color = color;
  badge.style.backgroundColor = color + "22"; // hex alpha ≈ 13% opacity
}

// ───────────────────────── Polling: vessels ─────────────────────────

async function pollVessels() {
  try {
    const res = await fetch("/api/vessels");
    const data = await res.json();

    // Connection indicator in the header.
    setStatus(data.connected, data.last_message_utc);

    // KPI: total count.
    document.getElementById("kpi-total").textContent = data.total;

    // KPI: per-type breakdown with colored dots.
    const typesEl = document.getElementById("kpi-types");
    typesEl.innerHTML = Object.keys(TYPE_COLORS)
      .filter((t) => data.counts[t])
      .map((t) => `
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full" style="background:${TYPE_COLORS[t]}"></span>
          <span class="text-slate-400">${TYPE_LABELS[t].split(" ")[0]}</span>
          <span class="font-mono text-slate-200 ml-auto">${data.counts[t]}</span>
        </div>`)
      .join("") || '<span class="text-slate-500">no vessels yet</span>';

    // Update markers; remember which ships are still present.
    const seen = new Set();
    vesselData = {};
    for (const v of data.vessels) {
      vesselData[v.mmsi] = v;
      seen.add(v.mmsi);
      upsertMarker(v);
    }

    // Remove markers for ships that went stale and dropped out of the feed.
    for (const mmsi of Object.keys(markers)) {
      if (!seen.has(Number(mmsi))) {
        map.removeLayer(markers[mmsi]);
        delete markers[mmsi];
      }
    }

    // Sidebar list of every active vessel.
    const list = document.getElementById("vessel-list");
    list.innerHTML = data.vessels
      .slice()
      .sort((a, b) => (a.name || "ZZZ").localeCompare(b.name || "ZZZ"))
      .map((v) => `
        <li class="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-slate-700/50 cursor-pointer"
            onclick="selectVessel(${v.mmsi}); map.panTo([${v.lat}, ${v.lon}]);">
          <span class="w-2 h-2 rounded-full shrink-0" style="background:${TYPE_COLORS[v.type] || TYPE_COLORS.other}"></span>
          <span class="truncate text-slate-300">${v.name || "MMSI " + v.mmsi}</span>
          <span class="ml-auto font-mono text-xs text-slate-500">${v.speed !== null ? v.speed.toFixed(1) + " kn" : ""}</span>
        </li>`)
      .join("") || '<li class="text-slate-500 text-xs px-2">listening for AIS traffic…</li>';

    // Keep the details panel fresh if a vessel is selected.
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

    document.getElementById("kpi-tide-height").textContent = data.height_ft.toFixed(1);

    // ▲ rising / ▼ falling arrow next to the height.
    const arrow = document.getElementById("kpi-tide-arrow");
    if (data.state === "rising") {
      arrow.textContent = "▲ rising";
      arrow.className = "text-sm ml-1 text-emerald-400";
    } else if (data.state === "falling") {
      arrow.textContent = "▼ falling";
      arrow.className = "text-sm ml-1 text-amber-400";
    }

    if (data.next_tide) {
      const t = data.next_tide.time.split(" ")[1]; // "2026-06-11 17:42" -> "17:42"
      document.getElementById("kpi-tide-next").textContent =
        `next ${data.next_tide.type} ${t} · ${data.next_tide.height_ft.toFixed(1)} ft`;
    }
  } catch (err) {
    document.getElementById("kpi-tide-next").textContent = "NOAA unavailable";
    console.error("tide poll failed:", err);
  }
}

// ───────────────────────── Polling: ferry ─────────────────────────

async function pollFerry() {
  try {
    const res = await fetch("/api/ferry");
    const data = await res.json();

    const dot = document.getElementById("ferry-dot");
    const status = document.getElementById("ferry-status");
    if (data.ferry_present) {
      const names = data.ferries_at_terminal.map((f) => f.name || f.mmsi).join(", ");
      dot.className = "w-2 h-2 rounded-full bg-cyan-400 pulse";
      status.textContent = `At terminal: ${names}`;
    } else {
      dot.className = "w-2 h-2 rounded-full bg-slate-500";
      status.textContent = "No ferry at terminal";
    }

    const ul = document.getElementById("ferry-departures");
    if (!data.is_weekday) {
      ul.innerHTML = '<li class="text-slate-500 font-sans text-xs">weekend — weekday schedule only</li>';
    } else if (data.next_departures.length === 0) {
      ul.innerHTML = '<li class="text-slate-500 font-sans text-xs">no more departures today</li>';
    } else {
      ul.innerHTML = data.next_departures
        .map((t, i) => `
          <li class="flex justify-between">
            <span>${t}</span>
            <span class="text-xs text-slate-500 font-sans">${i === 0 ? "next" : ""}</span>
          </li>`)
        .join("");
    }
  } catch (err) {
    console.error("ferry poll failed:", err);
  }
}

// ───────────────────────── Header status + clock ─────────────────────────

let lastMessageTime = null; // Date of the most recent AIS message

function setStatus(connected, lastMessageUtc) {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (connected) {
    dot.className = "w-2 h-2 rounded-full bg-emerald-400 pulse";
    text.textContent = "LIVE";
    text.className = "text-xs font-medium text-emerald-400";
  } else {
    dot.className = "w-2 h-2 rounded-full bg-red-400";
    text.textContent = "DISCONNECTED";
    text.className = "text-xs font-medium text-red-400";
  }
  if (lastMessageUtc) lastMessageTime = new Date(lastMessageUtc);
}

// Tick once a second: header clock + "seconds since last AIS message" KPI.
setInterval(() => {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();
  if (lastMessageTime) {
    const secs = Math.max(0, Math.round((Date.now() - lastMessageTime) / 1000));
    document.getElementById("kpi-last-update").textContent = secs;
  }
}, 1000);

// ───────────────────────── Sidebar toggle ─────────────────────────

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const btn = document.getElementById("sidebar-toggle");
  const hidden = sidebar.classList.toggle("hidden");
  btn.textContent = hidden ? "Show panel" : "Hide panel";
  // The map's container changed size, so tell Leaflet to recalculate.
  setTimeout(() => map.invalidateSize(), 50);
}

// ───────────────────────── Kick everything off ─────────────────────────

pollVessels();
pollTides();
pollFerry();
setInterval(pollVessels, 5000);   // every 5 s
setInterval(pollFerry, 30000);    // every 30 s
setInterval(pollTides, 60000);    // every 60 s
