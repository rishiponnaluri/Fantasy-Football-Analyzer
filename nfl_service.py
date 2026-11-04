"""Real NFL schedule and game data from ESPN's public NFL scoreboard API.

NFL games are actual NFL club contests and are intentionally not serialized as
fantasy league matchups. This module has no dependency on the private league.
"""

from datetime import datetime, timezone
from functools import lru_cache
from copy import deepcopy
import json
import time

import httpx

from espn_service import APIError, redact


BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl"
NFL_FIRST_WEEK = 1
NFL_REGULAR_SEASON_LAST_WEEK = 18
_HTTP = httpx.Client(timeout=20, headers={"User-Agent": "FourthAndGoal/1.0"})


def _get_json(path, params):
    # Share identical public NFL reads across schedule, status and prediction
    # consumers, retaining last-good data through the existing failure cache.
    from projection_sources.cache import cached
    key = f"nfl-live-json:{path}:{json.dumps(params, sort_keys=True)}"
    value, _ = cached(key, 30, lambda: (_get_json_uncached(path, params), {}))
    if value is None:
        raise APIError(502, "nfl_data_error", "NFL data is temporarily unavailable.")
    return deepcopy(value)


def _get_json_uncached(path, params):
    for attempt in range(2):
        try:
            response = _HTTP.get(f"{BASE_URL}/{path}", params=params)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("ESPN returned a non-object response.")
            return payload
        except httpx.TransportError as error:
            if attempt == 0:
                time.sleep(0.2)
                continue
            raise APIError(502, "nfl_data_error", f"Could not retrieve NFL data from ESPN: {redact(str(error))}", type(error).__name__) from None
        except (httpx.HTTPError, ValueError) as error:
            raise APIError(502, "nfl_data_error", f"Could not retrieve NFL data from ESPN: {redact(str(error))}", type(error).__name__) from None


@lru_cache(maxsize=32)
def team_identity(team_id: int):
    """Cached official ESPN NFL team identity and brand assets."""
    payload = _get_json(f"teams/{int(team_id)}", {})
    team = payload.get("team") or payload
    logos = team.get("logos") or []
    default_logo = next((logo.get("href") for logo in logos if "default" in (logo.get("rel") or []) and logo.get("href")), None)
    def color(value):
        value = str(value or "").lstrip("#")
        return value if len(value) == 6 and all(char in "0123456789abcdefABCDEF" for char in value) else None
    return {"team_id": int(team_id), "name": team.get("displayName") or team.get("name"),
            "abbreviation": team.get("abbreviation"), "color": color(team.get("color")),
            "alternate_color": color(team.get("alternateColor")), "logo_url": default_logo,
            "source": "ESPN NFL team metadata"}
def _status(competition):
    status = competition.get("status", {})
    kind = status.get("type", {})
    return {
        "state": kind.get("state"),
        "description": kind.get("description") or kind.get("detail") or "Unavailable",
        "detail": kind.get("detail"),
        "period": status.get("period") if kind.get("state") == "in" else None,
        "clock": status.get("displayClock") if kind.get("state") == "in" else None,
    }


def _score(value, state):
    if state not in ("in", "post") or value is None:
        return None
    try:
        parsed = float(value)
        return int(parsed) if parsed.is_integer() else parsed
    except (TypeError, ValueError):
        return None


def _team_assets(team):
    logos = team.get("logos") or []
    logo = team.get("logo") or next((item.get("href") for item in logos
                                      if item.get("href") and "default" in (item.get("rel") or [])), None)
    return {"logo_url": logo,
            "primary_color": str(team.get("color") or "").lstrip("#") or None,
            "secondary_color": str(team.get("alternateColor") or "").lstrip("#") or None,
            "identity_source": "ESPN NFL team metadata" if logo or team.get("color") else None}


def _game(event):
    competitions = event.get("competitions", [])
    if not competitions:
        return None
    competition = competitions[0]
    status = _status(competition)
    sides = {}
    for competitor in competition.get("competitors", []):
        side = competitor.get("homeAway")
        if side not in ("home", "away"):
            continue
        team = competitor.get("team", {})
        sides[side] = {
            "team_id": int(team["id"]) if str(team.get("id", "")).isdigit() else None,
            "name": team.get("displayName") or team.get("name") or "Unavailable",
            "abbreviation": team.get("abbreviation"),
            "score": _score(competitor.get("score"), status["state"]),
            **_team_assets(team),
        }
    if "home" not in sides or "away" not in sides:
        return None
    return {
        "event_id": str(event.get("id", "")),
        "week": event.get("week", {}).get("number"),
        "kickoff": event.get("date"),
        "status": status,
        "venue": {
            "name": competition.get("venue", {}).get("fullName"),
            "address": competition.get("venue", {}).get("address", {}),
            "indoor": competition.get("venue", {}).get("indoor"),
        },
        "away_team": sides["away"],
        "home_team": sides["home"],
    }


def _regular_season_scoreboard(week=None, season_year=None):
    params = {"seasontype": 2}
    if week is not None:
        params["week"] = week
    if season_year is not None:
        params["dates"] = season_year
    return _get_json("scoreboard", params)


def _live_data(board):
    current_week = board.get("week", {}).get("number")
    season = board.get("season", {}).get("year")
    if not isinstance(current_week, int) or not isinstance(season, int):
        raise APIError(502, "nfl_schedule_unavailable", "ESPN did not provide the current NFL season and week.")
    active_ids = set()
    for event in board.get("events", []):
        game = _game(event)
        if game and game["status"]["state"] == "in":
            active_ids.update(team["team_id"] for team in (game["home_team"], game["away_team"]) if team["team_id"] is not None)
    return {"updated_at": datetime.now(timezone.utc).isoformat(), "season": season,
            "current_week": current_week, "in_progress_team_ids": sorted(active_ids)}


def live_status():
    return _live_data(_regular_season_scoreboard())


def nfl_schedule(selected_week=None):
    current_board = _regular_season_scoreboard()
    current = _live_data(current_board)
    week = current["current_week"] if selected_week is None else selected_week
    if not NFL_FIRST_WEEK <= week <= NFL_REGULAR_SEASON_LAST_WEEK:
        raise APIError(422, "invalid_nfl_week", f"NFL regular-season week must be between {NFL_FIRST_WEEK} and {NFL_REGULAR_SEASON_LAST_WEEK}.")
    board = (_regular_season_scoreboard(week, current["season"])
             if week != current["current_week"] else current_board)
    returned_week = board.get("week", {}).get("number")
    if returned_week != week:
        raise APIError(502, "nfl_week_mismatch", f"ESPN returned NFL week {returned_week}, not requested week {week}.")
    games = [game for event in board.get("events", []) if (game := _game(event)) is not None]
    games.sort(key=lambda game: game.get("kickoff") or "")
    from market_odds_service import market_probability
    for game in games:
        try:
            game["market_probability"] = market_probability(game)
        except Exception:
            # Market odds are supplemental; a market-provider failure never
            # replaces or disrupts ESPN's real NFL schedule and scores.
            game["market_probability"] = None
    byes = [{"team_id": item.get("id"), "name": item.get("displayName"),
             "abbreviation": item.get("abbreviation")}
            for item in board.get("week", {}).get("teamsOnBye", [])]
    return {"sport": "NFL", "season": current["season"], "season_type": "regular season",
            "current_week": current["current_week"], "week": week,
            "first_week": NFL_FIRST_WEEK, "last_week": NFL_REGULAR_SEASON_LAST_WEEK,
            "updated_at": datetime.now(timezone.utc).isoformat(), "games": games, "teams_on_bye": byes}


def nfl_game_details(event_id):
    summary = _get_json("summary", {"event": event_id})
    header = summary.get("header", {})
    competition = next((item for item in header.get("competitions", [])
                        if str(item.get("id")) == str(event_id)), None)
    if competition is None:
        raise APIError(404, "nfl_game_not_found", f"ESPN returned no NFL game with ID {event_id}.")
    raw_week = header.get("week")
    week_number = (raw_week.get("number") if isinstance(raw_week, dict)
                   else raw_week if isinstance(raw_week, int) else None)
    base_game = {
        "event_id": str(event_id),
        "season": header.get("season", {}).get("year"),
        "week": week_number,
        "kickoff": competition.get("date"),
        "status": _status(competition),
    }
    sides = {}
    for competitor in competition.get("competitors", []):
        side = competitor.get("homeAway")
        if side not in ("home", "away"):
            continue
        team = competitor.get("team", {})
        sides[side] = {"team_id": int(team["id"]) if str(team.get("id", "")).isdigit() else None,
                       "name": team.get("displayName") or team.get("name"),
                       "abbreviation": team.get("abbreviation"),
                       "score": _score(competitor.get("score"), base_game["status"]["state"]),
                       **_team_assets(team)}
    raw_team_stats = summary.get("boxscore", {}).get("teams", [])
    stats_by_id = {str(item.get("team", {}).get("id")): item.get("statistics", []) for item in raw_team_stats}
    for side, team in sides.items():
        stats = stats_by_id.get(str(team["team_id"]), [])
        team["statistics"] = [{"name": stat.get("name"), "label": stat.get("label"),
                               "display_value": stat.get("displayValue")}
                              for stat in stats if stat.get("name")]
    leaders = []
    for team_group in summary.get("leaders", []):
        team = team_group.get("team", {})
        categories = []
        for category in team_group.get("leaders", []):
            values = []
            for leader in category.get("leaders", []):
                athlete = leader.get("athlete", {})
                values.append({"player_id": int(athlete["id"]) if str(athlete.get("id", "")).isdigit() else None,
                               "name": athlete.get("displayName") or "Unavailable",
                               "display_value": leader.get("displayValue"), "value": leader.get("value")})
            if category.get("displayName"):
                categories.append({"name": category.get("displayName"), "leaders": values})
        leaders.append({"team_name": team.get("displayName"), "abbreviation": team.get("abbreviation"),
                        "categories": categories})
    return {**base_game, "away_team": sides.get("away"), "home_team": sides.get("home"),
            "leaders": leaders, "updated_at": datetime.now(timezone.utc).isoformat()}
