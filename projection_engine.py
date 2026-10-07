"""Deterministic, evidence-based player projections from real ESPN data.

The engine keeps the weekly ESPN projection as its prior. It updates that prior
with earlier fantasy results using an empirical-Bayes shrinkage weight derived
from the player's observed variance and the real positional variance in the
league. A workload signal decomposes part of the recent-form adjustment when
ESPN supplies the relevant box-score opportunities. It never fills missing
inputs with league averages invented by the application.

Outcome ranges use a normal approximation around the projection and the
player's observed game-to-game standard deviation (or the median observed
within-player standard deviation at that position when personal history is too
short). The range is descriptive, not a guarantee of a normal NFL outcome.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Mapping, Sequence

from projection_factors import (baseline_adjustment, injury_status_adjustment,
                                 opportunity_adjustment, recent_form_adjustment,
                                 unavailable_context_factors)
from projection_sources.defensive_matchups import adjustment as data_matchup_adjustment
from projection_sources.injuries import injury_adjustment as sourced_injury_adjustment


NORMAL_10_90 = 1.2815515655446004


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _history(player: Mapping, week: int, history_cutoff_week: int | None = None) -> list[dict]:
    # A future selected week must not treat the current scoring period's live
    # partial box score as a completed historical sample.
    cutoff = min(week, history_cutoff_week) if history_cutoff_week is not None else week
    rows = []
    for row in player.get("game_log") or []:
        row_week = row.get("week")
        points = _number(row.get("fantasy_points"))
        if isinstance(row_week, int) and row_week < cutoff and points is not None:
            rows.append({**row, "fantasy_points": float(points)})
    return sorted(rows, key=lambda row: row["week"])


def _position_variances(players: Sequence[Mapping], week: int, history_cutoff_week: int | None = None) -> dict[str, float]:
    by_position: dict[str, list[float]] = {}
    for player in players:
        rows = _history(player, week, history_cutoff_week)
        points = [row["fantasy_points"] for row in rows]
        position = player.get("position")
        if position and len(points) >= 2:
            by_position.setdefault(position, []).append(statistics.variance(points))
    return {position: statistics.median(values) for position, values in by_position.items() if values}


def _confidence_measurements(player: Mapping, outcomes: list[float], raw_mean, espn, season_mean,
                            recent3, recent5, variance_source: str | None) -> dict:
    """Score evidence quality across five measurable areas.

    Each component is 0–100 and has an explicit evidence rule. History, role
    stability, and agreement each receive 25% because they directly describe
    repeatability and estimate support. Status receives 15%; matchup coverage
    receives 10% because it is useful context but is not required to estimate
    a player's own baseline production.
    This is a data-quality score, not a probability that the point estimate is
    correct.
    """
    # History reaches full credit at five completed games. Personal variance is
    # stronger evidence than a same-position estimate, which is stronger than
    # having no measurable variance.
    variance_quality = {"player_history": 1.0, "league_position_history": 0.7}.get(variance_source, 0.35)
    history_score = 100.0 * min(1.0, len(outcomes) / 5.0) * (0.7 + 0.3 * variance_quality)

    context = player.get("_projection_context") or {}
    role = context.get("role_trend") or {}
    role_score = None
    recent_snap = _number(role.get("recent_snap_share"))
    prior_snap = _number(role.get("season_snap_share"))
    recent_opps = _number(role.get("recent_opportunities_per_game"))
    earlier_opps = _number(role.get("earlier_opportunities_per_game"))
    role_samples = _number(role.get("sample_games"))
    if recent_snap is not None and prior_snap is not None and role_samples:
        snap_change = min(1.0, abs(recent_snap - prior_snap) / 0.20)
        usage_change = (min(1.0, abs(recent_opps / earlier_opps - 1.0) / 0.75)
                        if recent_opps is not None and earlier_opps not in (None, 0) else 0.5)
        instability = 0.7 * snap_change + 0.3 * usage_change
        coverage = min(1.0, role_samples / 4.0)
        role_score = 40.0 + 60.0 * coverage * (1.0 - instability)
    elif player.get("position") in {"K", "D/ST"}:
        # Snap/target trends are not appropriate evidence for kickers or team defenses.
        role_score = 60.0 if len(outcomes) >= 3 else 40.0
    else:
        # Use real weekly opportunities when nflverse's paired snap feed is absent.
        position = player.get("position")
        keys = {"QB": ("passingAttempts", "rushingAttempts"),
                "RB": ("rushingAttempts", "receivingTargets"),
                "WR": ("receivingTargets", "rushingAttempts"),
                "TE": ("receivingTargets", "rushingAttempts")}.get(position, ())
        weekly = []
        for row in (player.get("game_log") or []):
            stats = row.get("stats") or {}
            values = [_number(stats.get(key)) for key in keys]
            if any(value is not None for value in values):
                weekly.append(sum(value or 0.0 for value in values))
        if len(weekly) >= 3:
            mean_usage = statistics.fmean(weekly)
            cv = statistics.pstdev(weekly) / mean_usage if mean_usage > 0 else 1.0
            role_score = max(0.0, 100.0 * (1.0 - min(1.0, cv)))
        else:
            role_score = 35.0
    if role.get("role_direction") in {"increasing", "decreasing"}:
        role_score = max(0.0, role_score - 15.0)
    for event in player.get("_external_context_events") or []:
        event_type = str(event.get("event_type") or "").casefold()
        if any(term in event_type for term in ("snap_limit", "workload_reduction", "role_change", "return_from_injury")):
            role_score = min(role_score, 40.0)
            break

    # Compare available independent signals on the same points scale.
    references = [value for value in (raw_mean, espn, season_mean, recent3, recent5)
                  if _number(value) is not None]
    if len(references) >= 2:
        spread = max(references) - min(references)
        scale = max(6.0, abs(statistics.median(references)) * 0.60)
        agreement_score = max(0.0, 100.0 * (1.0 - min(1.0, spread / scale)))
        if len(references) < 4:
            agreement_score *= 0.8
    else:
        agreement_score = 30.0

    status = str(player.get("injury_status") or "").upper().replace(" ", "_")
    if status in {"ACTIVE", "NORMAL", "HEALTHY", "PROBABLE", "AVAILABLE"}:
        status_score = 100.0
    elif status in {"QUESTIONABLE", "DTD", "LIMITED", "DOUBTFUL", "OUT", "INJURED_RESERVE", "SUSPENDED"}:
        status_score = {"QUESTIONABLE": 40.0, "DTD": 45.0, "LIMITED": 45.0,
                        "DOUBTFUL": 20.0, "OUT": 90.0, "INJURED_RESERVE": 90.0,
                        "SUSPENDED": 90.0}.get(status, 50.0)
    else:
        status_score = 55.0
    for event in player.get("_external_context_events") or []:
        event_type = str(event.get("event_type") or "").casefold()
        if any(term in event_type for term in ("snap_limit", "workload_reduction", "return_from_injury")):
            status_score = min(status_score, 35.0)

    opponent = player.get("nfl_opponent")
    matchup_context = context.get("defensive_matchup") or {}
    team_context = context.get("team_and_game_environment") or {}
    if player.get("position") in {"K", "D/ST"}:
        matchup_score = (50.0 if opponent else 0.0) + (50.0 if team_context.get("available") is not False and team_context else 0.0)
    else:
        matchup_score = (30.0 if opponent else 0.0) + (40.0 if matchup_context.get("available") is not False and matchup_context else 0.0)
        matchup_score += 30.0 if team_context.get("available") is not False and team_context else 0.0

    components = {
        "history": round(history_score),
        "role_stability": round(role_score),
        "source_agreement": round(agreement_score),
        "status_certainty": round(status_score),
        "matchup_information": round(matchup_score),
    }
    weights = {"history": 0.25, "role_stability": 0.25, "source_agreement": 0.25,
               "status_certainty": 0.15, "matchup_information": 0.10}
    score = round(sum(components[key] * weight for key, weight in weights.items()))
    reasons = []
    if components["history"] < 55:
        reasons.append(f"There are only {len(outcomes)} recent completed game(s) to judge this player's scoring.")
    elif components["history"] >= 80:
        reasons.append("There are enough recent games to judge his scoring trend.")
    if components["role_stability"] < 55:
        reasons.append("This player's workload has changed recently or is hard to measure.")
    elif components["role_stability"] >= 80:
        reasons.append("This player's recent workload has been steady.")
    if components["source_agreement"] < 55:
        reasons.append("ESPN, recent scoring, and our estimate do not fully agree.")
    elif components["source_agreement"] >= 80:
        reasons.append("Our estimate is close to ESPN and recent scoring.")
    if components["status_certainty"] < 55:
        reasons.append("This player's health or expected workload is uncertain.")
    elif components["status_certainty"] >= 80:
        reasons.append("No major playing-status concern is reported.")
    if components["matchup_information"] < 55:
        reasons.append("We have limited information about this week's opponent.")
    elif components["matchup_information"] >= 80:
        reasons.append("We have useful information about this week's opponent.")
    # A high weighted average must not hide a major projection disagreement,
    # an unstable role, or uncertain availability. These are direct conflicts
    # about expected points, so they cap the label at Medium.
    high_confidence_eligible = all(components[key] >= 55 for key in (
        "history", "role_stability", "source_agreement", "status_certainty"))
    return {"score": score, "components": components, "reasons": reasons[:4],
            "high_confidence_eligible": high_confidence_eligible}


def project_player(player: Mapping, week: int, position_variance: float | None = None,
                   history_cutoff_week: int | None = None) -> dict:
    """Return a projection built only from fields supplied by ESPN/adapter."""
    espn = _number(player.get("projected_fantasy_points"))
    rows = _history(player, week, history_cutoff_week)
    outcomes = [row["fantasy_points"] for row in rows]
    season_mean = statistics.fmean(outcomes) if outcomes else None
    recent3_rows = rows[-3:]
    recent5_rows = rows[-5:]
    recent3 = statistics.fmean(row["fantasy_points"] for row in recent3_rows) if recent3_rows else None
    recent5 = statistics.fmean(row["fantasy_points"] for row in recent5_rows) if recent5_rows else None
    player_variance = statistics.variance(outcomes) if len(outcomes) >= 2 else None
    prior_variance = _number(position_variance)
    if prior_variance is None or prior_variance <= 0:
        prior_variance = player_variance

    # Bayesian shrinkage: the real scoring history mean has variance s²/n,
    # while the ESPN prior's variance is the observed league positional
    # variance. With no measurable variance, there is no data-backed weight.
    evidence_mean = recent3 if recent3 is not None else season_mean
    evidence_count = len(recent3_rows) if recent3 is not None else len(outcomes)
    shrink = 0.0
    if evidence_mean is not None and espn is not None and prior_variance is not None and prior_variance > 0:
        evidence_variance = player_variance if player_variance is not None else prior_variance
        mean_variance = evidence_variance / max(1, evidence_count)
        shrink = prior_variance / (prior_variance + mean_variance) if mean_variance >= 0 else 0.0

    base = espn if espn is not None else season_mean
    factors: list[dict] = []
    if base is not None:
        if espn is not None and season_mean is not None and shrink > 0:
            factors.append(baseline_adjustment(espn, season_mean, shrink, len(outcomes)))
            opportunity = opportunity_adjustment(rows, player.get("position"), recent3_rows, shrink)
            opportunity_delta = opportunity["adjustment"] if opportunity else 0.0
            if opportunity:
                factors.append(opportunity)
            if recent3 is not None:
                factors.append(recent_form_adjustment(recent3, season_mean, shrink,
                                                      opportunity_delta, len(recent3_rows)))
        for factor in player.get("_external_projection_factors") or []:
            factors.append(factor)
        final_mean = base + sum(item["adjustment"] for item in factors)
    else:
        final_mean = None

    injury = (player.get("injury_status") or "").upper()
    event, injury_factor = injury_status_adjustment(injury, final_mean)
    events = [event] if event else []
    events.extend(player.get("_external_context_events") or [])
    external_injury = sourced_injury_adjustment(player.get("_external_context_events") or [], final_mean)
    # A real official OUT report supersedes an ESPN status factor rather than
    # double-counting it.
    if external_injury:
        if injury_factor:
            factors = [item for item in factors if item.get("key") != "injury"]
        injury_factor = external_injury
    if injury_factor:
        factors.append(injury_factor)
        final_mean = 0.0

    stddev = math.sqrt(max(0.0, player_variance)) if player_variance is not None else None
    variance_source = "player_history" if stddev is not None else None
    if stddev is None and prior_variance is not None:
        stddev = math.sqrt(max(0.0, prior_variance))
        variance_source = "league_position_history"
    if final_mean is None or stddev is None:
        median = floor = ceiling = None
    else:
        median = final_mean
        floor = final_mean - NORMAL_10_90 * stddev
        ceiling = final_mean + NORMAL_10_90 * stddev

    precision = shrink if evidence_mean is not None and espn is not None else 0.0
    confidence_evidence = _confidence_measurements(
        player, outcomes, final_mean, espn, season_mean, recent3, recent5, variance_source)
    confidence_score = confidence_evidence["score"]
    confidence = ("high" if confidence_score >= 80 and confidence_evidence["high_confidence_eligible"]
                  else "medium" if confidence_score >= 55 else "low")

    unavailable = unavailable_context_factors(player)
    evidence_context = player.get("_projection_context") or {}
    if evidence_context.get("defensive_matchup", {}).get("available") is not False and any(f.get("key") == "matchup" for f in factors):
        unavailable = [item for item in unavailable if item.get("key") != "matchup"]
    if evidence_context.get("team_and_game_environment", {}).get("market", {}).get("available"):
        unavailable = [item for item in unavailable if item.get("key") != "game_environment"]

    model_description = (
        "ESPN weekly projection updated by empirical-Bayes shrinkage from earlier ESPN game logs; "
        "normal-approximation 10th–90th outcome range."
        if espn is not None else
        "ESPN weekly projection unavailable; real prior ESPN game-log mean used where available; "
        "normal-approximation 10th–90th outcome range."
    )
    return {
        "week": week,
        "espn_projection": espn,
        "our_projection": round(final_mean, 3) if final_mean is not None else None,
        "mean": round(final_mean, 3) if final_mean is not None else None,
        "median": round(median, 3) if median is not None else None,
        "floor": round(floor, 3) if floor is not None else None,
        "ceiling": round(ceiling, 3) if ceiling is not None else None,
        "standard_deviation": round(stddev, 3) if stddev is not None else None,
        "variance_source": variance_source,
        "confidence": confidence,
        "confidence_basis": {"prior_games": len(outcomes), "shrinkage_from_observed_variance": round(precision, 4),
                             **confidence_evidence},
        "adjustments": factors,
        "context_events": events,
        "projection_context": evidence_context,
        "source_status": player.get("_projection_source_status"),
        "unavailable_factors": unavailable,
        "recent_3_game_average": round(recent3, 3) if recent3 is not None else None,
        "recent_5_game_average": round(recent5, 3) if recent5 is not None else None,
        "historical_variance": round(player_variance, 3) if player_variance is not None else None,
        "model": model_description,
    }


def project_players(players: Sequence[Mapping], week: int,
                    history_cutoff_week: int | None = None) -> dict[int, dict]:
    positional_variances = _position_variances(players, week, history_cutoff_week)
    output = {}
    for player in players:
        position = player.get("position")
        output[player["player_id"]] = project_player(player, week, positional_variances.get(position), history_cutoff_week)
    return output
