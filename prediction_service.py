"""Vectorized Monte Carlo estimates for ESPN fantasy-team matchups.

The custom projection engine supplies each player's center, uncertainty,
history, and evidence-backed adjustments. NFL schedule data is used only for
real player game state and shared NFL game grouping; fantasy matchups remain
separate throughout this module.

Outcome sampling bootstraps a player's own centered historical residuals when
there are at least five observations. Smaller samples use a heavier-tailed
Student-t distribution scaled to the custom model's reported uncertainty. A
player with no personal history inherits only the engine's real league
positional variance, with a documented 25% uncertainty inflation.

Historical co-player correlations require at least five aligned observations.
Because the current ESPN player-card histories are commonly shorter, shared
game, team-offense, and passing-volume latent factors are the documented
conservative fallback. They preserve each player's marginal variance while
creating correlated outcomes for same-game players. Market lines and weather
remain informational until a calibrated historical effect is available.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import os
import secrets
import statistics
import threading
from time import perf_counter

import numpy as np

import nfl_service
from projection_engine import project_players
from projection_sources.context import enrich_players


MIN_SIMULATION_COUNT = 25_000
try:
    SIMULATION_COUNT = max(MIN_SIMULATION_COUNT, int(os.getenv("FANTASY_SIMULATION_COUNT", MIN_SIMULATION_COUNT)))
except (TypeError, ValueError):
    SIMULATION_COUNT = MIN_SIMULATION_COUNT
_configured_seed = os.getenv("FANTASY_SIMULATION_SEED")
_FIXED_TEST_SEED = int(_configured_seed) if _configured_seed and _configured_seed.strip().lstrip("+-").isdigit() else None
_SIMULATION_CACHE: dict[str, dict] = {}
_CACHE_LOCK = threading.RLock()
_CACHE_LIMIT = 64
_SIMULATION_LOCKS: dict[str, threading.Lock] = {}
_SIMULATION_LOCK_LIMIT = 128


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _historical_variances(insights):
    per_player = {}
    per_position = {}
    for player_id, insight in insights.items():
        position = insight.get("position")
        actuals = [_number(row.get("fantasy_points")) for row in insight.get("game_log", [])]
        actuals = [value for value in actuals if value is not None]
        if len(actuals) >= 2:
            per_player[player_id] = statistics.variance(actuals)
            if position:
                per_position.setdefault(position, []).append(per_player[player_id])
    positional = {position: statistics.median(values) for position, values in per_position.items() if values}
    return per_player, positional


def _pooled_position_sds(insights):
    """Real league-scoring residual spread for positions lacking model SD.

    Pool centered ESPN game-log outcomes across at least three real players
    and five player-games. Centering each player avoids using talent-level
    differences as if they were within-player volatility.
    """
    by_position = {}
    for insight in insights.values():
        position = insight.get("position")
        values = [_number(row.get("fantasy_points")) for row in insight.get("game_log", [])]
        values = [value for value in values if value is not None]
        if position and values:
            by_position.setdefault(position, []).append(values)
    output = {}
    for position, player_histories in by_position.items():
        residuals = [value - statistics.fmean(values) for values in player_histories for value in values]
        if len(player_histories) >= 3 and len(residuals) >= 5:
            spread = float(np.std(residuals, ddof=1))
            if math.isfinite(spread) and spread > 0:
                output[position] = spread
    return output


def _game_states(schedule):
    """Map real NFL teams to their scoreboard state and stable event context."""
    states = {}
    for game in schedule.get("games", []):
        status = game.get("status") or {}
        home, away = game.get("home_team") or {}, game.get("away_team") or {}
        common = {"game_id": game.get("event_id"), "state": status.get("state"),
                  "clock": status.get("clock"), "period": status.get("period"),
                  "kickoff": game.get("kickoff"), "venue": game.get("venue")}
        for own, opp in ((home, away), (away, home)):
            team_id = own.get("team_id")
            if team_id is not None:
                states[team_id] = {**common, "team_score": _number(own.get("score")),
                                   "opponent_score": _number(opp.get("score")),
                                   "opponent_abbreviation": opp.get("abbreviation")}
    bye_ids = {int(item["team_id"]) for item in schedule.get("teams_on_bye", [])
               if str(item.get("team_id", "")).isdigit()}
    for team_id in bye_ids:
        states[team_id] = {"state": "bye", "game_id": None, "clock": None, "period": None,
                           "team_score": None, "opponent_score": None}
    return states


def _remaining_fraction(game_state):
    if game_state.get("state") != "in":
        return 1.0
    try:
        minutes, seconds = (int(part) for part in game_state["clock"].split(":"))
        period = int(game_state["period"])
        total = max(0, (4 - period) * 900 + minutes * 60 + seconds)
        return min(1.0, max(0.0, total / 3600.0))
    except (AttributeError, KeyError, TypeError, ValueError):
        # Unknown clock is not evidence that the game is nearly finished.
        return 1.0


def _merge_roster_card(roster_player, insight):
    merged = {**(insight or {}), **roster_player}
    for field in ("game_log", "season_fantasy_average", "season_fantasy_points", "injury_status",
                  "nfl_opponent", "nfl_game_time", "nfl_team_id", "nfl_team", "position"):
        if merged.get(field) is None:
            merged[field] = (insight or {}).get(field)
    return merged


def _team_players(team, insights, models, states, positional_empirical_sds=None):
    players, missing = [], []
    positional_empirical_sds = positional_empirical_sds or {}
    if not team or not isinstance(team.get("roster"), list):
        return None, ["ESPN did not provide this team's selected-week roster."]
    for roster_player in team["roster"]:
        if not roster_player.get("is_starter"):
            continue
        player_id = roster_player.get("player_id")
        player = _merge_roster_card(roster_player, insights.get(player_id, {}))
        model = models.get(player_id) or {}
        team_nfl_id = player.get("nfl_team_id")
        game = states.get(team_nfl_id)
        current = _number(roster_player.get("fantasy_points"))
        status_text = str(player.get("injury_status") or "").upper()
        has_official_out = status_text == "OUT" or any(
            event.get("event_type") == "official_injury_report"
            and str((event.get("detail") or {}).get("report_status", "")).casefold() == "out"
            for event in model.get("context_events", [])
        )
        custom_mean = _number(model.get("mean"))
        custom_sd = _number(model.get("standard_deviation"))
        variance_source = model.get("variance_source")
        if (custom_sd is None or custom_sd <= 0) and player.get("position") in positional_empirical_sds:
            custom_sd = positional_empirical_sds[player["position"]]
            variance_source = "league_position_empirical_residuals"
        projection = _number(model.get("espn_projection"))
        logs = [row for row in player.get("game_log", []) if _number(row.get("fantasy_points")) is not None]
        recent3 = _number(model.get("recent_3_game_average"))
        recent5 = _number(model.get("recent_5_game_average"))
        receiving_role = player.get("position") == "RB" and any(
            _number((row.get("stats") or {}).get("receivingTargets")) is not None
            and (row.get("stats") or {}).get("receivingTargets", 0) > 0
            for row in logs[-3:]
        )

        if game and game.get("state") == "bye":
            fixed = current if current is not None else 0.0
            players.append(_fixed_player(player, model, fixed, "confirmed_nfl_bye", projection, recent3, recent5))
            continue
        if has_official_out:
            players.append(_fixed_player(player, model, current if current is not None else 0.0,
                                         "structured_player_status_out", projection, recent3, recent5))
            continue
        if game is None:
            missing.append(f"{player.get('name', 'Player')}: NFL game status unavailable")
            continue
        if game.get("state") in ("post", "completed"):
            if current is None:
                missing.append(f"{player.get('name', 'Player')}: completed ESPN fantasy points unavailable")
                continue
            players.append(_fixed_player(player, model, current, "completed_espn_player_points", projection, recent3, recent5))
            continue
        if game.get("state") not in ("pre", "in"):
            missing.append(f"{player.get('name', 'Player')}: NFL game status unavailable")
            continue
        if game.get("state") == "in" and current is None:
            missing.append(f"{player.get('name', 'Player')}: live ESPN fantasy points unavailable")
            continue
        if custom_mean is None:
            missing.append(f"{player.get('name', 'Player')}: custom player projection unavailable")
            continue
        if custom_sd is None or custom_sd <= 0:
            missing.append(f"{player.get('name', 'Player')}: custom player outcome uncertainty unavailable")
            continue

        fraction = _remaining_fraction(game)
        current_points = current or 0.0
        if game.get("state") == "in":
            # Allocate the engine's full-game expected production to the real
            # time remaining. Actual points are already fixed, so an unusually
            # high first half raises the expected final while leaving only the
            # time-scaled rest-of-game mean and uncertainty to sample.
            remaining_mean = custom_mean * fraction
            remaining_sd = custom_sd * math.sqrt(fraction)
        else:
            current_points = 0.0
            remaining_mean = custom_mean
            remaining_sd = custom_sd
        uncertainty_multiplier = 1.0
        if status_text in {"QUESTIONABLE", "DTD", "LIMITED"}:
            uncertainty_multiplier = 1.25
        elif status_text == "DOUBTFUL":
            uncertainty_multiplier = 1.5
        if not logs:
            # The engine's SD in this case is real same-league positional
            # variance; modestly widen it because individual volatility is unknown.
            uncertainty_multiplier *= 1.25
        remaining_sd *= uncertainty_multiplier
        players.append({
            "player_id": player_id, "name": player.get("name"), "position": player.get("position"),
            "nfl_team": player.get("nfl_team"), "nfl_team_id": team_nfl_id,
            "nfl_team_logo_url": player.get("nfl_team_logo_url"),
            "injury_status": player.get("injury_status"), "nfl_opponent": player.get("nfl_opponent") or game.get("opponent_abbreviation"),
            "status": game["state"], "fixed": None, "current": current_points,
            "recommendation_projection": model.get("recommendation_projection"), "projection_snapshot_id": model.get("snapshot_id"), "engine_projection": custom_mean, "mean": current_points + remaining_mean, "remaining_mean": remaining_mean,
            "custom_median": _number(model.get("median")), "custom_floor": _number(model.get("floor")),
            "custom_ceiling": _number(model.get("ceiling")),
            "sd": remaining_sd, "full_game_sd": custom_sd, "projection": projection,
            "recent3": recent3, "recent5": recent5, "remaining_fraction": fraction,
            "variance_source": variance_source, "historical_points": [float(row["fantasy_points"]) for row in logs],
            "history_by_week": {int(row["week"]): float(row["fantasy_points"])
                                for row in logs if isinstance(row.get("week"), int)},
            "confidence": model.get("confidence", "low"), "prior_games": len(logs),
            "confidence_score": (model.get("confidence_basis") or {}).get("score"),
            "adjustments": model.get("adjustments") or [], "context": model.get("projection_context") or {},
            "game_id": game.get("game_id"), "game_clock": game.get("clock"), "game_period": game.get("period"),
            "nfl_team_score": game.get("team_score"), "nfl_opponent_score": game.get("opponent_score"),
            "uncertainty_multiplier": uncertainty_multiplier,
            "receiving_role": receiving_role,
        })
    return players, missing


def _fixed_player(player, model, fixed, source, projection, recent3, recent5):
    return {"player_id": player.get("player_id"), "name": player.get("name"), "position": player.get("position"),
            "nfl_team": player.get("nfl_team"), "nfl_team_id": player.get("nfl_team_id"),
            "injury_status": player.get("injury_status"), "nfl_opponent": player.get("nfl_opponent"),
            "status": "completed", "fixed": fixed, "fixed_source": source, "current": fixed,
            "mean": fixed, "remaining_mean": 0.0, "sd": 0.0, "full_game_sd": 0.0,
            "engine_projection": _number(model.get("mean")),
            "custom_median": _number(model.get("median")), "custom_floor": _number(model.get("floor")),
            "custom_ceiling": _number(model.get("ceiling")),
            "projection": projection, "recent3": recent3, "recent5": recent5,
            "remaining_fraction": 0.0, "variance_source": "fixed_actual", "historical_points": [],
            "history_by_week": {},
            "confidence": model.get("confidence", "high"), "prior_games": model.get("confidence_basis", {}).get("prior_games", 0),
            "confidence_score": (model.get("confidence_basis") or {}).get("score"),
            "adjustments": model.get("adjustments") or [], "context": model.get("projection_context") or {},
            "game_id": None, "game_clock": None, "game_period": None}


def _sample_residuals(player, simulations, rng):
    """Use the custom engine's SD with player-specific empirical shape."""
    sd = player["sd"]
    history = player["historical_points"]
    if len(history) >= 5:
        outcomes = np.asarray(history, dtype=np.float64)
        residuals = outcomes - outcomes.mean()
        observed_sd = float(outcomes.std(ddof=1))
        if observed_sd > 1e-9:
            draws = rng.choice(residuals / observed_sd, size=simulations, replace=True) * sd
            return draws
    # Student-t(5), normalized to unit variance: heavier tails than normal and
    # conservative for sparse-history or backup players.
    return rng.standard_t(df=5, size=simulations) * (sd / math.sqrt(5.0 / 3.0))


def _all_players(home, away):
    return [("a", player) for player in home] + [("b", player) for player in away]


def _simulate_matchup(home, away, simulations, rng, learned_correlations=None):
    home_scores = np.zeros(simulations, dtype=np.float64)
    away_scores = np.zeros(simulations, dtype=np.float64)
    player_draws = {}
    all_players = _all_players(home, away)
    game_groups, team_groups = {}, {}
    for _, player in all_players:
        if player["status"] == "completed":
            continue
        if player.get("game_id"):
            game_groups.setdefault(str(player["game_id"]), None)
        if player.get("nfl_team_id") is not None:
            team_groups.setdefault(str(player["nfl_team_id"]), None)
    # Estimate teammate outcome correlation from aligned, actual ESPN weekly
    # fantasy histories. A pair needs five common observations; smaller
    # samples are too unstable and use the documented conservative fallback.
    pair_correlations = []
    players_by_team = {}
    for _, player in all_players:
        if player["status"] != "completed" and player.get("nfl_team_id") is not None:
            players_by_team.setdefault(str(player["nfl_team_id"]), []).append(player)
    for group in players_by_team.values():
        for index, first in enumerate(group):
            for second in group[index + 1:]:
                first_history, second_history = first.get("history_by_week", {}), second.get("history_by_week", {})
                common_weeks = sorted(set(first_history) & set(second_history))
                if len(common_weeks) < 5:
                    continue
                correlation = float(np.corrcoef([first_history[w] for w in common_weeks],
                                                [second_history[w] for w in common_weeks])[0, 1])
                if math.isfinite(correlation):
                    pair_correlations.append(correlation)
    learned_team_correlation = None
    if pair_correlations:
        learned_team_correlation = max(0.0, min(0.30, float(np.median(pair_correlations))))
    team_loading = math.sqrt(learned_team_correlation) if learned_team_correlation and learned_team_correlation > 0 else 0.20
    game_z = {key: rng.standard_normal(simulations) for key in game_groups}
    team_z = {key: rng.standard_normal(simulations) for key in team_groups}
    pass_z = {key: rng.standard_normal(simulations) for key in team_groups}
    competition_values, competition_variances = {}, {}
    receivers_by_team = {}
    for _, player in all_players:
        if player["status"] != "completed" and player.get("position") in {"WR", "TE"} and player.get("nfl_team_id") is not None:
            receivers_by_team.setdefault(str(player["nfl_team_id"]), []).append(player["player_id"])
    for player_ids in receivers_by_team.values():
        if len(player_ids) < 2:
            continue
        centered = rng.standard_normal((simulations, len(player_ids)))
        centered -= centered.mean(axis=1, keepdims=True)
        variance = 0.10 ** 2 * (len(player_ids) - 1) / len(player_ids)
        for index, player_id in enumerate(player_ids):
            competition_values[player_id] = centered[:, index]
            competition_variances[player_id] = variance

    for side, player in all_players:
        if player["status"] == "completed":
            samples = np.full(simulations, player["fixed"], dtype=np.float64)
        else:
            independent = _sample_residuals(player, simulations, rng)
            position = player.get("position")
            if position in {"QB", "RB", "WR", "TE", "K"}:
                game_loading = 0.20
                if position in {"QB", "WR", "TE"}:
                    pass_loading = 0.18
                elif position == "RB":
                    pass_loading = 0.14 if player.get("receiving_role") else -0.10
                else:
                    pass_loading = 0.0
            else:
                # D/ST moves opposite to opposing game scoring; this latent
                # remains conservative and marginal variance is preserved.
                game_loading = -0.16 if position == "D/ST" else 0.0
                team_loading_for_player = 0.18 if position == "D/ST" else 0.0
                pass_loading = 0.0
            if position != "D/ST":
                team_loading_for_player = team_loading
            latent = np.zeros(simulations, dtype=np.float64)
            used_variance = 0.0
            game_id = player.get("game_id")
            if game_id and str(game_id) in game_z:
                latent += game_loading * game_z[str(game_id)]
                used_variance += game_loading ** 2
            team_id = player.get("nfl_team_id")
            if team_id is not None and str(team_id) in team_z:
                latent += team_loading_for_player * team_z[str(team_id)]
                used_variance += team_loading_for_player ** 2
                if pass_loading:
                    latent += pass_loading * pass_z[str(team_id)]
                    used_variance += pass_loading ** 2
            if player["player_id"] in competition_values:
                latent += 0.10 * competition_values[player["player_id"]]
                used_variance += competition_variances[player["player_id"]]
            residual_loading = math.sqrt(max(0.0, 1.0 - used_variance))
            samples = player["current"] + player["remaining_mean"] + latent * player["sd"] + independent * residual_loading
            # Keep the fitted distribution intact; negative fantasy outcomes
            # remain possible where league scoring and real player history allow them.
        player_draws[player["player_id"]] = samples
        if side == "a":
            home_scores += samples
        else:
            away_scores += samples
    correlation_data = {"learned_teammate_pair_count": len(pair_correlations),
                        "learned_median_teammate_correlation": learned_team_correlation,
                        "team_correlation_loading": team_loading}
    return home_scores, away_scores, player_draws, correlation_data


def _percentiles(values):
    quantiles = np.quantile(values, [0.10, 0.25, 0.50, 0.75, 0.90])
    return {"p10": float(quantiles[0]), "p25": float(quantiles[1]), "median": float(quantiles[2]),
            "p75": float(quantiles[3]), "p90": float(quantiles[4])}


def _team_result(team, players, scores):
    percentiles = _percentiles(scores)
    fixed_players = [{"player_id": player["player_id"], "name": player["name"],
                      "fantasy_points": player["fixed"], "status": "completed", "simulated": False,
                      "source": player.get("fixed_source", "completed_espn_player_points")}
                     for player in players if player["status"] == "completed"]
    modeled_players = [{
        "player_id": player["player_id"], "name": player["name"], "status": player["status"],
        "current_points": player["current"], "espn_projection": player["projection"],
        "recommendation_projection": player.get("recommendation_projection"), "projection_snapshot_id": player.get("projection_snapshot_id"), "custom_projection": player.get("engine_projection"), "expected_final_score": player["mean"],
        "custom_distribution": {"median": player.get("custom_median"), "floor": player.get("custom_floor"),
                                "ceiling": player.get("custom_ceiling"),
                                "standard_deviation": player.get("full_game_sd")},
        "remaining_projected_points": player["remaining_mean"],
        "outcome_standard_deviation": player["sd"], "variance_source": player["variance_source"],
        "confidence": player["confidence"], "projection_adjustments": player["adjustments"],
        "context": player["context"],
        "real_nfl_game_context": {"team_score": player.get("nfl_team_score"),
                                  "opponent_score": player.get("nfl_opponent_score"),
                                  "quarter": player.get("game_period"), "clock": player.get("game_clock")},
        "simulated": True}
        for player in players if player["status"] in ("pre", "in")]
    return {"team_id": team["team_id"], "team_name": team["team_name"],
            "current_score": team.get("current_fantasy_score"),
            "espn_projected_score": team.get("projected_fantasy_score"),
            "our_projected_score": float(sum(player["mean"] for player in players)),
            "remaining_projected_points": float(sum(player["remaining_mean"] for player in players)),
            "expected_final_score": float(np.mean(scores)), "projected_final_score": float(np.mean(scores)),
            "median_simulated_score": percentiles["median"],
            "likely_score_range": {"low": percentiles["p10"], "high": percentiles["p90"]},
            "score_percentiles": percentiles, "fixed_players": fixed_players,
            "modeled_players": modeled_players}


def _swing_players(home, away, home_scores, away_scores, player_draws):
    candidates = []
    for side_name, side_players in (("a", home), ("b", away)):
        team_samples = home_scores if side_name == "a" else away_scores
        opponent_samples = away_scores if side_name == "a" else home_scores
        for player in side_players:
            if player["status"] not in ("pre", "in") or player["sd"] <= 0:
                continue
            draws = player_draws[player["player_id"]]
            q10, q90 = np.quantile(draws, [0.10, 0.90])
            # Paired counterfactuals replace this player's sampled outcome with
            # their own low/high quantile; all other game and player samples
            # remain fixed to isolate actual win-probability leverage.
            low_scores = team_samples + (q10 - draws)
            high_scores = team_samples + (q90 - draws)
            low_win = (low_scores > opponent_samples).mean()
            high_win = (high_scores > opponent_samples).mean()
            candidates.append({
                "player_id": player["player_id"], "name": player["name"], "position": player["position"],
                "nfl_team": player["nfl_team"], "injury_status": player.get("injury_status"),
                "nfl_team_logo_url": player.get("nfl_team_logo_url"),
                "nfl_opponent": player.get("nfl_opponent"), "fantasy_team_name": None,
                "status": player["status"], "current_points": player["current"],
                "espn_projection": player["projection"], "custom_projection": player["mean"],
                "remaining_projected_points": player["remaining_mean"],
                "standard_deviation": player["sd"], "variance_source": player["variance_source"],
                "nfl_team_score": player.get("nfl_team_score"),
                "nfl_opponent_score": player.get("nfl_opponent_score"),
                "remaining_game_fraction": player["remaining_fraction"],
                "game_clock": player.get("game_clock"), "game_period": player.get("game_period"),
                "low_outcome_win_probability": float(low_win),
                "high_outcome_win_probability": float(high_win),
                "win_probability_swing": float(abs(high_win - low_win)),
            })
    return sorted(candidates, key=lambda item: item["win_probability_swing"], reverse=True)[:3]


def _confidence(players, home_scores, away_scores, home_probability, away_probability, tie_probability=0.0):
    """Score how dependable this matchup estimate is, not its chance to win.

    Components measure the simulated edge, how much real scoring is fixed,
    uncertainty left in the simulated margin, player data quality, and health
    clarity. A strong favorite alone cannot create high confidence before games
    start, and a narrow probability split remains low even with clean data.
    """
    remaining = [player for player in players if player.get("status") in ("pre", "in") and player.get("sd", 0) > 0]
    fixed = [player for player in players if player.get("status") == "completed"]
    total_expected = max(1.0, sum(abs(float(player.get("mean") or 0)) for player in players))
    fixed_points = sum(max(0.0, float(player.get("fixed") or 0)) for player in fixed)
    progress_score = min(100.0, 100.0 * fixed_points / total_expected)
    edge_score = min(100.0, 100.0 * max(abs(float(home_probability) - float(away_probability)),
                                        float(tie_probability or 0.0)))
    if not remaining:
        uncertainty_score = 100.0
    else:
        margin_sd = float(np.std(np.asarray(home_scores) - np.asarray(away_scores)))
        total_scale = max(1.0, float(np.mean(home_scores + away_scores)))
        relative_uncertainty = margin_sd / total_scale
        uncertainty_score = 100.0 * (1.0 - min(1.0, max(0.0, (relative_uncertainty - 0.05) / 0.25)))
    data_scores = [float(player["confidence_score"]) for player in players
                   if _number(player.get("confidence_score")) is not None]
    data_score = statistics.fmean(data_scores) if data_scores else 35.0
    def health_score(player):
        status = str(player.get("injury_status") or "").upper().replace(" ", "_")
        if status in {"ACTIVE", "NORMAL", "HEALTHY", "PROBABLE", "AVAILABLE"}:
            return 100.0
        if status in {"QUESTIONABLE", "DTD", "LIMITED"}:
            return 40.0
        if status == "DOUBTFUL":
            return 20.0
        if status in {"OUT", "INJURED_RESERVE", "SUSPENDED"}:
            return 90.0
        return 55.0
    health_scores = [health_score(player) for player in remaining]
    health = statistics.fmean(health_scores) if health_scores else 100.0
    components = {"win_probability_separation": round(edge_score),
                  "completed_scoring": round(progress_score),
                  "remaining_score_uncertainty": round(uncertainty_score),
                  "player_data_quality": round(data_score),
                  "health_clarity": round(health)}
    weights = {"win_probability_separation": 0.30, "completed_scoring": 0.15,
               "remaining_score_uncertainty": 0.25, "player_data_quality": 0.20,
               "health_clarity": 0.10}
    score = round(sum(components[key] * weight for key, weight in weights.items()))
    label = "high" if score >= 80 else "medium" if score >= 55 else "low"
    reasons = []
    if edge_score < 20:
        reasons.append("The simulated win chances are close.")
    elif edge_score >= 70:
        reasons.append("The simulation gives one team a clear edge.")
    if progress_score >= 60:
        reasons.append("Much of the fantasy scoring is already locked in.")
    elif progress_score < 10:
        reasons.append("Most players have not finished, so plenty can still change.")
    if uncertainty_score < 45:
        reasons.append("Several high-variance player outcomes are still ahead.")
    if data_score < 55:
        reasons.append("Some players have limited projection history.")
    if health < 55:
        reasons.append("At least one player's availability is uncertain.")
    return label, score, components, reasons[:3]


def _cache_key(matchup, states, insights, models, simulations, tie_rule, positional_empirical_sds=None):
    relevant = []
    for side in ("home_team", "away_team"):
        team = matchup.get(side) or {}
        roster = []
        for player in team.get("roster") or []:
            if not player.get("is_starter"):
                continue
            player_id = player.get("player_id")
            card = insights.get(player_id) or {}
            model = models.get(player_id) or {}
            state = states.get(card.get("nfl_team_id") or player.get("nfl_team_id")) or {}
            roster.append({"id": player_id, "score": player.get("fantasy_points"),
                           "espn_projection": player.get("projected_fantasy_points"),
                           "injury": card.get("injury_status"), "game_state": state.get("state"),
                           "period": state.get("period"), "clock": state.get("clock"),
                           "nfl_scores": (state.get("team_score"), state.get("opponent_score")),
                           "game": state.get("game_id"), "mean": model.get("mean"), "sd": model.get("standard_deviation"),
                           "confidence": model.get("confidence"), "adjustments": model.get("adjustments"),
                           "events": model.get("context_events"), "history_variance": model.get("historical_variance"),
                           "game_log": card.get("game_log")})
        relevant.append({"team": team.get("team_id"), "roster": roster})
    packed = json.dumps({"matchup": matchup.get("fantasy_matchup_id"), "week": matchup.get("week"),
                         "sides": relevant, "simulations": simulations, "tie_rule": tie_rule,
                         "positional_empirical_sds": positional_empirical_sds or {}},
                        sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(packed.encode()).hexdigest()


def _cached_result(key):
    with _CACHE_LOCK:
        value = _SIMULATION_CACHE.get(key)
        return json.loads(json.dumps(value)) if value is not None else None


def _save_result(key, value):
    with _CACHE_LOCK:
        if len(_SIMULATION_CACHE) >= _CACHE_LIMIT:
            _SIMULATION_CACHE.pop(next(iter(_SIMULATION_CACHE)))
        _SIMULATION_CACHE[key] = json.loads(json.dumps(value))


def predict_matchup(matchup, insights, states, player_variances=None, positional_variances=None,
                    simulations=SIMULATION_COUNT, tie_rule=None, models=None, seed=None,
                    positional_empirical_sds=None):
    """Return a cached estimate, ensuring concurrent refreshes share one run."""
    models = models or {}
    key = _cache_key(matchup, states, insights, models, simulations, tie_rule, positional_empirical_sds)
    with _CACHE_LOCK:
        lock = _SIMULATION_LOCKS.setdefault(key, threading.Lock())
        if len(_SIMULATION_LOCKS) > _SIMULATION_LOCK_LIMIT:
            for old_key, old_lock in list(_SIMULATION_LOCKS.items()):
                if len(_SIMULATION_LOCKS) <= _SIMULATION_LOCK_LIMIT:
                    break
                if old_key != key and not old_lock.locked():
                    _SIMULATION_LOCKS.pop(old_key, None)
    with lock:
        cached = _cached_result(key)
        if cached is not None:
            return cached
        return _predict_matchup_uncached(
            matchup, insights, states, player_variances, positional_variances,
            simulations, tie_rule, models, seed, positional_empirical_sds, key,
        )


def _predict_matchup_uncached(matchup, insights, states, player_variances=None, positional_variances=None,
                              simulations=SIMULATION_COUNT, tie_rule=None, models=None, seed=None,
                              positional_empirical_sds=None, cache_key=None):
    home_team, away_team = matchup.get("home_team"), matchup.get("away_team")
    if not home_team or not away_team:
        return {"fantasy_matchup_id": matchup["fantasy_matchup_id"], "week": matchup["week"],
                "status": "unavailable", "message": "ESPN did not provide two teams for this fantasy matchup.", "simulation_count": 0}
    models = models or {}
    key = cache_key or _cache_key(matchup, states, insights, models, simulations, tie_rule, positional_empirical_sds)
    home_players, home_missing = _team_players(home_team, insights, models, states, positional_empirical_sds)
    away_players, away_missing = _team_players(away_team, insights, models, states, positional_empirical_sds)
    missing = home_missing + away_missing
    if missing or not home_players or not away_players:
        return {"fantasy_matchup_id": matchup["fantasy_matchup_id"], "week": matchup["week"],
                "status": "unavailable", "message": "ESPN and the custom player model are insufficient to model every starting player without substituting missing values.",
                "missing_data": missing, "simulation_count": 0}

    simulation_started = perf_counter()
    actual_seed = seed if seed is not None else (_FIXED_TEST_SEED if _FIXED_TEST_SEED is not None else secrets.randbits(64))
    rng = np.random.default_rng(actual_seed)
    home_scores, away_scores, player_draws, correlation_data = _simulate_matchup(home_players, away_players, simulations, rng)
    ties = np.isclose(home_scores, away_scores, atol=1e-9)
    home_wins = (home_scores > away_scores) & ~ties
    away_wins = (away_scores > home_scores) & ~ties
    tie_rule_value = str(tie_rule or "split").casefold()
    # Apply a known ESPN home/away tiebreak. When no deterministic tie breaker
    # is configured, expose exclusive win/loss/tie probabilities.
    raw_tie_probability = float(ties.mean())
    if "home" in tie_rule_value:
        probability_a, probability_b, tie_probability = float(home_wins.mean() + ties.mean()), float(away_wins.mean()), 0.0
    elif "away" in tie_rule_value:
        probability_a, probability_b, tie_probability = float(home_wins.mean()), float(away_wins.mean() + ties.mean()), 0.0
    else:
        probability_a, probability_b, tie_probability = float(home_wins.mean()), float(away_wins.mean()), raw_tie_probability
    confidence, confidence_score, confidence_components, confidence_reasons = _confidence(
        home_players + away_players, home_scores, away_scores, probability_a, probability_b, tie_probability)
    side_a = _team_result(home_team, home_players, home_scores)
    side_b = _team_result(away_team, away_players, away_scores)
    swing = _swing_players(home_players, away_players, home_scores, away_scores, player_draws)
    # associate swing candidates with fantasy team by player ownership
    ownership = {p["player_id"]: (side, team) for side, team in (("a", home_team), ("b", away_team))
                 for p in (home_players if side == "a" else away_players)}
    for item in swing:
        side, team = ownership[item["player_id"]]
        item["fantasy_team_id"] = team["team_id"]
        item["fantasy_team_name"] = team["team_name"]
        item["win_probability_for_team"] = item["high_outcome_win_probability"]
        item["win_probability_swing"] = round(item["win_probability_swing"], 5)
    result = {
        "fantasy_matchup_id": matchup["fantasy_matchup_id"], "week": matchup["week"], "status": "estimated",
        "involves_my_team": matchup.get("involves_my_team", False), "team_a": side_a, "team_b": side_b,
        "team_a_win_probability": probability_a, "team_b_win_probability": probability_b,
        "tie_probability": tie_probability, "score_tie_probability": raw_tie_probability, "tie_rule": tie_rule_value,
        "simulation_count": simulations, "likely_score_percentiles": "10th–90th",
        "biggest_remaining_swing_players": swing, "missing_data": [],
        "model_confidence": confidence, "model_confidence_score": confidence_score,
        "model_confidence_components": confidence_components,
        "model_confidence_reasons": confidence_reasons,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "correlation_method": "Shared zero-mean NFL game (20%) and passing-volume factors (QB/WR/TE +18%; receiving RB +14%; conventional RB −10%); WR/TE target competition uses a 10% centered negative factor. Team-offense loading is the square root of median real teammate weekly-score correlation when at least five aligned games exist, capped at 0.30, otherwise the documented 20% fallback. Independent residual variance is preserved.",
        "correlation_data": correlation_data,
        "simulation_elapsed_ms": round((perf_counter() - simulation_started) * 1000, 2),
        "game_environment_method": "Real NFL game IDs share environment draws; live clock scales remaining uncertainty, and live NFL score/quarter are retained as context. Passing-volume links passing players and opposes conventional RB rushing while supporting receiving backs. Current score margin, market lines, and weather add no mean shift because a reliable calibrated effect is unavailable.",
        "live_method": "Completed ESPN points and confirmed bye/OUT scores are fixed. Live players add only custom-model remaining expected production; standard deviation scales with the square root of scoreboard time remaining.",
        "model": "25,000+ vectorized Monte Carlo samples use the custom player projection engine's mean, historical/positional uncertainty, confidence, and supported adjustments. ESPN selected-week projections are comparison inputs only. Player-specific historical residuals are bootstrapped at n≥5; sparse samples use normalized Student-t(5). If the engine cannot estimate a player's SD, pooled real ESPN league-position residuals are used only with at least three players and five player-games; otherwise the matchup is unavailable.",
    }
    _save_result(key, result)
    return result


def _league_projection_inputs(service, matchups, week, insights):
    rostered = {}
    teams = {}
    for matchup in matchups:
        for side in ("home_team", "away_team"):
            team = matchup.get(side)
            if not team:
                continue
            teams[team["team_id"]] = team
            for roster_player in team.get("roster") or []:
                if not roster_player.get("is_starter"):
                    continue
                player_id = roster_player["player_id"]
                rostered[player_id] = _merge_roster_card(roster_player, insights.get(player_id, {}))
    players = list(rostered.values())
    if not players:
        return {}, {}, {}
    from projection_snapshot import resolve_players
    enriched, _ = resolve_players(service, week, players)
    models = {pid: player['custom_projection'] for pid, player in enriched.items()}
    return enriched, models, teams


def predictions(service, selected=None):
    week = service.week(selected)
    matchup_payload = service.fantasy_matchups(week)
    if not matchup_payload["fantasy_matchups"]:
        return {"league_id": service.league.league_id, "year": service.league.year, "week": week,
                "model": "Monte Carlo fantasy matchup estimates", "simulation_count": SIMULATION_COUNT,
                "last_updated": datetime.now(timezone.utc).isoformat(), "predictions": []}
    player_ids = list(dict.fromkeys(
        player["player_id"]
        for matchup in matchup_payload["fantasy_matchups"]
        for side in ("home_team", "away_team")
        for team in [matchup.get(side)] if team
        for player in (team.get("roster") or []) if player.get("is_starter")
    ))
    insights = {}
    for offset in range(0, len(player_ids), 50):
        insights.update(service.player_insights(player_ids[offset:offset + 50], week))
    schedule = nfl_service.nfl_schedule(week)
    states = _game_states(schedule)
    enriched, models, teams = _league_projection_inputs(
        service, matchup_payload["fantasy_matchups"], week, insights)
    positional_empirical_sds = _pooled_position_sds(enriched)
    scoring = service.recommendation_settings()
    tie_rule = scoring.get("tie_rule") or scoring.get("playoff_tie_rule")
    results = [predict_matchup(item, enriched, states, simulations=SIMULATION_COUNT, tie_rule=tie_rule,
                               models=models, positional_empirical_sds=positional_empirical_sds)
               for item in matchup_payload["fantasy_matchups"]]
    return {"league_id": matchup_payload["league_id"], "year": matchup_payload["year"], "week": week,
            "my_team_id": matchup_payload["my_team_id"], "simulation_count": SIMULATION_COUNT,
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "model": "Custom player distributions with vectorized correlated Monte Carlo (not ESPN official odds)",
            "predictions": results}
