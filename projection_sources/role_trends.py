"""Snap-share role trends valued at the player's observed fantasy points/snap."""

from __future__ import annotations

import statistics

from projection_sources.defensive_matchups import score_row


def _f(value):
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _opportunities(row: dict, position: str):
    if position == "QB":
        keys = ("attempts", "carries")
    elif position == "RB":
        keys = ("carries", "targets")
    elif position in {"WR", "TE"}:
        keys = ("targets", "carries")
    else:
        return None
    values = [_f(row.get(key)) for key in keys]
    return sum(value for value in values if value is not None) if any(value is not None for value in values) else None


def role_context(player: dict, player_id: str | None, stat_rows: list[dict], snap_rows: list[dict], week: int,
                 scoring_format: list[dict]) -> dict | None:
    if not player_id:
        return None
    stats = {int(row["week"]): row for row in stat_rows
             if row.get("player_id") == player_id and row.get("week", "").isdigit()
             and 0 < int(row["week"]) < week and row.get("season_type") == "REG"}
    pfr = player.get("_pfr_player_id")
    snaps = {int(row["week"]): row for row in snap_rows
             if pfr and row.get("pfr_player_id") == pfr and row.get("week", "").isdigit()
             and 0 < int(row["week"]) < week}
    weeks = sorted(set(stats) & set(snaps))
    if len(weeks) < 2:
        return None
    latest = weeks[-2:]
    earlier = weeks[:-2]
    if not earlier:
        return {"weeks": weeks, "recent_snap_share": statistics.fmean(_f(snaps[w].get("offense_pct")) or 0 for w in latest),
                "season_snap_share": None, "fantasy_points_per_snap": None, "snaps_per_game": None,
                "role_direction": "insufficient_comparison"}
    snap_share = {w: _f(snaps[w].get("offense_pct")) for w in weeks}
    real_points = {w: score_row(stats[w], scoring_format, player.get("position")) for w in weeks}
    offense_snaps = {w: _f(snaps[w].get("offense_snaps")) for w in weeks}
    usable = [w for w in weeks if real_points[w] is not None and offense_snaps[w] and offense_snaps[w] > 0]
    if len(usable) < 2:
        return None
    recent_share = statistics.fmean(snap_share[w] for w in latest if snap_share[w] is not None)
    prior_share = statistics.fmean(snap_share[w] for w in earlier if snap_share[w] is not None)
    points_per_snap = sum(real_points[w] for w in usable) / sum(offense_snaps[w] for w in usable)
    snap_mean = statistics.fmean(offense_snaps[w] for w in latest if offense_snaps[w] is not None)
    opportunities = {w: _opportunities(stats[w], player.get("position")) for w in weeks}
    scored = real_points
    usage_weeks = [w for w in weeks if opportunities[w] is not None and scored[w] is not None]
    recent_usage = [opportunities[w] for w in latest if opportunities[w] is not None]
    earlier_usage = [opportunities[w] for w in earlier if opportunities[w] is not None]
    target_share = {w: _f(stats[w].get("target_share")) for w in weeks}
    recent_target_shares = [target_share[w] for w in latest if target_share[w] is not None]
    earlier_target_shares = [target_share[w] for w in earlier if target_share[w] is not None]
    points_per_opportunity = (sum(scored[w] for w in usage_weeks) / sum(opportunities[w] for w in usage_weeks)
                              if len(usage_weeks) >= 2 and sum(opportunities[w] for w in usage_weeks) > 0 else None)
    return {"weeks": weeks, "recent_snap_share": recent_share, "season_snap_share": prior_share,
            "fantasy_points_per_snap": points_per_snap, "snaps_per_game": snap_mean,
            "role_direction": "increasing" if recent_share > prior_share else "decreasing" if recent_share < prior_share else "stable",
            "sample_games": len(usable),
            "recent_opportunities_per_game": statistics.fmean(recent_usage) if recent_usage else None,
            "earlier_opportunities_per_game": statistics.fmean(earlier_usage) if earlier_usage else None,
            "recent_target_share": statistics.fmean(recent_target_shares) if recent_target_shares else None,
            "earlier_target_share": statistics.fmean(earlier_target_shares) if earlier_target_shares else None,
            "opportunity_sample_games": len(usage_weeks),
            "fantasy_points_per_opportunity": points_per_opportunity}


def adjustment(context: dict) -> dict | None:
    recent = context.get("recent_snap_share")
    prior = context.get("season_snap_share")
    points_per_snap = context.get("fantasy_points_per_snap")
    snaps = context.get("snaps_per_game")
    if None in (recent, prior, points_per_snap, snaps):
        return None
    delta = (recent - prior) * snaps * points_per_snap
    return {"key": "role_trend", "label": "Recent role trend", "adjustment": round(delta, 3),
            "evidence": (f"Offensive snap share changed from {prior:.1%} to {recent:.1%} in the latest "
                         f"two weeks; {context['sample_games']} observed games at "
                         f"{points_per_snap:.3f} fantasy points per snap."),
            "source": "nflverse Pro Football Reference snap counts and weekly player box scores"}


def usage_adjustment(context: dict) -> dict | None:
    recent = context.get("recent_opportunities_per_game")
    earlier = context.get("earlier_opportunities_per_game")
    value = context.get("fantasy_points_per_opportunity")
    if None in (recent, earlier, value) or context.get("opportunity_sample_games", 0) < 3:
        return None
    delta = (recent - earlier) * value
    return {"key": "nflverse_opportunity", "label": "Opportunity trend", "adjustment": round(delta, 3),
            "evidence": (f"Recorded position opportunities averaged {earlier:.2f} per earlier game and "
                         f"{recent:.2f} over the latest two; observed {value:.3f} fantasy points per "
                         f"opportunity across {context['opportunity_sample_games']} games."),
            "source": "nflverse weekly player box scores with active ESPN league scoring settings"}
