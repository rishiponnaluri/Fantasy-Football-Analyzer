"""Small bounded in-process cache for public projection data adapters."""

from __future__ import annotations

from datetime import datetime, timezone
import gzip
import io
import json
import threading
import time

import httpx


NFLVERSE_BASE = "https://github.com/nflverse/nflverse-data/releases/download"
OPEN_METEO_BASE = "https://api.open-meteo.com/v1"
GEOCODING_BASE = "https://geocoding-api.open-meteo.com/v1"
_HTTP = httpx.Client(timeout=35, follow_redirects=True,
                     headers={"User-Agent": "FourthAndGoal/1.0 (local fantasy projections)"})
_LOCK = threading.RLock()
_CACHE: dict[str, tuple[float, object, dict]] = {}
_FAILURES: dict[str, float] = {}
_KEY_LOCKS: dict[str, threading.Lock] = {}


def cached(key: str, ttl: int, loader):
    """Return (value, metadata); retain the last good response on refresh errors."""
    now = time.monotonic()
    with _LOCK:
        existing = _CACHE.get(key)
        if existing and now - existing[0] < ttl:
            return existing[1], {**existing[2], "stale": False}
        if _FAILURES.get(key, 0) > now and existing:
            return existing[1], {**existing[2], "stale": True}
        key_lock = _KEY_LOCKS.setdefault(key, threading.Lock())
    # A cache miss can otherwise make every concurrent API request download
    # and parse the same nflverse/Open-Meteo resource at once.
    with key_lock:
        with _LOCK:
            existing = _CACHE.get(key)
            now = time.monotonic()
            if existing and now - existing[0] < ttl:
                return existing[1], {**existing[2], "stale": False}
            if _FAILURES.get(key, 0) > now and existing:
                return existing[1], {**existing[2], "stale": True}
        try:
            value, metadata = loader()
            with _LOCK:
                _CACHE[key] = (time.monotonic(), value, metadata)
                _FAILURES.pop(key, None)
            return value, {**metadata, "stale": False}
        except Exception as error:
            with _LOCK:
                _FAILURES[key] = time.monotonic() + 600
                existing = _CACHE.get(key)
            if existing:
                return existing[1], {**existing[2], "stale": True, "refresh_error": str(error)}
            return None, {"source": key, "available": False, "stale": False,
                          "error": str(error)}


def nflverse_csv(asset: str, filename: str, ttl: int = 1800):
    data_key = f"nflverse:{asset}:{filename}"

    def load_rows():
        url = f"{NFLVERSE_BASE}/{asset}/{filename}"
        response = _HTTP.get(url)
        response.raise_for_status()
        raw = response.content
        if filename.endswith(".gz"):
            raw = gzip.decompress(raw)
        import csv
        text = io.TextIOWrapper(io.BytesIO(raw), encoding="utf-8", newline="")
        rows = list(csv.DictReader(text))
        updated = None
        try:
            stamp_response = _HTTP.get(f"{NFLVERSE_BASE}/{asset}/timestamp.json")
            stamp_response.raise_for_status()
            updated = stamp_response.json().get("last_updated")
        except Exception:
            pass
        return rows, {"source": "nflverse", "url": url,
                      "retrieved_at": datetime.now(timezone.utc).isoformat(),
                      "source_updated_at": updated, "available": True}

    return cached(data_key, ttl, load_rows)


def open_meteo_json(url: str, params: dict, key: str, ttl: int):
    def load():
        response = _HTTP.get(url, params=params)
        response.raise_for_status()
        return response.json(), {"source": "Open-Meteo", "url": str(response.url),
                                 "retrieved_at": datetime.now(timezone.utc).isoformat(),
                                 "available": True}
    return cached(key, ttl, load)
