"""Public, exact-event NFL market odds adapter (Kalshi)."""

from __future__ import annotations

from datetime import datetime, timezone
import re
import threading
import time
from zoneinfo import ZoneInfo

import httpx


BASE_URL = "https://api.elections.kalshi.com/trade-api/v2"
_HTTP = httpx.Client(timeout=8.0, headers={"User-Agent": "FantasyFootballAnalyzer/1.0"})
_LOCK = threading.Lock()
_MARKET_CACHE: tuple[float, list[dict]] | None = None
_ABBREVIATION_ALIASES = {"WSH": "WAS", "LA": "LAR", "JAC": "JAX"}


def _number(value):
    try:
        parsed = float(value)
        return parsed if 0 <= parsed <= 1 else None
    except (TypeError, ValueError):
        return None


def normalize_binary_prices(first: float, second: float):
    """Scale paired YES midpoints to 100%; raw market prices remain in output."""
    total = first + second
    if total <= 0:
        return None
    return round(first / total, 6), round(second / total, 6)


def _fetch_markets():
    global _MARKET_CACHE
    now = time.monotonic()
    with _LOCK:
        if _MARKET_CACHE and now < _MARKET_CACHE[0]:
            return _MARKET_CACHE[1]
        try:
            response = _HTTP.get(f"{BASE_URL}/markets", params={
                "series_ticker": "KXNFLGAME", "status": "open", "limit": 200,
            })
            response.raise_for_status()
            markets = response.json().get("markets", [])
            if not isinstance(markets, list):
                markets = []
            _MARKET_CACHE = (now + 30, markets)
            return markets
        except (httpx.HTTPError, ValueError):
            # The real schedule stays available even when markets are down.
            _MARKET_CACHE = (now + 15, [])
            return []


def _identity(game):
    away = game.get("away_team") or {}
    home = game.get("home_team") or {}
    try:
        kickoff = datetime.fromisoformat((game.get("kickoff") or "").replace("Z", "+00:00"))
        game_date = kickoff.astimezone(ZoneInfo("America/New_York")).strftime("%y%b%d").upper()
    except (ValueError, TypeError):
        return None
    abbreviations = tuple(sorted(_ABBREVIATION_ALIASES.get(str(team.get("abbreviation") or "").upper(),
                                      str(team.get("abbreviation") or "").upper())
                                 for team in (away, home)))
    if not all(abbreviations):
        return None
    return game_date, abbreviations


def _verified_resolution(market, game_date):
    rules = str(market.get("rules_primary") or "")
    if "Pro Football game" not in rules or "originally scheduled for" not in rules:
        return False
    match = re.search(r"originally scheduled for ([A-Za-z]{3}) (\d{1,2}), (\d{4})", rules)
    if not match:
        return False
    try:
        actual_date = datetime.strptime(" ".join(match.groups()), "%b %d %Y").strftime("%y%b%d").upper()
    except ValueError:
        return False
    return actual_date == game_date and " wins the " in rules


def market_probability(game):
    """Return matched market-implied win chances; never infer absent quotes."""
    identity = _identity(game)
    if identity is None:
        return None
    game_date, teams = identity
    groups: dict[str, list[dict]] = {}
    for market in _fetch_markets():
        event_ticker = str(market.get("event_ticker") or "")
        match = re.fullmatch(r"KXNFLGAME-(\d{2}[A-Z]{3}\d{2})([A-Z]{6})", event_ticker)
        if not match or match.group(1) != game_date:
            continue
        codes = tuple(sorted((match.group(2)[:3], match.group(2)[3:])))
        if codes != teams or not _verified_resolution(market, game_date):
            continue
        ticker = str(market.get("ticker") or "")
        outcome = ticker.rsplit("-", 1)[-1]
        outcome = _ABBREVIATION_ALIASES.get(outcome, outcome)
        if outcome not in teams:
            continue
        bid, ask = _number(market.get("yes_bid_dollars")), _number(market.get("yes_ask_dollars"))
        if bid is None or ask is None or bid > ask:
            continue
        groups.setdefault(event_ticker, []).append({"outcome": outcome, "midpoint": (bid + ask) / 2,
            "ticker": ticker, "bid": bid, "ask": ask, "updated_time": market.get("updated_time"),
            "status": market.get("status"), "rules_primary": market.get("rules_primary")})

    for event_ticker, rows in groups.items():
        by_outcome = {row["outcome"]: row for row in rows}
        if set(by_outcome) != set(teams):
            continue
        normalized = normalize_binary_prices(by_outcome[teams[0]]["midpoint"], by_outcome[teams[1]]["midpoint"])
        if normalized is None:
            continue
        values = {teams[0]: normalized[0], teams[1]: normalized[1]}
        return {
            "source": "Kalshi public markets",
            "source_url": "https://kalshi.com/markets/kxnflgame",
            "event_identifier": event_ticker,
            "market_identifiers": [by_outcome[code]["ticker"] for code in teams],
            "away_probability": values[_ABBREVIATION_ALIASES.get(str(game["away_team"]["abbreviation"]).upper(), str(game["away_team"]["abbreviation"]).upper())],
            "home_probability": values[_ABBREVIATION_ALIASES.get(str(game["home_team"]["abbreviation"]).upper(), str(game["home_team"]["abbreviation"]).upper())],
            "raw_yes_midpoints": {code: round(by_outcome[code]["midpoint"], 6) for code in teams},
            "raw_yes_bid_ask": {code: {"bid": by_outcome[code]["bid"], "ask": by_outcome[code]["ask"]} for code in teams},
            "normalization_method": "For each team's binary YES contract, take midpoint of best YES bid and ask; divide the two team midpoints by their sum so the displayed pair totals 100%. Raw quotes are retained. These are market prices, not true odds.",
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
            "market_updated_at": max((row.get("updated_time") or "" for row in rows), default=None),
            "market_state": "LIVE MARKET" if (game.get("status") or {}).get("state") == "in" else "PREGAME MARKET",
        }
    return None
