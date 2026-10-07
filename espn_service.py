"""Real ESPN fantasy data, serialized through explicit public field allowlists.

Fantasy matchups are league team contests. NFL team names are player metadata
only; this module does not fetch or return NFL matchups.
"""

from contextlib import contextmanager
from copy import deepcopy
import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone

from espn_api.football.player import Player
from espn_api.football.constant import PLAYER_STATS_MAP, PRO_TEAM_MAP, POSITION_MAP

from espn_connection import connect_league, select_team


class APIError(Exception):
    def __init__(self, status, code, message, error_type=None):
        self.status = status
        self.payload = {"error": {"code": code, "message": message}}
        if error_type:
            self.payload["error"]["type"] = error_type


def redact(message):
    for key in ("ESPN_S2", "ESPN_SWID"):
        secret = os.getenv(key, "").strip()
        if secret:
            for form in (secret, secret.strip("{}")):
                if form:
                    message = re.sub(re.escape(form), "[redacted]", message, flags=re.IGNORECASE)
    return message


@contextmanager
def espn_operation():
    try:
        yield
    except APIError:
        raise
    except Exception as error:
        raise APIError(502, "espn_error", redact(str(error)), type(error).__name__) from None


def owner_json(owner):
    # ESPN owner IDs are SWIDs; never include them or raw owner dictionaries.
    return {key: owner[key] for key in ("displayName", "firstName", "lastName") if key in owner}


def team_json(team):
    def color(*values):
        for value in values:
            candidate = str(value or "").lstrip("#")
            if len(candidate) == 6 and all(char in "0123456789abcdefABCDEF" for char in candidate):
                return candidate
        return None
    return {
        "team_id": team.team_id,
        "team_name": team.team_name,
        "abbreviation": team.team_abbrev,
        "team_logo_url": getattr(team, "logo", None) or getattr(team, "logo_url", None),
        "primary_color": color(getattr(team, "primary_color", None), getattr(team, "color", None)),
        "secondary_color": color(getattr(team, "secondary_color", None), getattr(team, "alternate_color", None)),
        "owners": [owner_json(owner) for owner in team.owners],
        "record": {"wins": team.wins, "losses": team.losses, "ties": team.ties},
    }


def lineup_status(slot):
    if slot == "BE":
        return "bench"
    if slot in ("IR", "ER"):
        return "reserve"
    if slot == "FA":
        return "available"
    return "starter" if slot else "unassigned"


def player_json(player, week, slot=None):
    slot = player.lineupSlot if slot is None else slot
    stats = player.stats.get(week, {})
    team_id = next((team_id for team_id, abbreviation in PRO_TEAM_MAP.items()
                    if abbreviation == player.proTeam), None)
    return {
        "player_id": player.playerId,
        "name": player.name,
        "position": player.position or None,
        "nfl_team": player.proTeam,
        "nfl_team_id": team_id,
        "nfl_team_logo_url": f"https://a.espncdn.com/i/teamlogos/nfl/500/{player.proTeam.lower()}.png" if team_id else None,
        "week": week,
        "lineup_slot": slot or None,
        "lineup_status": lineup_status(slot),
        "is_starter": lineup_status(slot) == "starter",
        "fantasy_points": stats.get("points"),
        "projected_fantasy_points": stats.get("projected_points"),
        "injury_status": player.injuryStatus,
        "percent_owned": player.percent_owned if player.percent_owned >= 0 else None,
    }


def raw_player_json(entry, year, week):
    player = Player(entry, year)
    result = player_json(player, week)
    raw = entry.get("playerPoolEntry", entry)["player"]
    result["nfl_team_id"] = raw.get("proTeamId")
    team_abbreviation = PRO_TEAM_MAP.get(raw.get("proTeamId"))
    result["nfl_team_logo_url"] = (f"https://a.espncdn.com/i/teamlogos/nfl/500/{team_abbreviation.lower()}.png"
                                   if team_abbreviation else None)
    # Preserve absent appliedTotal as null instead of Player's default zero.
    for source, field in ((0, "fantasy_points"), (1, "projected_fantasy_points")):
        result[field] = next((stat.get("appliedTotal") for stat in raw.get("stats", [])
                              if stat.get("seasonId") == year
                              and stat.get("scoringPeriodId") == week
                              and stat.get("statSourceId") == source
                              and stat.get("statSplitTypeId") != 2), None)
    result["availability_status"] = entry.get("status") or entry.get("playerPoolEntry", {}).get("status")
    player_data = entry.get("playerPoolEntry", entry).get("player", {})
    result["headshot_url"] = (f"https://a.espncdn.com/i/headshots/nfl/players/full/{result['player_id']}.png"
                               if result.get("player_id") else None)
    result["jersey_number"] = player_data.get("jersey")
    result["age"] = player_data.get("age")
    result["height"] = player_data.get("height")
    result["weight"] = player_data.get("weight")
    result["eligible_positions"] = [POSITION_MAP.get(slot, str(slot))
                                     for slot in player_data.get("eligibleSlots", [])]
    return result


def stats_breakdown(raw_stats):
    """Return ESPN's real box-score categories using readable field names."""
    result = {}
    for stat_id, value in raw_stats.items():
        try:
            stat_id = int(stat_id)
        except (TypeError, ValueError):
            continue
        label = PLAYER_STATS_MAP.get(stat_id)
        if label is not None:
            result[label] = value
    return result


def simple_recommendation_factors(player, adjustments):
    """Turn supported projection inputs into short, manager-friendly reasons."""
    factors = []
    for row in adjustments or []:
        if not isinstance(row, dict):
            continue
        key = row.get("key")
        evidence = str(row.get("evidence") or "")
        if key == "role_trend":
            match = re.search(r"snap share changed from ([\d.]+)% to ([\d.]+)%", evidence, re.IGNORECASE)
            if match:
                old, new = map(float, match.groups())
                direction = "rose" if new > old else "fell" if new < old else "stayed about the same"
                factors.append(f"Recent snap share {direction} from {old:.0f}% to {new:.0f}%.")
        elif key == "matchup":
            match = re.search(r"allowed [\d.]+ .*?\(\s*([+-]?[\d.]+)%\)", evidence, re.IGNORECASE)
            if match:
                relative = float(match.group(1))
                description = f"{abs(relative):.1f}% {'more' if relative > 0 else 'fewer'}"
                factors.append(f"The opponent has allowed {description} {player.get('position') or ''} fantasy points than average.".replace("  ", " "))
        elif key == "recent_form":
            match = re.search(r"Last (\d+) prior games average (\d+(?:\.\d+)?); season mean (\d+(?:\.\d+)?)", evidence, re.IGNORECASE)
            if match:
                count, recent, season = match.groups()
                factors.append(f"His last {count} games averaged {float(recent):.1f} points; his season average is {float(season):.1f}.")
        elif key == "opportunity":
            match = re.search(r"Opportunity rate ([\d.]+) to ([\d.]+) per game", evidence, re.IGNORECASE)
            if match:
                old, new = map(float, match.groups())
                direction = "increased" if new > old else "decreased" if new < old else "was steady"
                factors.append(f"Recorded workload {direction} ({new:.1f} opportunities per game).")
        elif key in {"injury", "news", "teammate_context"}:
            label = row.get("label") or "Team news"
            if evidence:
                factors.append(f"{label}: {evidence}")
        if len(factors) == 3:
            break
    return factors


class ESPNService:
    def __init__(self):
        with espn_operation():
            self.league = connect_league()
        self.teams = {team.team_id: team for team in self.league.teams}
        self._memo_lock = threading.RLock()
        self._memo_cache = {}
        self._memo_locks = {}

    def memoized(self, key, ttl, loader):
        """Short-lived per-league cache with single-flight refresh and safe copies."""
        now = time.monotonic()
        with self._memo_lock:
            existing = self._memo_cache.get(key)
            if existing and now - existing[0] < ttl:
                return deepcopy(existing[1])
            key_lock = self._memo_locks.setdefault(key, threading.Lock())
        with key_lock:
            with self._memo_lock:
                existing = self._memo_cache.get(key)
                if existing and time.monotonic() - existing[0] < ttl:
                    return deepcopy(existing[1])
            value = loader()
            with self._memo_lock:
                self._memo_cache[key] = (time.monotonic(), deepcopy(value))
                while len(self._memo_cache) > 128:
                    oldest = min(self._memo_cache, key=lambda item: self._memo_cache[item][0])
                    self._memo_cache.pop(oldest, None)
            return value

    def week(self, selected=None):
        selected = self.league.current_week if selected is None else selected
        if not self.league.firstScoringPeriod <= selected <= self.league.finalScoringPeriod:
            raise APIError(422, "invalid_week", f"Week must be between {self.league.firstScoringPeriod} and {self.league.finalScoringPeriod}.")
        return selected

    def my_team(self):
        try:
            override = os.getenv("ESPN_TEAM_ID", "").strip()
            return select_team(self.league.teams, os.environ["ESPN_SWID"], int(override) if override else None)
        except ValueError:
            raise APIError(409, "team_selection_error", "Set server-side ESPN_TEAM_ID to a valid fantasy team ID; The configured ESPN owner cookie did not uniquely identify a team or the override was invalid.") from None

    def league_info(self):
        return {
            "league_id": self.league.league_id,
            "league_name": self.league.settings.name,
            "year": self.league.year,
            "current_week": self.league.current_week,
            "first_week": self.league.firstScoringPeriod,
            "last_week": self.league.finalScoringPeriod,
            "fantasy_team_count": len(self.teams),
            "fantasy_weeks": sorted({w for weeks in self.league.settings.matchup_periods.values() for w in weeks}),
        }

    def fantasy_matchups(self, selected=None):
        week = self.week(selected)
        return self.memoized(("fantasy_matchups", week), 12,
                             lambda: self._fetch_fantasy_matchups(week))

    def _fetch_fantasy_matchups(self, week):
        periods = [int(period) for period, weeks in self.league.settings.matchup_periods.items() if week in weeks]
        if not periods:
            raise APIError(422, "invalid_week", "ESPN has no fantasy matchup period configured for this week.")
        my_team_id = self.my_team().team_id
        with espn_operation():
            # League.box_scores clamps future weeks to current_week. Use its
            # authenticated client with an explicit week and fantasy period.
            data = self.league.espn_request.league_get(
                params={"view": ["mMatchupScore", "mScoreboard"], "scoringPeriodId": week},
                headers={"x-fantasy-filter": json.dumps({"schedule": {"filterMatchupPeriodIds": {"value": periods}}})},
            )
            if data.get("scoringPeriodId") != week:
                raise APIError(502, "espn_week_mismatch", "ESPN returned a different scoring week than requested.")
            matchups = []
            for matchup in data["schedule"]:
                if matchup["matchupPeriodId"] not in periods:
                    continue
                home = self.fantasy_matchup_team(matchup.get("home"), week)
                away = self.fantasy_matchup_team(matchup.get("away"), week)
                matchups.append({
                    "fantasy_matchup_id": matchup["id"],
                    "fantasy_matchup_period_id": matchup["matchupPeriodId"],
                    "week": week,
                    "home_team": home,
                    "away_team": away,
                    "is_bye": home is None or away is None,
                    "involves_my_team": any(t and t["team_id"] == my_team_id for t in (home, away)),
                })
            return {"league_id": self.league.league_id, "year": self.league.year,
                    "week": week, "my_team_id": my_team_id, "fantasy_matchups": matchups}

    def fantasy_matchup_team(self, raw, week):
        if raw is None:
            return None
        team = self.teams[raw["teamId"]]
        roster_data = raw.get("rosterForCurrentScoringPeriod")
        roster = None if roster_data is None else [
            raw_player_json(entry, self.league.year, week) for entry in roster_data.get("entries", [])
        ]
        projection = raw.get("totalProjectedPointsLive", raw.get("totalProjectedPoints"))
        projection_source = "espn_team_total" if projection is not None else None
        if projection is None and roster:
            starters = [p for p in roster if p["is_starter"]]
            if starters and all(p["projected_fantasy_points"] is not None for p in starters):
                projection = sum(p["projected_fantasy_points"] for p in starters)
                projection_source = "sum_of_espn_starter_projections"
        return {
            **team_json(team),
            "current_fantasy_score": raw.get("totalPointsLive", raw.get("totalPoints")),
            "weekly_fantasy_score": raw.get("pointsByScoringPeriod", {}).get(str(week)),
            "projected_fantasy_score": projection,
            "projection_source": projection_source,
            "roster": roster,
            "roster_source": "espn_selected_week" if roster_data is not None else None,
        }

    def my_team_info(self, selected=None):
        week = self.week(selected)
        team = self.my_team()
        matchups = self.fantasy_matchups(week)
        selected_team = None
        for matchup in matchups["fantasy_matchups"]:
            for side in ("home_team", "away_team"):
                candidate = matchup[side]
                if candidate and candidate["team_id"] == team.team_id:
                    selected_team = {"week": week, **candidate}
                    break
            if selected_team:
                break
        # Read the selected week's ESPN roster directly if there is no scheduled
        # fantasy matchup, rather than substituting today's roster for the past.
        with espn_operation():
            data = self.league.espn_request.league_get(params={"view": "mRoster", "scoringPeriodId": week})
            raw = next(t for t in data["teams"] if t["id"] == team.team_id)
            roster_data = raw.get("roster")
            selected_team = {"week": week, **team_json(team), "roster": None if roster_data is None else [
                raw_player_json(p, self.league.year, week) for p in roster_data.get("entries", [])
            ]}
        # One batched ESPN player-card lookup supplies real NFL opponent/kickoff
        # metadata for the game-day rail. Reuse the same short-lived insight
        # cache used by Start/Sit and player profiles rather than fetching each
        # starter separately.
        roster = selected_team.get("roster")
        if roster:
            insights = self.player_insights([player["player_id"] for player in roster], week)
            selected_team = dict(selected_team)
            selected_team["roster"] = [
                {**player, **{key: value for key, value in insights.get(player["player_id"], {}).items()
                              if key in {"nfl_opponent", "nfl_game_time", "bye_week", "jersey_number",
                                         "headshot_url", "future_nfl_schedule"}}}
                for player in roster
            ]
        return selected_team

    def free_agents(self, selected=None, position=None, limit=50):
        week = self.week(selected)
        ttl = 20 if week == self.league.current_week else 90
        return self.memoized(("free_agents", week, position, limit), ttl,
                             lambda: self._fetch_free_agents(week, position, limit))

    def _fetch_free_agents(self, week, position, limit):
        with espn_operation():
            # Match espn-api.free_agents filtering but preserve raw missing stats.
            from espn_api.football.constant import POSITION_MAP
            filters = {"players": {
                "filterStatus": {"value": ["FREEAGENT", "WAIVERS"]},
                "filterSlotIds": {"value": [] if position is None else [POSITION_MAP[position]]},
                "limit": limit,
                "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
                "sortDraftRanks": {"sortPriority": 100, "sortAsc": True, "value": "STANDARD"},
            }}
            data = self.league.espn_request.league_get(
                params={"view": "kona_player_info", "scoringPeriodId": week},
                headers={"x-fantasy-filter": json.dumps(filters)},
            )
            return {"week": week, "position": position, "ranking": "espn_percent_owned_descending",
                    "includes_waivers": True, "players": [
                        {**raw_player_json(p, self.league.year, week), "lineup_slot": "FA",
                         "lineup_status": "available", "is_starter": False} for p in data["players"]
                    ]}

    def search_players(self, query=None, limit=20, team=None, position=None,
                       roster_status=None, sort="our_projection", selected=None):
        """Search the real ESPN player pool plus all real current league rosters."""
        week = self.week(selected)
        term = (query or "").strip().casefold()
        if len(term) == 1:
            raise APIError(422, "invalid_player_search", "Use at least two characters, or choose a team or position filter.")
        key = ("player_search", week, term, limit, (team or "").casefold(), position,
               roster_status, sort)
        ttl = 25 if week == self.league.current_week else 120
        return self.memoized(key, ttl, lambda: self._fetch_search_players(
            query, limit, team, position, roster_status, sort, week))

    def _fetch_search_players(self, query, limit, team, position, roster_status, sort, week):
        term = (query or "").strip().casefold()
        with espn_operation():
            known = {}
            roster_owner = {}
            matchup_payload = self.fantasy_matchups(week)
            for matchup in matchup_payload["fantasy_matchups"]:
                for side in ("home_team", "away_team"):
                    fantasy_team = matchup.get(side)
                    if not fantasy_team:
                        continue
                    owner_names = [owner.get("displayName") or " ".join(filter(None, (owner.get("firstName"), owner.get("lastName"))))
                                   for owner in fantasy_team.get("owners", [])]
                    for player in fantasy_team.get("roster") or []:
                        known[player["player_id"]] = dict(player)
                        roster_owner[player["player_id"]] = {"fantasy_team_id": fantasy_team["team_id"],
                                                             "fantasy_team_name": fantasy_team["team_name"],
                                                             "fantasy_team_owner": ", ".join(name for name in owner_names if name) or None,
                                                             "roster_status": "rostered"}
            available = self.free_agents(week, None, 500)["players"]
            available_ids = set()
            for player in available:
                available_ids.add(player["player_id"])
                known.setdefault(player["player_id"], dict(player))
            # ESPN's player map is the authoritative name index; match before
            # fetching cards, then merge only the requested/filter-relevant pool.
            if term:
                for player_id, name in self.league.player_map.items():
                    if isinstance(player_id, int) and term in name.casefold():
                        known.setdefault(player_id, {"player_id": player_id, "name": name})
            def matches(player):
                text_match = (not term or term in str(player.get("name") or "").casefold()
                              or term in str(player.get("nfl_team") or "").casefold()
                              or term in str(player.get("position") or "").casefold())
                player_id = player["player_id"]
                ownership_match = (
                    roster_status is None
                    or (roster_status == "rostered" and player_id in roster_owner)
                    or (roster_status == "available" and player_id in available_ids and player_id not in roster_owner)
                )
                return (text_match and ownership_match
                        and (not team or str(player.get("nfl_team") or "").casefold() == team.casefold())
                        and (not position or player.get("position") == position))
            candidates = [player for player in known.values() if matches(player)]
            candidates.sort(key=lambda item: (not str(item.get("name") or "").casefold().startswith(term),
                                              str(item.get("name") or "").casefold()))
            ids = [item["player_id"] for item in candidates]
            cards = {}
            for offset in range(0, min(len(ids), 500), 50):
                data = self.league.espn_request.get_player_card(ids[offset:offset + 50], self.league.finalScoringPeriod)
                for entry in data.get("players", []):
                    detail = raw_player_json(entry, self.league.year, week)
                    detail["fantasy_team_id"] = entry.get("onTeamId") or detail.get("fantasy_team_id")
                    raw_player = entry.get("playerPoolEntry", entry).get("player", {})
                    by_week = {}
                    for row in raw_player.get("stats", []):
                        if row.get("seasonId") != self.league.year or row.get("statSplitTypeId") == 2:
                            continue
                        bucket = by_week.setdefault(row.get("scoringPeriodId"), {})
                        bucket["actual" if row.get("statSourceId") == 0 else "projected"] = row
                    detail["game_log"] = [{"week": period, "fantasy_points": value["actual"].get("appliedTotal"),
                                           "projected_fantasy_points": value.get("projected", {}).get("appliedTotal"),
                                           "stats": stats_breakdown(value["actual"].get("stats", {}))}
                                          for period, value in sorted(by_week.items())
                                          if isinstance(period, int) and period > 0 and value.get("actual", {}).get("appliedTotal") is not None]
                    season = by_week.get(0, {}).get("actual", {})
                    detail["season_fantasy_points"] = season.get("appliedTotal")
                    detail["season_fantasy_average"] = season.get("appliedAverage")
                    cards[detail["player_id"]] = detail
            records = []
            for candidate in candidates:
                player_id = candidate["player_id"]
                item = {**candidate, **cards.get(player_id, {})}
                if player_id in roster_owner:
                    item.update(roster_owner[player_id])
                elif player_id in available_ids:
                    item.update({"fantasy_team_id": None, "fantasy_team_name": None,
                                 "fantasy_team_owner": None, "roster_status": "available"})
                elif item.get("fantasy_team_id"):
                    item["roster_status"] = "rostered"
                else:
                    # A result without an authoritative roster/availability record
                    # is not presented as free agent.
                    item["roster_status"] = "unknown"
                records.append(item)
            from projection_engine import project_players
            projections = project_players(records, week, self.league.current_week)
            for item in records:
                item["custom_projection"] = projections[item["player_id"]]
            keys = {"our_projection": lambda p: (p.get("custom_projection", {}).get("our_projection"),),
                    "espn_projection": lambda p: (p.get("projected_fantasy_points"),),
                    "season_points": lambda p: (p.get("season_fantasy_points"),),
                    "points_per_game": lambda p: (p.get("season_fantasy_average"),),
                    "recent": lambda p: (sum(g["fantasy_points"] for g in (p.get("game_log") or [])[-3:]) /
                                          len((p.get("game_log") or [])[-3:]) if (p.get("game_log") or [])[-3:] else None,)}
            def sortable(player):
                value = keys[sort](player)[0]
                return (value is not None, value if value is not None else float("-inf"), str(player.get("name") or "").casefold())
            records.sort(key=sortable, reverse=True)
            fields = ("player_id", "name", "position", "nfl_team", "nfl_team_id", "nfl_team_logo_url", "headshot_url", "jersey_number",
                      "injury_status", "fantasy_points", "projected_fantasy_points", "season_fantasy_points",
                      "season_fantasy_average", "fantasy_team_id", "fantasy_team_name", "fantasy_team_owner",
                      "availability_status", "roster_status", "custom_projection")
            return {"query": query, "team": team, "position": position, "status": roster_status, "sort": sort,
                    "week": week, "source": "ESPN Fantasy active player pool and league rosters",
                    "players": [{field: player.get(field) for field in fields} for player in records[:limit]]}

    def player_insights(self, player_ids, selected=None):
        """Batch ESPN player cards into real season logs, usage, and NFL schedule data."""
        week = self.week(selected)
        ids = list(dict.fromkeys(int(player_id) for player_id in player_ids))
        if not ids:
            return {}
        ttl = 30 if week == self.league.current_week else 300
        key = ("player_insights", week, tuple(sorted(ids)))
        return self.memoized(key, ttl, lambda: self._fetch_player_insights(ids, week))

    def _fetch_player_insights(self, ids, week):
        with espn_operation():
            data = self.league.espn_request.get_player_card(ids, self.league.finalScoringPeriod)
            schedule = self.league.espn_request.get_pro_schedule().get("settings", {}).get("proTeams", [])
            by_team = {team.get("id"): team for team in schedule}
            insights = {}
            for entry in data.get("players", []):
                result = raw_player_json(entry, self.league.year, week)
                raw = entry.get("playerPoolEntry", entry).get("player", {})
                games_by_week = by_team.get(raw.get("proTeamId"), {}).get("proGamesByScoringPeriod", {})
                scheduled = games_by_week.get(str(week), [])
                if scheduled:
                    game = scheduled[0]
                    opponent_id = (game["homeProTeamId"] if game["awayProTeamId"] == raw.get("proTeamId")
                                   else game["awayProTeamId"])
                    result["nfl_opponent"] = PRO_TEAM_MAP.get(opponent_id)
                    result["nfl_game_time"] = datetime.fromtimestamp(game["date"] / 1000, timezone.utc).isoformat()
                else:
                    result["nfl_opponent"] = None
                    result["nfl_game_time"] = None
                future_schedule = []
                for period in range(week, min(self.league.finalScoringPeriod, 18) + 1):
                    week_games = games_by_week.get(str(period), [])
                    for game in week_games:
                        opponent_id = (game["homeProTeamId"] if game["awayProTeamId"] == raw.get("proTeamId")
                                       else game["awayProTeamId"])
                        future_schedule.append({
                            "week": period,
                            "opponent": PRO_TEAM_MAP.get(opponent_id),
                            "game_time": datetime.fromtimestamp(game["date"] / 1000, timezone.utc).isoformat(),
                        })
                result["future_nfl_schedule"] = future_schedule
                result["bye_week"] = next((period for period in range(1, 19)
                                           if not games_by_week.get(str(period))), None)
                result["jersey_number"] = raw.get("jersey")
                result["nfl_team_id"] = raw.get("proTeamId")
                result["fantasy_team_id"] = entry.get("onTeamId")
                by_week = {}
                for stats in raw.get("stats", []):
                    if stats.get("seasonId") != self.league.year or stats.get("statSplitTypeId") == 2:
                        continue
                    period = stats.get("scoringPeriodId")
                    bucket = by_week.setdefault(period, {})
                    if stats.get("statSourceId") == 0:
                        bucket["actual"] = stats
                    elif stats.get("statSourceId") == 1:
                        bucket["projected"] = stats
                game_log = []
                for period, bucket in sorted(by_week.items(), key=lambda item: item[0]):
                    actual = bucket.get("actual", {})
                    if not isinstance(period, int) or period <= 0 or actual.get("appliedTotal") is None:
                        continue
                    game_log.append({
                        "week": period,
                        "fantasy_points": actual.get("appliedTotal"),
                        "projected_fantasy_points": bucket.get("projected", {}).get("appliedTotal"),
                        "stats": stats_breakdown(actual.get("stats", {})),
                    })
                season = by_week.get(0, {}).get("actual", {})
                result["season_fantasy_average"] = season.get("appliedAverage")
                result["season_fantasy_points"] = season.get("appliedTotal")
                result["game_log"] = game_log
                result["last_3_games"] = game_log[-3:]
                result["last_5_games"] = game_log[-5:]
                result["game_stats"] = stats_breakdown(by_week.get(week, {}).get("actual", {}).get("stats", {}))
                insights[result["player_id"]] = result
            return insights

    def recommendation_settings(self):
        settings = self.league.settings
        raw_items = {item.get("statId"): item for item in settings._raw_scoring_settings.get("scoringItems", [])}
        return {
            "scoring_type": settings.scoring_type,
            "player_rank_type": settings._raw_scoring_settings.get("playerRankType"),
            "tie_rule": getattr(settings, "tie_rule", None),
            "playoff_tie_rule": getattr(settings, "playoff_tie_rule", None),
            "scoring_format": [{"stat_id": row.get("id"), "label": row.get("label"),
                                "points": row.get("points"),
                                "points_overrides": raw_items.get(row.get("id"), {}).get("pointsOverrides", {})}
                               for row in settings.scoring_format],
            "position_slot_counts": {slot: int(count) for slot, count in settings.position_slot_counts.items()
                                     if slot not in {"BE", "IR", "ER", "", "Rookie"} and int(count) > 0},
            "allow_out_of_position_scoring": bool(
                settings._raw_scoring_settings.get("allowOutOfPositionScoring", False)
            ),
        }

    def start_sit_advice(self, selected=None):
        week = self.week(selected)
        team = self.my_team_info(week)
        if team.get("roster") is None:
            raise APIError(502, "espn_roster_unavailable", "ESPN did not provide your roster for the selected fantasy week.")
        from recommendation_service import optimize_lineup, confidence_aware_value, assess_start_sit_swap, usage_summary, usable_number
        roster = team["roster"]
        insights = self.player_insights([player["player_id"] for player in roster], week)
        enriched = [{**player, **{key: value for key, value in insights.get(player["player_id"], {}).items()
                                  if key not in {"lineup_slot", "lineup_status", "is_starter", "fantasy_points",
                                                "projected_fantasy_points", "eligible_positions"}}}
                    for player in roster]
        from projection_sources.context import enrich_players
        from projection_engine import project_players
        contextual, _source_status = enrich_players(enriched, self.league.year, week, self)
        models = project_players(list(contextual.values()), week, self.league.current_week)
        enriched = list(contextual.values())
        for player in enriched:
            player["custom_projection"] = models.get(player["player_id"])
            value, source, reliability = confidence_aware_value(player)
            player.update(reliability)
            player["recommendation_projection"] = value
            player["recommendation_estimate_source"] = source
        rules = self.recommendation_settings()
        optimized = optimize_lineup(enriched, rules["position_slot_counts"], week, confidence_aware=True)
        for player in optimized["starters"]:
            player["recent_usage"] = usage_summary((player.get("game_log") or [])[-5:])
            model = player.get("custom_projection") or {}
            adjustments = model.get("adjustments") or []
            friendly_factors = simple_recommendation_factors(player, adjustments)
            player["recommendation_factors"] = friendly_factors
            player["recommendation_reason"] = (
                f"Best estimated full lineup for the {player.get('recommended_slot_label') or player['recommended_slot']} spot"
                if player.get("expected_points") is not None else "Only eligible lineup option; projection is unavailable."
            )
            if friendly_factors:
                player["recommendation_reason"] += " " + " ".join(friendly_factors)
            if player.get("nfl_opponent"):
                player["recommendation_reason"] += f" NFL opponent: {player['nfl_opponent']}."
            alternatives = [candidate for candidate in optimized["bench"]
                            if player["recommended_slot"] in (candidate.get("eligible_positions") or [])
                            and usable_number(candidate.get("expected_points"))]
            alternatives.sort(key=lambda candidate: candidate["expected_points"], reverse=True)
            if alternatives and usable_number(player.get("expected_points")):
                alternative = alternatives[0]
                edge = float(player["expected_points"]) - float(alternative["expected_points"])
                player["recommendation_reason"] += (f" Versus the top remaining eligible option, {alternative['name']} "
                                                     f"({float(alternative['expected_points']):.1f}), this is a {edge:+.1f}-point model edge.")
            if player.get("injury_status") not in (None, "", "ACTIVE", "NORMAL"):
                player["recommendation_reason"] += f" ESPN status: {player['injury_status']} (uncertainty is reflected where the model supports it)."
        for player in optimized["bench"]:
            player["recent_usage"] = usage_summary((player.get("game_log") or [])[-5:])
            player["recommendation_factors"] = simple_recommendation_factors(
                player, (player.get("custom_projection") or {}).get("adjustments") or [])
            if player.get("bye_week") == week:
                reason = "NFL bye week; no game is scheduled."
            elif player.get("lineup_status") == "reserve":
                reason = "ESPN has this player in a reserve slot."
            elif player.get("expected_points") is None:
                reason = "There is not enough information to compare this player fairly."
            else:
                reason = "Another legal lineup combination has the higher recommendation estimate."
            if (player.get("custom_projection") or {}).get("adjustments"):
                if player["recommendation_factors"]:
                    reason += " " + " ".join(player["recommendation_factors"])
                else:
                    reason += " More projection details are available in the player profile."
            player["recommendation_reason"] = reason
        current_total = sum(float(value) for player in enriched if player.get("is_starter")
                            for value, _, _ in [confidence_aware_value(player)] if value is not None)
        recommended_total = sum(player["expected_points"] for player in optimized["starters"]
                                if player.get("expected_points") is not None)
        proposed_in = [p for p in optimized["starters"] if not p.get("is_starter")]
        proposed_out = [p for p in enriched if p.get("is_starter")
                        and p["player_id"] not in {item["player_id"] for item in optimized["starters"]}]
        decisions = []
        unused_outgoing = list(proposed_out)
        # Pair a new starter with someone who can legally be replaced in the
        # ESPN slot they currently occupy. This prevents a WR recommendation
        # from being described as replacing an RB who is still required.
        for incoming in proposed_in:
            compatible = [outgoing for outgoing in unused_outgoing
                          if outgoing.get("position") == incoming.get("position")]
            if not compatible:
                compatible = [outgoing for outgoing in unused_outgoing
                              if (outgoing.get("lineup_slot") in (incoming.get("eligible_positions") or []))]
            if not compatible:
                continue
            outgoing = compatible[0]
            unused_outgoing.remove(outgoing)
            assessment = assess_start_sit_swap(incoming, outgoing, enriched)
            confidence = assessment["confidence"]
            decisions.append({"start": incoming, "bench": outgoing,
                              "start_slot": incoming.get("recommended_slot_label") or incoming.get("recommended_slot"),
                              "bench_slot": outgoing.get("lineup_slot"), **assessment,
                              "recommendation": "TOSS-UP — keeping your current starter is reasonable." if confidence == "low" else
                                                ("LEAN — the edge is real but still uncertain." if confidence == "medium" else "START / BENCH"),
                              "reason": incoming.get("recommendation_reason") or "The full lineup was compared using your ESPN slot rules."})
        # Do not turn a raw optimizer swap into advice when the player-level
        # estimate has no measurable uncertainty or the edge is inside it.
        actionable = [decision for decision in decisions if decision["confidence"] in {"high", "medium"}]
        current_slots = {player["player_id"]: player.get("lineup_slot")
                         for player in enriched if player.get("is_starter") and player.get("lineup_slot")}
        recommended_slots = {player["player_id"]: player.get("recommended_slot_label") or player.get("recommended_slot")
                             for player in optimized["starters"]}
        def slot_group(slot):
            # ESPN reports a shared slot name (RB/WR/TE), while our optimized
            # display adds ordinal labels such as RB1 and WR2. Compare the
            # underlying slot groups so label changes alone are not reported
            # as lineup moves.
            value = str(slot or "Bench")
            if value in {"RB1", "RB2"}:
                return "RB"
            if value in {"WR1", "WR2"}:
                return "WR"
            if value == "FLEX":
                return "RB/WR/TE"
            return value
        roster_by_id = {player["player_id"]: player for player in enriched}
        slot_changes = []
        for player_id in current_slots.keys() | recommended_slots.keys():
            previous = current_slots.get(player_id, "Bench")
            recommended = recommended_slots.get(player_id, "Bench")
            if slot_group(previous) != slot_group(recommended):
                player = roster_by_id[player_id]
                slot_changes.append({"player_id": player_id, "name": player.get("name"),
                                     "position": player.get("position"),
                                     "current_slot": previous, "recommended_slot": recommended})
        slot_changes.sort(key=lambda row: (row["recommended_slot"] == "Bench", row["recommended_slot"], row["name"] or ""))
        changes = {
            "start": [decision["start"] for decision in actionable],
            "bench": [decision["bench"] for decision in actionable],
            "decisions": decisions,
            "slot_changes": slot_changes,
            "recommendation_confidence": max((d["confidence"] for d in decisions), key={"low": 0, "medium": 1, "high": 2}.get, default="unavailable"),
            "toss_up_count": sum(1 for d in decisions if d["confidence"] == "low"),
            "improvement_points": round(recommended_total - current_total, 2),
        }
        return {
            "week": week, "team_id": team["team_id"], "team_name": team["team_name"],
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "model": "We compare complete lineups using your ESPN starting-slot and player-eligibility rules. A suggested move must be worth considering after accounting for how sure we are about the estimates.",
            "scoring_rules": rules, "recommended_starters": optimized["starters"],
            "bench": optimized["bench"], "lineup_changes": changes,
            "current_projected_total": round(current_total, 2),
            "recommended_projected_total": round(recommended_total, 2),
            "unfilled_slots": optimized["unfilled_slots"],
            "legal_lineup": optimized["legal_lineup"],
        }

    def waiver_advice(self, selected=None, limit=100, positions=None):
        week = self.week(selected)
        from recommendation_service import waiver_score, confidence_aware_value, established_roster_player, usable_number
        roster_info = self.my_team_info(week)
        roster = roster_info.get("roster") or []
        roster_ids = {player["player_id"] for player in roster}
        pool = self.free_agents(week, None, limit)["players"]
        selected_positions = set(positions or [])
        if selected_positions:
            pool = [player for player in pool if player.get("position") in selected_positions]
        insights = self.player_insights([player["player_id"] for player in roster + pool], week)
        candidates = []
        roster_enriched = []
        for player in roster:
            detail = insights.get(player["player_id"], {})
            merged = {**detail, **player}
            for field in ("game_log", "season_fantasy_average", "season_fantasy_points", "eligible_positions", "bye_week", "future_nfl_schedule"):
                if player.get(field) is None and detail.get(field) is not None:
                    merged[field] = detail[field]
            roster_enriched.append(merged)
        for player in pool:
            # ESPN availability filter is primary; card ownership and the full
            # real roster list provide a second guard against recommending an
            # already rostered player.
            detail = insights.get(player["player_id"], {})
            if player["player_id"] in roster_ids or detail.get("fantasy_team_id") not in (None, 0):
                continue
            combined = {**detail, **player, "lineup_status": "available", "is_starter": False,
                        "eligible_positions": detail.get("eligible_positions") or [player.get("position")]}
            # The league's availability query sometimes contains a projection
            # that the batch player-card endpoint omits; preserve that actual
            # ESPN value rather than letting a null card field erase it.
            for field in ("fantasy_points", "projected_fantasy_points", "season_fantasy_average"):
                if detail.get(field) is None:
                    combined[field] = player.get(field)
            score = waiver_score(combined)
            combined.update(score)
            candidates.append(combined)
        rules = self.recommendation_settings()
        from recommendation_service import optimize_lineup, roster_needs
        from projection_sources.context import enrich_players
        from projection_engine import project_players
        combined_players = roster_enriched + candidates
        contextual, source_status = enrich_players(combined_players, self.league.year, week, self)
        models = project_players(list(contextual.values()), week, self.league.current_week)
        roster_enriched = [contextual.get(p["player_id"], p) for p in roster_enriched]
        candidates = [contextual.get(p["player_id"], p) for p in candidates]
        for player in roster_enriched + candidates:
            player["custom_projection"] = models.get(player["player_id"])
            if player["custom_projection"] and player["custom_projection"].get("confidence"):
                player["confidence"] = player["custom_projection"]["confidence"]
            recommendation, _, reliability = confidence_aware_value(player)
            player.update(reliability)
            if usable_number(recommendation):
                player["recommendation_score"] = recommendation
                player["score_weights"] = {"custom_projection": player.get("custom_weight"), "available_reference_mean": 1 - (player.get("custom_weight") or 0)}
                player["score_formula"] = "Recommendation estimate = confidence share × raw custom mean + remaining share × equal mean of available ESPN projection, season average, and recent actual averages. The custom share is observed games/5 × the projection engine's empirical shrinkage; low-confidence unsupported extreme disagreements get zero custom influence."
        matchups = self.fantasy_matchups(week)
        league_rosters = []
        for matchup in matchups.get("fantasy_matchups", []):
            for side in ("home_team", "away_team"):
                team_row = matchup.get(side)
                if team_row and team_row.get("roster") is not None:
                    league_rosters.append(team_row)
        # The actual roster plus custom projections is authoritative for this team.
        league_rosters = [row for row in league_rosters if row.get("team_id") != roster_info["team_id"]]
        league_rosters.append({**roster_info, "roster": roster_enriched})
        needs = roster_needs(league_rosters, roster_info["team_id"], rules["position_slot_counts"], week, confidence_aware=True)
        baseline = optimize_lineup(roster_enriched, rules["position_slot_counts"], week, confidence_aware=True)
        baseline_total = sum(float(p["expected_points"]) for p in baseline["starters"] if usable_number(p.get("expected_points")))
        for player in candidates:
            augmented = optimize_lineup(roster_enriched + [player], rules["position_slot_counts"], week, confidence_aware=True)
            total = sum(float(p["expected_points"]) for p in augmented["starters"] if usable_number(p.get("expected_points")))
            pos = player.get("position")
            player["weekly_lineup_improvement"] = round(total - baseline_total, 2)
            player["roster_need"] = needs.get(pos, {}).get("label", "Unavailable")
            player["needs_match"] = player["roster_need"] in {"Weak", "Weak depth", "Needs improvement"}
            player["positional_scarcity"] = player["roster_need"]
            player["positional_scarcity_score"] = 1 if player["needs_match"] else 0
            player["recommendation_reason"] = (
                f"Addresses your {pos} roster need ({player['roster_need']}). "
                f"Re-optimizing actual ESPN eligible slots changes this week's starters by {player['weekly_lineup_improvement']:+.2f} points."
            )
        candidates.sort(key=lambda p: (p.get("needs_match", False), p.get("weekly_lineup_improvement") or 0,
                                       p.get("recommendation_score") is not None,
                                       p.get("recommendation_score") if p.get("recommendation_score") is not None else float("-inf")), reverse=True)
        safe_drops = []
        for player in roster_enriched:
            status = (player.get("injury_status") or "").upper()
            if (player.get("lineup_status") != "bench" or status not in {"ACTIVE", "NORMAL"}
                    or established_roster_player(player, roster_enriched)):
                continue
            safe_drops.append(player)
        for player in safe_drops:
            player.update(waiver_score(player))
            player["recommendation_score"] = player.get("recommendation_projection", player.get("recommendation_score"))
        safe_drops.sort(key=lambda item: item.get("recommendation_score") if usable_number(item.get("recommendation_score")) else float("inf"))
        move = None
        first_future_week = max(week, self.league.current_week + 1)
        def remaining_schedule(player):
            schedule = player.get("future_nfl_schedule")
            if not isinstance(schedule, list):
                return None
            return sum(1 for game in schedule if usable_number(game.get("week")) and game["week"] >= first_future_week)
        best_move_score = float("-inf")
        for add in candidates:
            for drop in safe_drops:
                after_roster = [p for p in roster_enriched if p["player_id"] != drop["player_id"]] + [add]
                after_lineup = optimize_lineup(after_roster, rules["position_slot_counts"], week, confidence_aware=True)
                after_total = sum(float(p["expected_points"]) for p in after_lineup["starters"] if usable_number(p.get("expected_points")))
                weekly_change = round(after_total - baseline_total, 2)
                # Rest-of-season valuation uses each player's real season rate,
                # not a selected-week matchup-specific projection.
                add_avg = add.get("season_fantasy_average")
                drop_avg = drop.get("season_fantasy_average")
                add_games, drop_games = remaining_schedule(add), remaining_schedule(drop)
                ros_change = (round(float(add_avg) * add_games - float(drop_avg) * drop_games, 2)
                              if usable_number(add_avg) and usable_number(drop_avg)
                              and add_games is not None and drop_games is not None else None)
                needs_matched = add.get("needs_match", False)
                # Require measurable starter benefit, or meaningful depth need plus a real ROS edge.
                add_sd = (add.get("custom_projection") or {}).get("standard_deviation")
                drop_sd = (drop.get("custom_projection") or {}).get("standard_deviation")
                measurable_uncertainty = (math.sqrt(float(add_sd) ** 2 + float(drop_sd) ** 2)
                                          if usable_number(add_sd) and usable_number(drop_sd) else None)
                weekly_threshold = max(0.5, measurable_uncertainty) if measurable_uncertainty is not None else float("inf")
                qualifies = weekly_change >= weekly_threshold or (needs_matched and ros_change is not None and ros_change >= 8)
                if not qualifies or (ros_change is not None and ros_change < -8):
                    continue
                score = weekly_change + ((ros_change / max(add_games or 0, drop_games or 0))
                                         if ros_change is not None and max(add_games or 0, drop_games or 0) else 0)
                if score > best_move_score:
                    best_move_score = score
                    move = {"add": add, "drop": drop, "expected_score_advantage": weekly_change,
                            "weekly_lineup_change": weekly_change, "rest_of_season_change": ros_change,
                            "reason": add.get("recommendation_reason", "Improves a roster need based on real league comparisons."),
                            "effect": {"starting_lineup": weekly_change, "rest_of_season": ros_change,
                                       "bench_depth": "Adds coverage at a below-median roster position." if needs_matched else "No measured weak-position depth improvement."}}
        def by_position(position):
            return [player for player in candidates if player.get("position") == position][:10]
        return {
            "week": week, "team_id": roster_info["team_id"], "team_name": roster_info["team_name"],
            "last_updated": datetime.now(timezone.utc).isoformat(), "free_agent_pool_size": len(pool),
            "eligible_free_agent_count": len(candidates), "rostered_player_ids_excluded": len(roster_ids),
            "ranking_model": "The custom projection engine remains a primary input, blended with ESPN and available season/recent scoring references using observed-history count and empirical shrinkage. Ranking then prioritizes measured roster need and confidence-aware optimized lineup improvement. Weekly add/drop suggestions must exceed the combined observed player uncertainty (and +0.5 points); otherwise only a measured weak-position need plus a supported rest-of-season edge can qualify. Season-productive bench assets, starters, reserve slots, and non-active players are not suggested drops.",
            "roster_needs": needs, "source_status": source_status,
            "minimum_add_drop_advantage": 0.5, "best_overall_adds": candidates[:15],
            "selected_positions": sorted(selected_positions),
            "best_qb_adds": by_position("QB"), "best_rb_adds": by_position("RB"),
            "best_wr_adds": by_position("WR"), "best_te_adds": by_position("TE"),
            "best_k_adds": by_position("K"), "best_dst_adds": by_position("D/ST"),
            "personalized_move": move,
            "move_note": None if move else "No priority waiver move recommended. Available players did not produce a meaningful optimized-lineup improvement or a supported rest-of-season benefit at a weak roster position.",
            "upside_stashes": [p for p in candidates if p.get("needs_match") and p.get("confidence") in {"low", "medium"}][:10],
            "streaming_options": [p for p in candidates if p.get("weekly_lineup_improvement", 0) > 0][:10],
        }

    def player_info(self, player_id, selected=None):
        week = self.week(selected)
        ttl = 25 if week == self.league.current_week else 180
        return self.memoized(("player_info", week, int(player_id)), ttl,
                             lambda: self._fetch_player_info(int(player_id), week))

    def _fetch_player_info(self, player_id, week):
        with espn_operation():
            data = self.league.espn_request.get_player_card([player_id], self.league.finalScoringPeriod)
            if not data.get("players"):
                raise APIError(404, "player_not_found", f"ESPN returned no player with ID {player_id}.")
            entry = data["players"][0]
            result = raw_player_json(entry, self.league.year, week)
            raw = data["players"][0]
            result["fantasy_team_id"] = raw.get("onTeamId")
            # The player card contains season history; the league roster view
            # is authoritative for current-week fantasy scoring, projection,
            # and lineup slot when ESPN publishes the player on a roster.
            roster_week = self.league.espn_request.league_get(
                params={"view": "mRoster", "scoringPeriodId": week}
            )
            all_roster_entries = []
            for fantasy_team in roster_week.get("teams", []):
                roster_entries = fantasy_team.get("roster", {}).get("entries", [])
                all_roster_entries.extend((fantasy_team["id"], fantasy_team, entry) for entry in roster_entries)
                roster_entry = next((p for p in roster_entries
                                     if p.get("playerPoolEntry", {}).get("player", {}).get("id") == player_id), None)
                if roster_entry:
                    current = raw_player_json(roster_entry, self.league.year, week)
                    for field in ("lineup_slot", "lineup_status", "is_starter", "fantasy_points",
                                  "projected_fantasy_points", "injury_status", "availability_status"):
                        result[field] = current[field]
                    result["fantasy_team_id"] = fantasy_team["id"]
                    result["fantasy_team_name"] = self.teams.get(fantasy_team["id"]).team_name if self.teams.get(fantasy_team["id"]) else None
                    result["fantasy_team_owner"] = ", ".join(owner.get("displayName") or " ".join(filter(None, (owner.get("firstName"), owner.get("lastName"))))
                                                               for owner in (self.teams.get(fantasy_team["id"]).owners if self.teams.get(fantasy_team["id"]) else [])
                                                               if owner.get("displayName") or owner.get("firstName") or owner.get("lastName")) or None
                    break
            player_data = raw.get("playerPoolEntry", raw).get("player", {})
            schedule = self.league.espn_request.get_pro_schedule().get("settings", {}).get("proTeams", [])
            pro_team = next((team for team in schedule if team["id"] == player_data.get("proTeamId")), None)
            games_by_week = pro_team.get("proGamesByScoringPeriod", {}) if pro_team else {}
            selected_game = games_by_week.get(str(week), [])
            upcoming_game = selected_game[0] if selected_game else None
            if upcoming_game:
                opponent_id = (upcoming_game["homeProTeamId"] if upcoming_game["awayProTeamId"] == player_data.get("proTeamId")
                               else upcoming_game["awayProTeamId"])
                from espn_api.football.constant import PRO_TEAM_MAP
                result["nfl_opponent"] = PRO_TEAM_MAP.get(opponent_id)
                result["nfl_game_time"] = datetime.fromtimestamp(upcoming_game["date"] / 1000, timezone.utc).isoformat()
            else:
                result["nfl_opponent"] = None
                result["nfl_game_time"] = None
            result["jersey_number"] = player_data.get("jersey")
            result["nfl_team_id"] = player_data.get("proTeamId")
            result["bye_week"] = next((int(w) for w in range(1, 19) if not games_by_week.get(str(w))), None)
            by_week = {}
            for stats in player_data.get("stats", []):
                if stats.get("seasonId") != self.league.year or stats.get("statSplitTypeId") == 2:
                    continue
                period = stats.get("scoringPeriodId")
                source = stats.get("statSourceId")
                bucket = by_week.setdefault(period, {})
                if source == 0:
                    bucket["actual"] = stats
                elif source == 1:
                    bucket["projected"] = stats
            weekly_stats = []
            for w, bucket in sorted(by_week.items()):
                actual = bucket.get("actual", {})
                if w <= 0 or actual.get("appliedTotal") is None:
                    continue
                weekly_stats.append({
                    "week": w,
                    "fantasy_points": actual.get("appliedTotal"),
                    "projected_fantasy_points": bucket.get("projected", {}).get("appliedTotal"),
                    "stats": stats_breakdown(actual.get("stats", {})),
                })
            result["game_log"] = weekly_stats
            # Keep the existing compact history property for clients already
            # using the original player endpoint shape.
            result["weekly_stats"] = [
                {"week": game["week"], "fantasy_points": game["fantasy_points"],
                 "projected_fantasy_points": game["projected_fantasy_points"]}
                for game in weekly_stats
            ]
            result["last_3_games"] = weekly_stats[-3:]
            result["last_5_games"] = weekly_stats[-5:]
            season = by_week.get(0, {}).get("actual", {})
            result["season_fantasy_average"] = season.get("appliedAverage")
            result["season_fantasy_points"] = season.get("appliedTotal")
            result["game_stats"] = stats_breakdown(by_week.get(week, {}).get("actual", {}).get("stats", {}))
            availability = str(entry.get("status") or "").upper()
            if result.get("fantasy_team_id"):
                result["roster_status"] = "rostered"
            elif availability in {"FREEAGENT", "WAIVERS"}:
                result["roster_status"] = "available"
            else:
                result["roster_status"] = "unknown"
            profile_fields = {key: result.get(key) for key in (
                "nfl_opponent", "nfl_game_time", "bye_week", "jersey_number", "age", "height", "weight",
                "weekly_stats", "last_3_games", "last_5_games", "game_log", "game_stats",
                "season_fantasy_average", "season_fantasy_points")}
            # Build league-scope ranks from the real ESPN roster player cards.
            # This is an on-demand detail request; search results themselves
            # never trigger full game-history/context retrieval.
            rank_players = []
            for fantasy_team_id, fantasy_team, roster_entry in all_roster_entries:
                rank_player = raw_player_json(roster_entry, self.league.year, week)
                rank_player["fantasy_team_id"] = fantasy_team_id
                rank_player["fantasy_team_name"] = self.teams.get(fantasy_team_id).team_name if self.teams.get(fantasy_team_id) else None
                rank_player["fantasy_team_owner"] = ", ".join(owner.get("displayName") or " ".join(filter(None, (owner.get("firstName"), owner.get("lastName"))))
                                                                 for owner in (self.teams.get(fantasy_team_id).owners if self.teams.get(fantasy_team_id) else [])
                                                                 if owner.get("displayName") or owner.get("firstName") or owner.get("lastName")) or None
                raw_rostered = roster_entry.get("playerPoolEntry", {}).get("player", {})
                grouped = {}
                for stat in raw_rostered.get("stats", []):
                    if stat.get("seasonId") != self.league.year or stat.get("statSplitTypeId") == 2:
                        continue
                    bucket = grouped.setdefault(stat.get("scoringPeriodId"), {})
                    bucket["actual" if stat.get("statSourceId") == 0 else "projected"] = stat
                rank_player["game_log"] = [{"week": period, "fantasy_points": bucket["actual"].get("appliedTotal"),
                                            "projected_fantasy_points": bucket.get("projected", {}).get("appliedTotal"),
                                            "stats": stats_breakdown(bucket["actual"].get("stats", {}))}
                                           for period, bucket in sorted(grouped.items())
                                           if isinstance(period, int) and period > 0 and bucket.get("actual", {}).get("appliedTotal") is not None]
                rank_player["weekly_stats"] = [{"week": game["week"], "fantasy_points": game["fantasy_points"],
                                                "projected_fantasy_points": game["projected_fantasy_points"]}
                                               for game in rank_player["game_log"]]
                rank_player["last_3_games"] = rank_player["game_log"][-3:]
                rank_player["last_5_games"] = rank_player["game_log"][-5:]
                rank_player["game_stats"] = stats_breakdown(grouped.get(week, {}).get("actual", {}).get("stats", {}))
                season_row = grouped.get(0, {}).get("actual", {})
                rank_player["season_fantasy_points"] = season_row.get("appliedTotal")
                rank_player["season_fantasy_average"] = season_row.get("appliedAverage")
                rank_players.append(rank_player)
            from projection_sources.context import enrich_players
            from projection_engine import project_players
            enriched, _source_status = enrich_players(rank_players, self.league.year, week, self)
            rank_projections = project_players(list(enriched.values()), week, self.league.current_week)
            if player_id in enriched:
                result = enriched[player_id]
                result["custom_projection"] = rank_projections[player_id]
            else:
                one, _source_status = enrich_players([result], self.league.year, week, self)
                result = one[player_id]
                result["custom_projection"] = project_players([result], week, self.league.current_week)[player_id]
            result.update(profile_fields)
            if result.get("fantasy_team_id"):
                result["roster_status"] = "rostered"
            elif availability in {"FREEAGENT", "WAIVERS"}:
                result["roster_status"] = "available"
            else:
                result["roster_status"] = "unknown"
            rankings = {}
            rank_metrics = {
                "season_points": lambda p: p.get("season_fantasy_points"),
                "points_per_game": lambda p: p.get("season_fantasy_average"),
                "week_our_projection": lambda p: rank_projections.get(p["player_id"], {}).get("our_projection"),
            }
            ranked_rows = list(enriched.values())
            for key, getter in rank_metrics.items():
                values = [(p, getter(p)) for p in ranked_rows]
                values = [(p, value) for p, value in values if isinstance(value, (int, float))]
                target_value = getter(result)
                if target_value is None:
                    rankings[key] = None
                    continue
                peers = [(p, value) for p, value in values if p.get("position") == result.get("position")]
                rankings[key] = {"overall": 1 + sum(value > target_value for _, value in values),
                                 "position": 1 + sum(value > target_value for _, value in peers),
                                 "scope": "players rostered in this ESPN fantasy league"}
            result["rankings"] = rankings
            result["news"] = [{"headline": _context_headline(event), "source": event.get("source"),
                               "timestamp": event.get("timestamp"), "summary": _context_summary(event),
                               "relevance": event.get("event_type")}
                              for event in result["custom_projection"].get("context_events", [])
                              if event.get("source") and event.get("event_type") in {
                                  "official_injury_report", "weekly_roster_context", "teammate_reported_out",
                                  "opponent_defender_injury_report"}]
            team_id = result.get("nfl_team_id")
            if team_id:
                try:
                    from nfl_service import team_identity
                    identity = team_identity(int(team_id))
                    result["nfl_team_color"] = identity.get("color")
                    result["nfl_team_alternate_color"] = identity.get("alternate_color")
                    result["nfl_team_logo_url"] = identity.get("logo_url") or result.get("nfl_team_logo_url")
                    result["nfl_team_full_name"] = identity.get("name")
                    result["nfl_team_identity_source"] = identity.get("source")
                except APIError:
                    result["nfl_team_color"] = None
                    result["nfl_team_alternate_color"] = None
                    result["nfl_team_full_name"] = None
                    result["nfl_team_identity_source"] = None
            result["last_updated"] = datetime.now(timezone.utc).isoformat()
            return {key: value for key, value in result.items() if not key.startswith("_")}


def _context_headline(event):
    kind = event.get("event_type", "player context").replace("_", " ").capitalize()
    detail = event.get("detail") or {}
    status = detail.get("report_status") or detail.get("practice_status") or detail.get("depth_chart_position")
    return f"{kind}{f': {status}' if status else ''}"


def _context_summary(event):
    detail = event.get("detail") or {}
    if event.get("event_type") == "teammate_reported_out":
        names = [item.get("name") for item in detail.get("out_teammates", []) if item.get("name")]
        return f"The official weekly injury feed lists {', '.join(names)} as out." if names else "The official weekly injury feed reports an unavailable teammate."
    injury = detail.get("primary_injury") or detail.get("secondary_injury")
    if injury:
        return f"Official structured team report: {injury}."
    if detail.get("report_status"):
        return f"Official structured report status: {detail['report_status']}."
    if detail.get("practice_status"):
        return f"Official practice participation: {detail['practice_status']}."
    if detail.get("depth_chart_position"):
        return f"Weekly roster feed depth chart listing: {detail['depth_chart_position']}."
    return "Structured weekly NFL roster or injury context; no article text was used."
