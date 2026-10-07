"""Join independent real-world sources to ESPN's league player-card data."""

from __future__ import annotations

from datetime import datetime, timezone
from datetime import timedelta

from projection_sources.defensive_matchups import adjustment as matchup_adjustment, points_allowed_context
from projection_sources.game_environment import team_context
from projection_sources.injuries import events_for_player, opponent_defender_events
from projection_sources.nfl_stats import nflverse_team, season_data
from projection_sources.news import structured_events
from projection_sources.role_trends import adjustment as role_adjustment, role_context, usage_adjustment
from projection_sources.weather import forecast as weather_forecast


def enrich_players(players: list[dict], year: int, week: int, service) -> tuple[dict[int, dict], dict]:
    data = season_data(year)
    sources = data["sources"]
    output = {}
    scoring_format = service.recommendation_settings().get("scoring_format", [])
    scoring_source = "active ESPN league scoring settings"
    nfl_venues = {}
    try:
        import nfl_service
        nfl_week = nfl_service.nfl_schedule(week)
        nfl_venues = {side["abbreviation"]: {"venue": game.get("venue"), "kickoff": game.get("kickoff")}
                      for game in nfl_week.get("games", [])
                      for side in (game.get("home_team"), game.get("away_team")) if side}
    except Exception:
        # Venue context is optional. ESPN fantasy requests remain available if
        # the separate real-NFL scoreboard or weather source is unavailable.
        nfl_venues = {}
    for original in players:
        player = dict(original)
        pmap = data["player_map"].get(str(player.get("player_id")), {})
        gsis, pfr = pmap.get("gsis_id"), pmap.get("pfr_id")
        player["_pfr_player_id"] = pfr
        team = player.get("nfl_team")
        opponent = player.get("nfl_opponent")
        nfl_team, nfl_opponent = nflverse_team(team), nflverse_team(opponent)
        factors, evidence, events = [], {}, []
        injury_meta = sources.get("injuries", {})
        events = structured_events(events_for_player(player, gsis, week, data["injuries"],
                                                      data["weekly_rosters"],
                                                      injury_meta.get("source_updated_at"))
                                   + opponent_defender_events(player, week, data["injuries"],
                                                              data["gsis_map"], injury_meta.get("source_updated_at")))
        # A sourced official OUT report overrides an absent/stale ESPN label.
        official_out = any(event["event_type"] == "official_injury_report"
                           and (event.get("detail", {}).get("report_status") or "").casefold() == "out"
                           for event in events)
        if official_out:
            player["injury_status"] = "OUT"
        team_env = team_context(nfl_team, nfl_opponent, week, data["team_stats"], data["schedule"])
        team_env["espn_team_abbreviation"] = team
        team_env["espn_opponent_abbreviation"] = opponent
        evidence["team_and_game_environment"] = team_env
        evidence["injury_events"] = events
        evidence["individual_defender"] = {"available": False,
                                             "reason": "No dependable, open player-level coverage assignment feed was available; defender matchups are not inferred."}
        venue_game = nfl_venues.get(team or "")
        venue = (venue_game or {}).get("venue") or {}
        address = venue.get("address") or {}
        roof = (team_env.get("game") or {}).get("roof")
        indoor_known = venue.get("indoor") is not None or roof in {"dome", "closed", "outdoors", "open"}
        indoor = bool(venue.get("indoor")) if venue.get("indoor") is not None else roof in {"dome", "closed"}
        weather_context = weather_forecast(address.get("city"), address.get("state"),
                                           (venue_game or {}).get("kickoff") or player.get("nfl_game_time"),
                                           indoor if indoor_known else None) if venue_game else {
                                               "available": False,
                                               "reason": "The independent ESPN NFL scoreboard did not return a matching venue."}
        evidence["weather"] = weather_context

        if opponent and player.get("position") in {"QB", "RB", "WR", "TE"}:
            context = points_allowed_context(data["player_stats"], nfl_opponent, player["position"], week,
                                             scoring_format, data["team_stats"])
            if context:
                evidence["defensive_matchup"] = context
                projection = player.get("projected_fantasy_points")
                if isinstance(projection, (int, float)):
                    factors.append(matchup_adjustment(float(projection), context, scoring_source))
            else:
                evidence["defensive_matchup"] = {"available": False, "reason": "No prior completed opponent games with supported league-scoring categories."}
        else:
            evidence["defensive_matchup"] = {"available": False, "reason": "Opponent or offensive position is unavailable."}

        role = role_context(player, gsis, data["player_stats"], data["snap_counts"], week, scoring_format)
        if role:
            evidence["role_trend"] = role
            role_factor = role_adjustment(role)
            if role_factor:
                factors.append(role_factor)
            # ESPN's weekly opportunity model remains authoritative when it has
            # usable data; nflverse supplies this factor only as a real-data
            # fallback so the same targets/carries are not counted twice.
            if not player.get("game_log") or not any((row.get("stats") or {}).get(key) is not None
                    for row in player.get("game_log") or []
                    for key in ("passingAttempts", "rushingAttempts", "receivingTargets")):
                usage_factor = usage_adjustment(role)
                if usage_factor:
                    factors.append(usage_factor)
        else:
            evidence["role_trend"] = {"available": False,
                                      "reason": "Fewer than three prior weeks with matching snap-share and player-stat records; role changes stay unscored."}
        player["_external_projection_factors"] = factors
        player["_external_context_events"] = events
        player["_projection_context"] = evidence
        player["_projection_source_status"] = None
        output[player["player_id"]] = player

    now = datetime.now(timezone.utc)
    status = {}
    for key, value in sources.items():
        source_updated_at = value.get("source_updated_at")
        freshness_basis = ("source_updated_at" if source_updated_at else "retrieved_at")
        status[key] = {"source": value.get("source"), "url": value.get("url"),
                       "retrieved_at": value.get("retrieved_at"),
                       "source_updated_at": source_updated_at,
                       "source_update_time_available": bool(source_updated_at),
                       "source_update_note": (None if source_updated_at else
                           "Source update time unavailable; freshness is based on when the app retrieved this feed."),
                       "freshness_basis": freshness_basis,
                       "available": bool(value.get("available")),
                       "stale": bool(value.get("stale")) or _is_source_stale(
                           source_updated_at, value.get("retrieved_at"), now),
                       "error": value.get("error")}
    source_status = {"as_of": datetime.now(timezone.utc).isoformat(), "sources": status,
                     "weather": "Open-Meteo forecast is queried only for a resolved outdoor NFL venue; unavailable forecasts do not alter projections.",
                     "news": "structured official weekly injury and roster feeds only; article text/rumors are not interpreted",
                     "individual_matchups": "unavailable: no dependable open expected-coverage assignment feed"}
    for player in output.values():
        player["_projection_source_status"] = source_status
    return output, source_status


def _is_source_stale(source_updated_at, retrieved_at, now):
    """Use provider time when supplied; otherwise use the app's fetch time.

    These timestamps describe different events. In particular, a missing
    provider timestamp is unknown source freshness, not proof that the data is
    stale. The adapter cache's ``stale`` flag still marks failed refreshes.
    """
    updated = _parse_source_time(source_updated_at)
    if updated is None:
        updated = _parse_source_time(retrieved_at)
    if updated is None:
        return True
    return (now - updated).total_seconds() > 36 * 3600


def _parse_source_time(timestamp):
    if not timestamp:
        return None
    if not isinstance(timestamp, str):
        return None
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except ValueError:
        pass
    try:
        date_part, time_part, zone = timestamp.split()
        offsets = {"EDT": -4, "EST": -5, "CDT": -5, "CST": -6,
                   "MDT": -6, "MST": -7, "PDT": -7, "PST": -8, "UTC": 0}
        local = datetime.strptime(f"{date_part} {time_part}", "%Y-%m-%d %H:%M:%S")
        return local.replace(tzinfo=timezone(timedelta(hours=offsets.get(zone, 0)))).astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None
