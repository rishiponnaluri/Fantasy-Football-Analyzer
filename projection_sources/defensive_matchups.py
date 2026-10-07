"""Opponent performance allowed calculated in the active ESPN league scoring."""

from __future__ import annotations

from collections import defaultdict


# nflverse names for ESPN's common offensive stat IDs. Unknown/custom scoring
# categories are omitted instead of approximated with PPR fantasy points.
STAT_COLUMNS = {
    3: "passing_yards", 4: "passing_tds", 19: "passing_2pt_conversions",
    20: "passing_interceptions", 24: "rushing_yards", 25: "rushing_tds",
    26: "rushing_2pt_conversions", 42: "receiving_yards", 43: "receiving_tds",
    44: "receiving_2pt_conversions", 53: "receptions", 63: "fumble_recovery_tds",
    72: "fumbles_lost_total",
}
POSITION_GROUPS = {"QB": {"QB"}, "RB": {"RB", "FB"},
                   "WR": {"WR"}, "TE": {"TE"}}


def _num(value):
    try:
        return float(value) if value not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def score_row(row: dict, scoring_format: list[dict], position: str) -> float | None:
    applicable = POSITION_GROUPS.get(position)
    if not applicable or row.get("position") not in applicable:
        return None
    scores = []
    for item in scoring_format:
        stat_id = item.get("stat_id")
        column = STAT_COLUMNS.get(stat_id)
        points = item.get("points")
        if column and isinstance(points, (int, float)):
            scores.append(_num(row.get(column)) * points)
    return sum(scores) if scores else None


def _average_map(by_game: dict[str, dict[str, float]]) -> dict[str, float | None]:
    keys = {key for values in by_game.values() for key in values}
    return {key: round(sum(values.get(key, 0.0) for values in by_game.values()) / len(by_game), 3)
            for key in keys} if by_game else {}


def points_allowed_context(rows: list[dict], opponent: str, position: str, week: int,
                           scoring_format: list[dict], team_rows: list[dict] | None = None) -> dict | None:
    prior = [row for row in rows if row.get("season_type") == "REG"
             and row.get("opponent_team") == opponent
             and row.get("position_group") in POSITION_GROUPS.get(position, set())
             and row.get("week", "").isdigit() and int(row["week"]) < week]
    if not prior:
        return None
    by_defense: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    game_scores: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for row in rows:
        if row.get("season_type") != "REG" or row.get("position_group") not in POSITION_GROUPS.get(position, set()):
            continue
        if not row.get("team") or not row.get("opponent_team") or not row.get("week", "").isdigit() or int(row["week"]) >= week:
            continue
        points = score_row(row, scoring_format, position)
        if points is None:
            continue
        game_id = row.get("game_id") or f"{row['opponent_team']}:{row.get('week')}:{row.get('team')}"
        by_defense[row["opponent_team"]][game_id] += points
        game_scores[game_id][row["opponent_team"]] = game_scores[game_id].get(row["opponent_team"], 0.0) + points
    def_avg = (sum(sum(values.values()) for values in by_defense.values()) /
               sum(len(values) for values in by_defense.values())) if by_defense else None
    defended = list(by_defense.get(opponent, {}).values())
    if not defended or def_avg is None or def_avg == 0:
        return None
    value = sum(defended) / len(defended)
    percent = value / def_avg - 1.0
    position_games: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    all_position_games: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    position_columns = {"targets_allowed": "targets", "receptions_allowed": "receptions",
                        "receiving_yards_allowed": "receiving_yards", "receiving_tds_allowed": "receiving_tds",
                        "carries_allowed": "carries", "rushing_yards_allowed": "rushing_yards",
                        "rushing_tds_allowed": "rushing_tds", "passing_yards_allowed": "passing_yards",
                        "passing_tds_allowed": "passing_tds", "attempts_allowed": "attempts"}
    for row in rows:
        if row.get("position_group") not in POSITION_GROUPS.get(position, set()) or row.get("season_type") != "REG":
            continue
        if not row.get("opponent_team") or not row.get("game_id") or not row.get("week", "").isdigit() or int(row["week"]) >= week:
            continue
        bucket = all_position_games[row["opponent_team"]].setdefault(row["game_id"], defaultdict(float))
        if row["opponent_team"] == opponent:
            selected = position_games.setdefault(row["game_id"], defaultdict(float))
        else:
            selected = None
        for key, column in position_columns.items():
            raw = row.get(column)
            if raw in (None, ""):
                continue
            amount = _num(raw)
            bucket[key] += amount
            if selected is not None:
                selected[key] += amount
    position_allowed = _average_map(position_games)
    league_position_allowed = {}
    all_position_values = defaultdict(list)
    for games in all_position_games.values():
        for totals in games.values():
            for key, amount in totals.items():
                all_position_values[key].append(amount)
    league_position_allowed = {key: round(sum(values) / len(values), 3)
                               for key, values in all_position_values.items() if values}

    defense = {}
    if team_rows:
        offense_allowed: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        defense_production: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for row in team_rows:
            row_week = row.get("week", "")
            if row.get("season_type") != "REG" or not row_week.isdigit() or int(row_week) >= week or not row.get("game_id"):
                continue
            if row.get("opponent_team") == opponent:
                bucket = offense_allowed[row["game_id"]]
                for key in ("passing_yards", "passing_tds", "attempts", "sacks_suffered",
                            "rushing_yards", "rushing_tds", "carries"):
                    bucket[key] += _num(row.get(key))
            if row.get("team") == opponent:
                bucket = defense_production[row["game_id"]]
                for key in ("def_sacks", "def_qb_hits"):
                    bucket[key] += _num(row.get(key))
        allowed_metrics = _average_map(offense_allowed)
        defensive_pressure = _average_map(defense_production)
        attempts = sum(values.get("attempts", 0.0) for values in offense_allowed.values())
        pass_yards = sum(values.get("passing_yards", 0.0) for values in offense_allowed.values())
        carries = sum(values.get("carries", 0.0) for values in offense_allowed.values())
        rush_yards = sum(values.get("rushing_yards", 0.0) for values in offense_allowed.values())
        defense = {"games_sampled": len(offense_allowed),
                   "passing_yards_allowed_per_game": allowed_metrics.get("passing_yards"),
                   "passing_tds_allowed_per_game": allowed_metrics.get("passing_tds"),
                   "yards_per_attempt_allowed": round(pass_yards / attempts, 3) if attempts else None,
                   "sacks_by_opponent_per_game": allowed_metrics.get("sacks_suffered"),
                   "defensive_sacks_per_game": defensive_pressure.get("def_sacks"),
                   "defensive_qb_hits_per_game": defensive_pressure.get("def_qb_hits"),
                   "rushing_yards_allowed_per_game": allowed_metrics.get("rushing_yards"),
                   "rushing_tds_allowed_per_game": allowed_metrics.get("rushing_tds"),
                   "yards_per_carry_allowed": round(rush_yards / carries, 3) if carries else None}
    return {"opponent": opponent, "position": position,
            "points_allowed_per_game": round(value, 3),
            "league_average_allowed_per_game": round(def_avg, 3),
            "percent_vs_league_average": round(percent, 4),
            "games_sampled": len(defended),
            "position_usage_allowed_per_game": position_allowed,
            "league_average_position_usage_allowed_per_game": league_position_allowed,
            "pass_rush_defense": defense,
            "scoring_basis": "active ESPN league scoring categories supported by nflverse box-score fields"}


def adjustment(projection: float, context: dict, scoring_source: str) -> dict:
    delta = projection * context["percent_vs_league_average"]
    return {"key": "matchup", "label": "Opponent matchup", "adjustment": round(delta, 3),
            "evidence": (f"{context['opponent']} allowed {context['points_allowed_per_game']:.2f} "
                         f"{context['position']} fantasy points per game versus a league average "
                         f"of {context['league_average_allowed_per_game']:.2f} over "
                         f"{context['games_sampled']} prior games "
                         f"({context['percent_vs_league_average']:+.1%}); scaled the projection by "
                         "that observed relative difference."),
            "source": f"nflverse weekly player box scores; {scoring_source}"}
