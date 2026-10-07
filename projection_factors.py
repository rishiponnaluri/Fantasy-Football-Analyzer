"""Independent, auditable factors used by :mod:`projection_engine`."""

from __future__ import annotations

import statistics
from collections.abc import Mapping, Sequence


def baseline_adjustment(espn: float, season_mean: float, shrinkage: float, sample_count: int) -> dict:
    delta = (season_mean - espn) * shrinkage
    return {"key": "baseline", "label": "Season baseline", "adjustment": round(delta, 3),
            "evidence": f"{sample_count} prior ESPN-scored games; season mean {season_mean:.2f}.",
            "source": "ESPN fantasy game log"}


def opportunity_adjustment(rows: Sequence[Mapping], position: str | None, recent_rows: Sequence[Mapping], shrinkage: float):
    """Value a real shift in recorded opportunities at historical points/opportunity."""
    keys = {"QB": ("passingAttempts", "rushingAttempts"),
            "RB": ("rushingAttempts", "receivingTargets"),
            "WR": ("receivingTargets", "rushingAttempts"),
            "TE": ("receivingTargets", "rushingAttempts")}.get(position or "")
    if not keys:
        return None

    def rate(row):
        stats = row.get("stats") or {}
        values = [stats.get(key) for key in keys]
        if not any(isinstance(value, (int, float)) for value in values):
            return None
        return sum(value if isinstance(value, (int, float)) else 0.0 for value in values)

    usable = [(float(row["fantasy_points"]), rate(row)) for row in rows]
    usable = [(points, opportunities) for points, opportunities in usable if opportunities is not None]
    recent = [value for value in (rate(row) for row in recent_rows) if value is not None]
    prior = [value for value in (rate(row) for row in rows) if value is not None]
    total = sum(value for _, value in usable)
    if len(usable) < 2 or total <= 0 or not recent or not prior:
        return None
    points_per_opportunity = sum(points for points, _ in usable) / total
    season_rate = statistics.fmean(prior)
    recent_rate = statistics.fmean(recent)
    delta = (recent_rate - season_rate) * points_per_opportunity * shrinkage
    return {"key": "opportunity", "label": "Recent usage", "adjustment": round(delta, 3),
            "evidence": (f"Opportunity rate {season_rate:.2f} to {recent_rate:.2f} per game; "
                         f"{points_per_opportunity:.3f} fantasy points per recorded opportunity."),
            "source": "ESPN weekly player statistics"}


def recent_form_adjustment(recent_mean: float, season_mean: float, shrinkage: float,
                           opportunity_delta: float, recent_count: int) -> dict:
    delta = (recent_mean - season_mean) * shrinkage - opportunity_delta
    return {"key": "recent_form", "label": "Recent form", "adjustment": round(delta, 3),
            "evidence": f"Last {recent_count} prior games average {recent_mean:.2f}; season mean {season_mean:.2f}.",
            "source": "ESPN fantasy game log"}


def injury_status_adjustment(status: str, current_mean: float | None):
    status = status.upper()
    event = None
    factor = None
    if status and status not in {"ACTIVE", "NORMAL"}:
        event = {"kind": "espn_player_status", "status": status, "source": "ESPN structured player status",
                 "projection_effect": "No numerical workload change supplied by ESPN."}
    if status == "OUT" and current_mean is not None:
        factor = {"key": "injury", "label": "Injury status", "adjustment": round(-current_mean, 3),
                  "evidence": "ESPN structured status is OUT; expected fantasy points set to zero.",
                  "source": "ESPN structured player status"}
    return event, factor


def unavailable_context_factors(player: Mapping) -> list[dict]:
    unavailable = []
    if player.get("nfl_opponent"):
        unavailable.append({"key": "matchup", "label": "Opponent matchup", "reason": "Opponent is known, but ESPN does not provide a reliable position-specific defensive adjustment."})
    if player.get("nfl_game_time"):
        unavailable.append({"key": "game_environment", "label": "Game environment", "reason": "Kickoff is known; verified pace, spread, total, and weather data are unavailable from the configured source."})
    status = (player.get("injury_status") or "").upper()
    if status in {"QUESTIONABLE", "DOUBTFUL", "PROBABLE", "LIMITED"}:
        unavailable.append({"key": "injury", "label": "Injury workload", "reason": "ESPN supplies a status label but no structured expected snap/workload reduction."})
    return unavailable
