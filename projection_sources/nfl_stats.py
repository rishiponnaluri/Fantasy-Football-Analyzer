"""Real nflverse feeds shared by modular projection-source adapters."""

from __future__ import annotations

from projection_sources.cache import cached

from projection_sources.cache import nflverse_csv


TEAM_ALIASES = {"LAR": "LA", "WSH": "WAS", "JAX": "JAC"}


def nflverse_team(abbreviation: str | None) -> str | None:
    return TEAM_ALIASES.get(abbreviation, abbreviation) if abbreviation else None


def season_data(year: int) -> dict:
    value, _ = cached(f'nflverse:season-join:{year}', 1800,
                      lambda: (_season_data(year), {'available': True}))
    return value


def _season_data(year: int) -> dict:
    """Build shared lookup maps once; source row freshness remains adapter-owned."""
    requests = {
        "player_stats": ("stats_player", f"stats_player_week_{year}.csv.gz"),
        "team_stats": ("stats_team", f"stats_team_week_{year}.csv.gz"),
        "snap_counts": ("snap_counts", f"snap_counts_{year}.csv.gz"),
        "injuries": ("injuries", f"injuries_{year}.csv.gz"),
        "weekly_rosters": ("weekly_rosters", f"roster_weekly_{year}.csv.gz"),
        "schedule": ("schedules", "games.csv.gz"),
        "players": ("players", "players.csv.gz"),
    }
    data, sources = {}, {}
    for key, (asset, filename) in requests.items():
        rows, metadata = nflverse_csv(asset, filename)
        data[key] = rows or []
        sources[key] = metadata
    # Keep historical schedules only for this league's season in projections.
    data["schedule"] = [row for row in data["schedule"] if row.get("season") == str(year)]
    data["player_map"] = {row["espn_id"]: row for row in data["players"] if row.get("espn_id") and row.get("gsis_id")}
    data["gsis_map"] = {row["gsis_id"]: row for row in data["players"] if row.get("gsis_id")}
    data["sources"] = sources
    return data
