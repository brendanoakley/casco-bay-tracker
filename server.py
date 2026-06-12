"""
server.py — the web server for the Casco Bay vessel dashboard.

Flask serves two kinds of things:
  1. The frontend (static/index.html + app.js) at "/"
  2. JSON API endpoints the frontend polls:
       /api/vessels — live vessel positions from the AIS feed
       /api/tides   — current water level + next high/low from NOAA
       /api/ferry   — Peaks Island ferry schedule vs. what we actually see

The AIS websocket client (ais_client.py) runs on a background thread that
this file starts at boot, so one `python server.py` runs everything.
"""

import json
import math
import os
from collections import Counter
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests
from flask import Flask, jsonify, request, send_from_directory

import ais_client
import vessel_info

app = Flask(__name__, static_folder="static")

# NOAA CO-OPS station 8418150 = Portland, ME tide gauge.
NOAA_API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
NOAA_STATION = "8418150"

# Ferry times in the config are Maine local time, so all schedule math
# happens in this timezone (handles EST/EDT automatically).
LOCAL_TZ = ZoneInfo("America/New_York")

with open(os.path.join(os.path.dirname(__file__), "ferry_schedule.json")) as f:
    FERRY_CONFIG = json.load(f)

# Cache tide responses for a minute so we don't hammer NOAA every time the
# frontend polls. {"data": ..., "fetched_at": datetime}
_tide_cache = {"data": None, "fetched_at": None}

# A vessel that hasn't reported in this long is considered gone (out of
# range, docked with AIS off, etc.) and is dropped from the live view.
STALE_AFTER = timedelta(minutes=15)


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


# ---------------------------------------------------------------------------
# /api/vessels
# ---------------------------------------------------------------------------

@app.route("/api/vessels")
def vessels():
    """Current snapshot of every vessel we've heard from recently."""
    now = datetime.now(ZoneInfo("UTC"))
    active = []

    with ais_client.VESSELS_LOCK:
        for v in ais_client.VESSELS.values():
            # Skip vessels we only have static data for (no position yet).
            if v["lat"] is None or v["last_update"] is None:
                continue
            # Skip vessels that have gone quiet.
            last = datetime.fromisoformat(v["last_update"])
            if now - last > STALE_AFTER:
                continue
            active.append(dict(v))  # copy so we're not sharing mutable state

    counts = Counter(v["type"] for v in active)
    return jsonify({
        "vessels": active,
        "counts": dict(counts),
        "total": len(active),
        "connected": ais_client.STATUS["connected"],
        "last_message_utc": ais_client.STATUS["last_message_utc"],
    })


# ---------------------------------------------------------------------------
# /api/tides
# ---------------------------------------------------------------------------

def fetch_noaa(params):
    """Small helper: GET one NOAA endpoint and return parsed JSON."""
    base = {
        "station": NOAA_STATION,
        "datum": "MLLW",            # standard tide reference level
        "time_zone": "lst_ldt",     # local time with daylight saving
        "units": "english",         # feet
        "format": "json",
    }
    base.update(params)
    r = requests.get(NOAA_API, params=base, timeout=10)
    r.raise_for_status()
    return r.json()


@app.route("/api/tides")
def tides():
    """Current water level plus the next high/low tide for Portland, ME."""
    # Serve the cached answer if it's under 60 seconds old.
    now = datetime.now(LOCAL_TZ)
    if _tide_cache["data"] and (now - _tide_cache["fetched_at"]).total_seconds() < 60:
        return jsonify(_tide_cache["data"])

    try:
        # 1. Latest measured water level.
        level = fetch_noaa({"product": "water_level", "date": "latest"})
        current = level["data"][0]
        height = float(current["v"])

        # 2. Today's + tomorrow's predicted highs/lows ("hilo"), so we can
        #    find the next one and tell whether the tide is rising or falling.
        today = now.strftime("%Y%m%d")
        tomorrow = (now + timedelta(days=1)).strftime("%Y%m%d")
        pred = fetch_noaa({
            "product": "predictions",
            "interval": "hilo",
            "begin_date": today,
            "end_date": tomorrow,
        })

        next_tide = None
        for p in pred["predictions"]:
            t = datetime.strptime(p["t"], "%Y-%m-%d %H:%M").replace(tzinfo=LOCAL_TZ)
            if t > now:
                next_tide = {
                    "type": "high" if p["type"] == "H" else "low",
                    "time": p["t"],
                    "height_ft": float(p["v"]),
                }
                break

        # If the next extreme is a high, the water is rising right now.
        state = None
        if next_tide:
            state = "rising" if next_tide["type"] == "high" else "falling"

        data = {
            "height_ft": height,
            "time": current["t"],
            "state": state,
            "next_tide": next_tide,
            "station": NOAA_STATION,
        }
        _tide_cache["data"] = data
        _tide_cache["fetched_at"] = now
        return jsonify(data)

    except (requests.RequestException, KeyError, ValueError, IndexError) as e:
        return jsonify({"error": f"NOAA request failed: {e}"}), 502


# ---------------------------------------------------------------------------
# /api/ferry
# ---------------------------------------------------------------------------

def distance_km(lat1, lon1, lat2, lon2):
    """
    Haversine formula: great-circle distance between two lat/lon points.
    Over half a kilometer it's overkill, but it's the standard tool.
    """
    r = 6371  # Earth radius in km
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


@app.route("/api/ferry")
def ferry():
    """
    Compare the published Peaks Island schedule with reality: is any
    ferry-type vessel currently within ~500 m of the Portland terminal?
    """
    term = FERRY_CONFIG["terminal"]
    now = datetime.now(LOCAL_TZ)

    # Find ferries near the terminal right now.
    ferries_at_terminal = []
    with ais_client.VESSELS_LOCK:
        for v in ais_client.VESSELS.values():
            if v["type"] != "ferry" or v["lat"] is None:
                continue
            d = distance_km(v["lat"], v["lon"], term["lat"], term["lon"])
            if d <= term["radius_km"]:
                ferries_at_terminal.append({"name": v["name"], "mmsi": v["mmsi"],
                                            "distance_km": round(d, 2)})

    # Find the next few scheduled departures after the current time.
    # (Schedule is weekday-only; on weekends we just say so.)
    upcoming = []
    is_weekday = now.weekday() < 5  # Monday=0 … Friday=4
    if is_weekday:
        for hhmm in FERRY_CONFIG["weekday_departures"]:
            h, m = map(int, hhmm.split(":"))
            dep = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if dep >= now:
                upcoming.append(hhmm)
            if len(upcoming) >= 3:
                break

    return jsonify({
        "route": FERRY_CONFIG["route"],
        "is_weekday": is_weekday,
        "now_local": now.strftime("%H:%M"),
        "next_departures": upcoming,
        "ferries_at_terminal": ferries_at_terminal,
        "ferry_present": len(ferries_at_terminal) > 0,
    })


# ---------------------------------------------------------------------------
# /api/vessel-info — the Vessel Spotlight lookup
# ---------------------------------------------------------------------------

def _active_vessels():
    """Snapshot of vessels with a recent position (same rule as /api/vessels)."""
    now = datetime.now(ZoneInfo("UTC"))
    out = []
    with ais_client.VESSELS_LOCK:
        for v in ais_client.VESSELS.values():
            if v["lat"] is None or v["last_update"] is None:
                continue
            if now - datetime.fromisoformat(v["last_update"]) > STALE_AFTER:
                continue
            out.append(dict(v))
    return out


@app.route("/api/vessel-info")
def vessel_info_endpoint():
    """
    Rich record (photo, specs, history) for one vessel, by MMSI.
    The heavy lifting + caching lives in vessel_info.py; this endpoint just
    grabs the vessel's live AIS record (for its IMO number and self-reported
    dimensions) and hands everything over.
    """
    mmsi = request.args.get("mmsi", type=int)
    if not mmsi:
        return jsonify({"error": "mmsi query parameter required"}), 400

    with ais_client.VESSELS_LOCK:
        ais_record = dict(ais_client.VESSELS.get(mmsi) or {})

    info = vessel_info.lookup(mmsi, imo=ais_record.get("imo"), ais_extras=ais_record)
    return jsonify(info)


# ---------------------------------------------------------------------------
# /api/featured — auto-surface notable vessels currently in the bay
# ---------------------------------------------------------------------------

@app.route("/api/featured")
def featured():
    """
    Pick up to 3 "worth a look" vessels from whatever is in the bay right
    now: big tonnage, cruise-sized passenger ships, or anything notable
    enough to have a Wikidata photo. Most days in Casco Bay this is empty
    or just ferries — that's expected; the frontend hides the section.
    """
    candidates = []
    # Cap the external lookups per call; results are cached for an hour
    # anyway, so after the first poll this loop is nearly free.
    for v in _active_vessels()[:12]:
        info = vessel_info.lookup(v["mmsi"], imo=v.get("imo"), ais_extras=v)

        tonnage = info.get("gross_tonnage")
        length = info.get("length_m")
        is_cruise_sized = v["type"] == "ferry" and (length or 0) >= 90
        is_big = (tonnage or 0) >= 5000 or (length or 0) >= 100
        has_photo = bool(info.get("photo_url"))

        if not (is_cruise_sized or is_big or has_photo):
            continue

        # One-line reason + a gold detail figure for the card.
        if is_cruise_sized:
            reason = "Cruise ship in the bay"
        elif is_big:
            reason = "Large vessel"
        else:
            reason = "Notable vessel"
        if tonnage:
            detail = f"{int(tonnage):,} GT"
        elif length:
            detail = f"{int(length)} m"
        else:
            detail = ""

        candidates.append({
            "mmsi": v["mmsi"],
            "name": v["name"] or info.get("name"),
            "lat": v["lat"],
            "lon": v["lon"],
            "photo_url": info.get("photo_url"),
            "reason": reason,
            "detail": detail,
            # Sort key: tonnage dominates, then length.
            "_score": (tonnage or 0) * 10 + (length or 0),
        })

    candidates.sort(key=lambda c: c["_score"], reverse=True)
    top = candidates[:3]
    if top:
        top[0]["reason"] = "Largest vessel in the bay" if len(top) > 1 else top[0]["reason"]
    for c in top:
        del c["_score"]
    return jsonify({"featured": top})


if __name__ == "__main__":
    ais_client.init_db()
    ais_client.start_background_stream()
    # use_reloader=False: the reloader runs the file twice, which would open
    # two websocket connections to AISstream (and they limit you to one).
    app.run(host="127.0.0.1", port=5050, debug=False, use_reloader=False)
