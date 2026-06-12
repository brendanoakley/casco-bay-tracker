"""
ais_client.py — connects to AISstream.io and keeps track of every vessel in Casco Bay.

How AIS works, in short: ships broadcast their position, speed, heading, etc. over
VHF radio. Shore stations pick those broadcasts up and services like AISstream.io
relay them to us over a websocket (a long-lived two-way internet connection,
unlike normal HTTP where you ask once and get one answer back).

This module does three jobs:
  1. Connect to the AISstream websocket and subscribe to the Casco Bay area.
  2. Parse each incoming message and update VESSELS, an in-memory dictionary
     holding the latest known state of each ship (keyed by MMSI — a ship's
     unique radio ID number, like a license plate).
  3. Log every position update to a SQLite database for future analysis.

Run it directly (`python ais_client.py`) to test the connection — it prints
each message it receives so you can confirm data is flowing.
"""

import asyncio
import json
import os
import sqlite3
import threading
import time
from datetime import datetime, timezone

import websockets
from dotenv import load_dotenv

# Read AISSTREAM_API_KEY from the .env file into environment variables.
# The key lives in .env (which is gitignored) so it never ends up on GitHub.
load_dotenv()
API_KEY = os.getenv("AISSTREAM_API_KEY")

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"

# Bounding box for Casco Bay: south-west corner to north-east corner.
# AISstream wants coordinates as [latitude, longitude] pairs.
CASCO_BAY_BBOX = [[[43.60, -70.30], [43.75, -69.95]]]

DB_PATH = os.path.join(os.path.dirname(__file__), "vessel_history.db")

# Casco Bay Lines fleet names, loaded from the ferry config. A ship's type
# code only arrives in its occasional static-data broadcast, so without this
# a known ferry would show as "other" for its first few minutes on screen.
with open(os.path.join(os.path.dirname(__file__), "ferry_schedule.json")) as _f:
    KNOWN_FERRY_NAMES = set(json.load(_f)["known_ferries"]["names"])

# ---------------------------------------------------------------------------
# Shared state
# ---------------------------------------------------------------------------

# Latest known state per vessel, keyed by MMSI. The websocket runs in a
# background thread while Flask answers requests in other threads, so we
# guard access with a lock (same idea as `synchronized` in Java).
VESSELS = {}
VESSELS_LOCK = threading.Lock()

# Connection status the frontend shows as the green/red "live" dot.
STATUS = {"connected": False, "last_message_utc": None, "messages_received": 0}


def classify_ship_type(type_code):
    """
    Translate a raw AIS ship-type code (an integer 0-99) into a readable
    category. The ranges come from the AIS standard (ITU-R M.1371):
    the tens digit is the broad category, the ones digit is detail.
    """
    if type_code is None:
        return "other"
    if 60 <= type_code <= 69:
        return "ferry"          # "passenger" in the spec — Casco Bay Lines ferries land here
    if 70 <= type_code <= 79:
        return "cargo"
    if 80 <= type_code <= 89:
        return "tanker"
    if type_code == 30:
        return "fishing"
    if type_code in (36, 37):   # 36 = sailing vessel, 37 = pleasure craft
        return "pleasure"
    return "other"


# ---------------------------------------------------------------------------
# SQLite history logging
# ---------------------------------------------------------------------------

def init_db():
    """Create the history table if it doesn't exist yet (safe to call every start)."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS positions (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT,    -- ISO 8601 UTC, e.g. 2026-06-11T14:03:22+00:00
            mmsi      INTEGER,
            type      TEXT,
            lat       REAL,
            lon       REAL,
            speed     REAL,    -- knots
            heading   REAL     -- degrees true
        )
        """
    )
    conn.commit()
    conn.close()


def log_position(mmsi, vtype, lat, lon, speed, heading):
    """Append one position row. Opens a fresh connection each time because
    SQLite connections can't be shared across threads."""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT INTO positions (timestamp, mmsi, type, lat, lon, speed, heading) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (datetime.now(timezone.utc).isoformat(), mmsi, vtype, lat, lon, speed, heading),
        )
        conn.commit()
        conn.close()
    except sqlite3.Error as e:
        # Logging is a nice-to-have; never let a DB hiccup kill the live feed.
        print(f"[db] failed to log position: {e}")


# ---------------------------------------------------------------------------
# Message handling
# ---------------------------------------------------------------------------

def handle_message(raw, verbose=False):
    """Parse one raw websocket message (a JSON string) and update VESSELS."""
    msg = json.loads(raw)
    msg_type = msg.get("MessageType")
    meta = msg.get("MetaData", {})
    mmsi = meta.get("MMSI")
    if mmsi is None:
        return

    STATUS["messages_received"] += 1
    STATUS["last_message_utc"] = datetime.now(timezone.utc).isoformat()

    # AISstream puts a cleaned-up ship name in the metadata of every message.
    name = (meta.get("ShipName") or "").strip() or None

    with VESSELS_LOCK:
        # Get this vessel's existing record, or start a blank one.
        vessel = VESSELS.setdefault(mmsi, {
            "mmsi": mmsi,
            "name": None,
            "type": "other",
            "type_code": None,
            "lat": None,
            "lon": None,
            "speed": None,      # knots
            "heading": None,    # degrees
            "last_update": None,
        })
        if name:
            vessel["name"] = name
            # Known Casco Bay Lines boat? Call it a ferry right away rather
            # than waiting for its static data. A real type code (set below
            # when static data does arrive) still takes priority.
            if vessel["type_code"] is None and name.upper() in KNOWN_FERRY_NAMES:
                vessel["type"] = "ferry"

        if msg_type == "PositionReport":
            # The actual movement data lives under Message -> PositionReport.
            body = msg.get("Message", {}).get("PositionReport", {})
            vessel["lat"] = body.get("Latitude")
            vessel["lon"] = body.get("Longitude")
            vessel["speed"] = body.get("Sog")  # Sog = "speed over ground"
            # 511 is AIS-speak for "heading sensor not available".
            hdg = body.get("TrueHeading")
            vessel["heading"] = None if hdg == 511 else hdg
            vessel["last_update"] = datetime.now(timezone.utc).isoformat()

            log_position(mmsi, vessel["type"], vessel["lat"], vessel["lon"],
                         vessel["speed"], vessel["heading"])
            if verbose:
                print(f"[pos] {vessel['name'] or mmsi}: "
                      f"({vessel['lat']:.4f}, {vessel['lon']:.4f}) "
                      f"{vessel['speed']} kn")

        elif msg_type == "ShipStaticData":
            # Static data messages carry the ship's self-reported type code.
            # Position reports don't include it, so we remember it here.
            body = msg.get("Message", {}).get("ShipStaticData", {})
            code = body.get("Type")
            if code is not None:
                vessel["type_code"] = code
                vessel["type"] = classify_ship_type(code)
            if verbose:
                print(f"[static] {vessel['name'] or mmsi}: type={vessel['type']} (code {code})")


# ---------------------------------------------------------------------------
# Websocket connection loop
# ---------------------------------------------------------------------------

async def stream_ais(verbose=False):
    """
    Connect, subscribe, and process messages forever. If the connection drops
    (wifi blip, server restart, etc.) we wait a few seconds and reconnect —
    a dashboard that silently dies isn't much of a dashboard.
    """
    if not API_KEY:
        raise RuntimeError("AISSTREAM_API_KEY is not set — copy .env.example to .env "
                           "and add your key from aisstream.io")

    subscription = json.dumps({
        "APIKey": API_KEY,
        "BoundingBoxes": CASCO_BAY_BBOX,
        # Only the two message types we care about — less junk to parse.
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    })

    while True:
        try:
            async with websockets.connect(AISSTREAM_URL) as ws:
                # AISstream requires the subscription within 3 s of connecting.
                await ws.send(subscription)
                STATUS["connected"] = True
                print("[ais] connected to AISstream, watching Casco Bay…")
                async for raw in ws:
                    try:
                        handle_message(raw, verbose=verbose)
                    except (json.JSONDecodeError, KeyError, TypeError) as e:
                        print(f"[ais] skipped a malformed message: {e}")
        except Exception as e:
            STATUS["connected"] = False
            print(f"[ais] connection lost ({e}); reconnecting in 5 s…")
            await asyncio.sleep(5)


def start_background_stream():
    """
    Start the websocket loop on a daemon thread so Flask (which is not async)
    can run alongside it. asyncio code needs its own event loop, and that loop
    lives entirely inside this thread.
    """
    def runner():
        asyncio.run(stream_ais())

    t = threading.Thread(target=runner, daemon=True, name="ais-stream")
    t.start()
    return t


# Run this file directly to test the connection: python ais_client.py
if __name__ == "__main__":
    init_db()
    print("[test] connecting — Ctrl-C to stop")
    try:
        asyncio.run(stream_ais(verbose=True))
    except KeyboardInterrupt:
        print(f"\n[test] done. {STATUS['messages_received']} messages, "
              f"{len(VESSELS)} unique vessels seen.")
