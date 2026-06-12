"""
vessel_info.py — looks up rich vessel records (photo, specs, history) for the
"Vessel Spotlight" feature.

Two data sources, tried in order:

  1. Datalastic (https://datalastic.com) — a commercial vessel database.
     Only used if DATALASTIC_API_KEY is set in .env; their free trial /
     paid tiers require signup. Optional.

  2. Wikidata + Wikipedia — completely free, no key needed. Wikidata stores
     ships' MMSI and IMO numbers alongside specs (length, beam, tonnage,
     build year, flag) and a Wikimedia Commons photo; Wikipedia provides a
     short prose summary we show as history. Coverage is "notable vessels
     only": cruise ships, navy ships, famous ferries — a lobster boat won't
     be there, and that's fine. The frontend shows a clean "no additional
     info" state for those.

Results are cached in memory per MMSI for an hour, so clicking the same
vessel repeatedly costs nothing.
"""

import os
import threading
import time

import requests
from dotenv import load_dotenv

load_dotenv()
DATALASTIC_KEY = os.getenv("DATALASTIC_API_KEY")  # optional — see .env.example

WIKIDATA_SPARQL = "https://query.wikidata.org/sparql"
# Wikidata asks bots to identify themselves; requests without a real
# User-Agent get throttled or blocked.
HEADERS = {"User-Agent": "CascoBayTracker/1.0 (educational project; github.com/brendanoakley/casco-bay-tracker)"}

CACHE_TTL = 3600  # seconds — 1 hour
_cache = {}       # mmsi -> (timestamp, result dict)
_cache_lock = threading.Lock()


def _empty(mmsi):
    """The shape every lookup returns, found or not. Keeping one shape means
    the frontend never has to guess which keys exist."""
    return {
        "found": False,
        "mmsi": mmsi,
        "source": None,
        "photo_url": None,
        "photo_credit": None,
        "length_m": None,
        "beam_m": None,
        "gross_tonnage": None,
        "year_built": None,
        "flag_name": None,
        "flag_code": None,    # ISO 2-letter code, becomes a flag emoji
        "imo": None,
        "history": [],        # list of {"year": int|None, "event": str}
    }


# ---------------------------------------------------------------------------
# Source 1: Datalastic (optional, needs API key)
# ---------------------------------------------------------------------------

def _lookup_datalastic(mmsi):
    """Query Datalastic's vessel_info endpoint. Returns a result dict or None."""
    try:
        r = requests.get(
            "https://api.datalastic.com/api/v0/vessel_info",
            params={"api-key": DATALASTIC_KEY, "mmsi": mmsi},
            timeout=10,
        )
        r.raise_for_status()
        d = r.json().get("data") or {}
        if not d:
            return None
        out = _empty(mmsi)
        out.update({
            "found": True,
            "source": "datalastic",
            "length_m": d.get("length"),
            "beam_m": d.get("breadth"),
            "gross_tonnage": d.get("gross_tonnage"),
            "year_built": d.get("year_built"),
            "flag_name": d.get("country_name"),
            "flag_code": d.get("country_iso"),
            "imo": d.get("imo"),
        })
        return out
    except (requests.RequestException, ValueError) as e:
        print(f"[info] datalastic lookup failed for {mmsi}: {e}")
        return None


# ---------------------------------------------------------------------------
# Source 2: Wikidata + Wikipedia (free, keyless)
# ---------------------------------------------------------------------------

# One SPARQL query pulls everything we want about a ship. The OPTIONAL
# blocks mean "include this field if it exists, but don't fail if not" —
# like LEFT JOIN in SQL.
_SPARQL_TEMPLATE = """
SELECT ?ship ?shipLabel ?image ?length ?beam ?tonnage ?inception
       ?serviceEntry ?retired ?countryLabel ?countryCode ?article WHERE {
  %s
  OPTIONAL { ?ship wdt:P18 ?image }
  OPTIONAL { ?ship wdt:P2043 ?length }
  OPTIONAL { ?ship wdt:P2261 ?beam }
  OPTIONAL { ?ship wdt:P1093 ?tonnage }
  OPTIONAL { ?ship wdt:P571 ?inception }
  OPTIONAL { ?ship wdt:P729 ?serviceEntry }
  OPTIONAL { ?ship wdt:P730 ?retired }
  OPTIONAL { ?ship (wdt:P8047|wdt:P17) ?country .
             OPTIONAL { ?country wdt:P297 ?countryCode } }
  OPTIONAL { ?article schema:about ?ship ;
             schema:isPartOf <https://en.wikipedia.org/> }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT 1
"""


def _sparql(where_clause):
    """Run one SPARQL query against Wikidata; return the first row or None."""
    r = requests.get(
        WIKIDATA_SPARQL,
        params={"format": "json", "query": _SPARQL_TEMPLATE % where_clause},
        headers=HEADERS,
        timeout=15,
    )
    r.raise_for_status()
    rows = r.json()["results"]["bindings"]
    return rows[0] if rows else None


def _val(row, key, cast=str):
    """Pull one field out of a SPARQL result row, or None if absent."""
    if key not in row:
        return None
    try:
        return cast(row[key]["value"])
    except (ValueError, TypeError):
        return None


def _year(row, key):
    """Wikidata dates look like '2003-12-08T00:00:00Z' — we just want 2003."""
    v = _val(row, key)
    return int(v[:4]) if v and v[:4].isdigit() else None


def _wikipedia_summary(article_url):
    """Fetch the first-paragraph summary of a Wikipedia article (REST API)."""
    try:
        title = article_url.rsplit("/", 1)[-1]
        r = requests.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{title}",
            headers=HEADERS, timeout=10,
        )
        r.raise_for_status()
        return r.json().get("extract")
    except requests.RequestException:
        return None


def _lookup_wikidata(mmsi, imo=None):
    """Find the ship in Wikidata by MMSI, falling back to IMO number."""
    try:
        # MMSI is property P587; IMO ship number is P458. Many ship entries
        # have only one of the two, so we try both.
        row = _sparql(f'?ship wdt:P587 "{int(mmsi)}".')
        if row is None and imo:
            row = _sparql(f'?ship wdt:P458 "{int(imo)}".')
        if row is None:
            return None

        out = _empty(mmsi)
        photo = _val(row, "image")
        out.update({
            "found": True,
            "source": "wikidata",
            # Wikidata hands back http:// URLs; Commons serves https fine.
            "photo_url": photo.replace("http://", "https://") if photo else None,
            "photo_credit": "Wikimedia Commons",
            "length_m": _val(row, "length", float),
            "beam_m": _val(row, "beam", float),
            "gross_tonnage": _val(row, "tonnage", float),
            "year_built": _year(row, "inception"),
            "flag_name": _val(row, "countryLabel"),
            "flag_code": _val(row, "countryCode"),
            "imo": imo,
        })

        # Build a small history timeline out of the dated facts we got.
        if out["year_built"]:
            out["history"].append({"year": out["year_built"], "event": "Built"})
        if (y := _year(row, "serviceEntry")):
            out["history"].append({"year": y, "event": "Entered service"})
        if (y := _year(row, "retired")):
            out["history"].append({"year": y, "event": "Retired from service"})

        # Wikipedia's opening paragraph makes a nice prose history entry.
        article = _val(row, "article")
        if article and (summary := _wikipedia_summary(article)):
            if len(summary) > 400:
                summary = summary[:397] + "…"
            out["history"].append({"year": None, "event": summary})

        return out
    except (requests.RequestException, ValueError, KeyError) as e:
        print(f"[info] wikidata lookup failed for {mmsi}: {e}")
        return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def lookup(mmsi, imo=None, ais_extras=None):
    """
    Get the rich info record for one vessel, using the cache when possible.

    ais_extras is the vessel's live AIS record — if the external databases
    come up empty, the ship's own self-reported dimensions still give us
    something to show.
    """
    with _cache_lock:
        hit = _cache.get(mmsi)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]

    result = None
    if DATALASTIC_KEY:
        result = _lookup_datalastic(mmsi)
    if result is None:
        result = _lookup_wikidata(mmsi, imo=imo)
    if result is None:
        result = _empty(mmsi)

    # Fill gaps from the ship's own AIS static data (self-reported, so less
    # authoritative — only used where the databases had nothing).
    if ais_extras:
        if result["length_m"] is None and ais_extras.get("length_m"):
            result["length_m"] = ais_extras["length_m"]
        if result["beam_m"] is None and ais_extras.get("beam_m"):
            result["beam_m"] = ais_extras["beam_m"]
        if result["imo"] is None and ais_extras.get("imo"):
            result["imo"] = ais_extras["imo"]
        # Having dimensions alone counts as "something to show".
        if not result["found"] and result["length_m"]:
            result["found"] = True
            result["source"] = "ais"

    # Cache even the misses — re-querying Wikidata for a lobster boat on
    # every click would be rude and slow.
    with _cache_lock:
        _cache[mmsi] = (time.time(), result)
    return result
