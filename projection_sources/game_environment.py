"""Real nflverse team environment and optional sportsbook-market context."""

from __future__ import annotations

def _n(value):
    try:
        return float(value) if value not in (None, "") else None
    except (ValueError, TypeError):
        return None


def team_context(team: str | None, opponent: str | None, week: int,
                 team_rows: list[dict], schedule_rows: list[dict]) -> dict:
    prior = [row for row in team_rows if row.get("team") == team
             and row.get("season_type") == "REG" and row.get("week", "").isdigit()
             and 0 < int(row["week"]) < week]
    if prior:
        recent = sorted(prior, key=lambda row: int(row["week"]))[-3:]
        def mean(rows, key):
            values = [_n(row.get(key)) for row in rows]
            values = [value for value in values if value is not None]
            return sum(values) / len(values) if values else None
        attempts, carries = mean(recent, "attempts"), mean(recent, "carries")
        opponent_recent = sorted([row for row in team_rows if row.get("team") == opponent
                                  and row.get("season_type") == "REG" and row.get("week", "").isdigit()
                                  and 0 < int(row["week"]) < week],
                                 key=lambda row: int(row["week"]))[-3:]
        actual_scores = []
        for stats_row in recent:
            game = next((item for item in schedule_rows if item.get("game_id") == stats_row.get("game_id")), None)
            if game:
                score_key = "home_score" if game.get("home_team") == team else "away_score"
                score_value = _n(game.get(score_key))
                if score_value is not None:
                    actual_scores.append(score_value)
        points = sum(actual_scores) / len(actual_scores) if actual_scores else None
        play_counts = [(_n(row.get("attempts")) or 0) + (_n(row.get("carries")) or 0) + (_n(row.get("sacks_suffered")) or 0) for row in recent]
        total_opps = (attempts or 0) + (carries or 0)
        own_plays = sum(play_counts) / len(play_counts)
        opponent_plays = [(_n(row.get("attempts")) or 0) + (_n(row.get("carries")) or 0) + (_n(row.get("sacks_suffered")) or 0)
                          for row in opponent_recent]
        result = {"sample_games": len(recent),
                  "offensive_plays_proxy_per_game": round(own_plays, 2),
                  "opponent_offensive_plays_proxy_per_game": round(sum(opponent_plays) / len(opponent_plays), 2) if opponent_plays else None,
                  "expected_game_plays_proxy": round(own_plays + sum(opponent_plays) / len(opponent_plays), 2) if opponent_plays else None,
                  "pass_rate": round(attempts / total_opps, 4) if attempts is not None and total_opps else None,
                  "rush_rate": round(carries / total_opps, 4) if carries is not None and total_opps else None,
                  "recent_scoring_average": round(points, 2) if points is not None else None,
                  "source": "nflverse team weekly box scores",
                  "note": "plays proxy = pass attempts + carries + sacks; excludes kneels/penalties and is not official play count"}
    else:
        result = {"sample_games": 0, "available": False}

    # nflverse spread_line is the home team's expected margin (negative means
    # home favored); the formula produces market-implied team points.
    game = next((row for row in schedule_rows if row.get("game_type") == "REG"
                 and row.get("away_team") and row.get("home_team")
                 and {row.get("away_team"), row.get("home_team")} == {team, opponent}
                 and row.get("week") == str(week)), None)
    if game:
        total, spread = _n(game.get("total_line")), _n(game.get("spread_line"))
        home = game.get("home_team")
        result["market"] = {"game_total": total, "home_spread_line": spread,
                            "implied_team_total": ((total - spread) / 2 if team == home and total is not None and spread is not None
                                                   else (total + spread) / 2 if team != home and total is not None and spread is not None else None),
                            "source": "nflverse schedule market fields", "available": total is not None and spread is not None}
        result["game"] = {"away_team": game.get("away_team"), "home_team": game.get("home_team"),
                          "stadium": game.get("stadium"), "roof": game.get("roof"),
                          "temperature_f": _n(game.get("temp")), "wind_mph": _n(game.get("wind")),
                          "gameday": game.get("gameday"), "kickoff_time_local": game.get("gametime")}
    else:
        result["market"] = {"available": False, "reason": "No matching nflverse game/market record."}
    return result
