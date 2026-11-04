"""ESPN Fantasy adapter for league player projections and scoring history."""

from __future__ import annotations

from datetime import datetime, timezone

from espn_service import APIError
from projection_engine import project_players
from projection_sources.context import enrich_players


class ESPNProjectionSource:
    """Fetches league-rostered players plus ESPN player-card history."""

    def __init__(self, service):
        self.service = service

    def league_players(self, week: int) -> list[dict]:
        matchups = self.service.fantasy_matchups(week)
        rostered: dict[int, dict] = {}
        for matchup in matchups["fantasy_matchups"]:
            for side in ("home_team", "away_team"):
                team = matchup.get(side)
                for player in (team or {}).get("roster") or []:
                    rostered[player["player_id"]] = {**player, "fantasy_team_id": team["team_id"],
                                                       "fantasy_team_name": team["team_name"]}

        ids = list(rostered)
        insights = {}
        # ESPN's player-card API accepts IDs in batches; keep requests bounded
        # while using a separate provider adapter so sources can be swapped.
        for offset in range(0, len(ids), 50):
            insights.update(self.service.player_insights(ids[offset:offset + 50], week))

        players = []
        for player_id, roster_player in rostered.items():
            card = insights.get(player_id, {})
            combined = {**card, **roster_player}
            # Roster week is authoritative for selected-week projection and
            # points. The card is authoritative for game history and stats.
            for field in ("projected_fantasy_points", "fantasy_points", "lineup_slot", "lineup_status", "is_starter"):
                if roster_player.get(field) is None:
                    combined[field] = card.get(field)
            for field in ("game_log", "season_fantasy_average", "season_fantasy_points", "injury_status",
                          "nfl_opponent", "nfl_game_time", "nfl_team_id", "nfl_team", "position"):
                if combined.get(field) is None:
                    combined[field] = card.get(field)
            players.append(combined)
        return players


def league_projection_payload(service, week: int) -> dict:
    from projection_snapshot import snapshot
    payload = snapshot(service, week)
    return {k: v for k, v in payload.items() if not k.startswith('_')}


def _build_league_projection_payload(service, week: int) -> dict:
    players = ESPNProjectionSource(service).league_players(week)
    if not players:
        raise APIError(502, "espn_projection_roster_unavailable", "ESPN did not provide league rosters for the selected week.")
    enriched, source_status = enrich_players(players, service.league.year, week, service)
    players = [enriched[player["player_id"]] for player in players]
    projections = project_players(players, week, service.league.current_week)
    teams = {}
    for player in players:
        team_id = player.get("fantasy_team_id")
        if team_id is None:
            continue
        team = teams.setdefault(team_id, {"team_id": team_id, "team_name": player.get("fantasy_team_name"),
                                         "our_projected_score": 0.0, "projected_starters": 0,
                                         "unavailable_starters": 0})
        if not player.get("is_starter"):
            continue
        expected = projections[player["player_id"]].get("our_projection")
        if expected is None:
            team["unavailable_starters"] += 1
        else:
            team["our_projected_score"] += expected
            team["projected_starters"] += 1
    for team in teams.values():
        team["our_projected_score"] = round(team["our_projected_score"], 3) if not team["unavailable_starters"] else None
    records = [{"player_id": player["player_id"], "fantasy_team_id": player.get("fantasy_team_id"),
                "is_starter": bool(player.get("is_starter")),
                "player": {key: value for key, value in player.items() if not key.startswith("_")},
                "projection": projections[player["player_id"]]} for player in players]
    return {"week": week, "league_id": service.league.league_id, "year": service.league.year,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "source": "ESPN league rosters/player cards plus timestamped nflverse and Open-Meteo context adapters",
            "source_status": source_status,
            "model": "ESPN prior updated by empirical-Bayes shrinkage from real ESPN history, with separately sourced opponent points allowed and snap-share role trend where supported. Injury OUT status uses structured ESPN/nflverse evidence. Market, weather, team context, and injury events are exposed as evidence; no unsupported numerical effects are applied.",
            "player_count": len(records), "players": records, "teams": list(teams.values())}
