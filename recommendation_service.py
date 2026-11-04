"""Explainable, deterministic lineup and waiver scoring over ESPN data."""

from functools import lru_cache
import math
import statistics


WAIVER_WEIGHTS = {
    "espn_projection": 0.55,
    "season_average": 0.15,
    "last_3_average": 0.15,
    "last_5_average": 0.15,
}


def usable_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def average_games(games):
    points = [game.get("fantasy_points") for game in games or []
              if usable_number(game.get("fantasy_points"))]
    return sum(points) / len(points) if points else None


def fantasy_value(player):
    model = player.get("custom_projection") or player.get("trade_projection") or {}
    model_value = model.get("our_projection") if isinstance(model, dict) else None
    if usable_number(model_value):
        return float(model_value), "custom_projection_engine"
    projection = player.get("projected_fantasy_points")
    if usable_number(projection):
        return float(projection), "espn_projection"
    season_average = player.get("season_fantasy_average")
    if usable_number(season_average):
        return float(season_average), "season_average_fallback"
    return None, None


def confidence_aware_value(player):
    """Blend the raw model with independent real references for lineup use.

    The recommendation point estimate keeps its existing sample/shrinkage
    blend. Projection-confidence labels are scored separately from evidence
    quality by the projection engine. ESPN, season, and recent actual averages
    form an equal-weight reference mean, with unavailable references omitted.
    An unsupported extreme outlier from low/unavailable-confidence output is
    given zero influence; it remains visible as raw model output.
    """
    model = player.get("custom_projection") or {}
    if "recommendation_projection" in model:
        value = model["recommendation_projection"]
        detail = {key: player[key] for key in (
            "recommendation_confidence", "custom_weight", "model_disagreement", "recommendation_note",
            "recommendation_confidence_score", "projection_confidence_score", "raw_custom_projection",
            "disagreement_supported") if key in player}
        detail["recommendation_projection"] = value
        return value, player.get("recommendation_estimate_source", "confidence_aware_blend"), detail
    raw = model.get("our_projection") if isinstance(model, dict) else None
    espn = model.get("espn_projection", player.get("projected_fantasy_points")) if isinstance(model, dict) else player.get("projected_fantasy_points")
    confidence = model.get("confidence") if isinstance(model, dict) else None
    basis = model.get("confidence_basis") if isinstance(model, dict) else None
    basis = basis if isinstance(basis, dict) else {}
    prior_games = basis.get("prior_games")
    shrinkage = basis.get("shrinkage_from_observed_variance")
    projection_score = basis.get("score")
    refs = [value for value in (
        espn,
        player.get("season_fantasy_average"),
        model.get("recent_3_game_average") if isinstance(model, dict) else None,
        model.get("recent_5_game_average") if isinstance(model, dict) else None,
    ) if usable_number(value)]
    anchor = sum(float(value) for value in refs) / len(refs) if refs else None
    if anchor is None:
        return (float(raw), "custom_projection_engine", {
            "recommendation_projection": float(raw), "raw_custom_projection": float(raw),
            "recommendation_confidence": "low", "custom_weight": 0.0,
            "model_disagreement": None, "disagreement_supported": False,
            "recommendation_note": "No independent projection or production reference was available.",
        }) if usable_number(raw) else (None, None, {})

    count = int(prior_games) if isinstance(prior_games, (int, float)) and prior_games >= 0 else 0
    precision = float(shrinkage) if usable_number(shrinkage) else 0.0
    reliability = min(1.0, count / 5.0) * min(1.0, max(0.0, precision))
    factors = model.get("adjustments", []) if isinstance(model, dict) else []
    evidence_keys = {item.get("key") for item in factors if isinstance(item, dict)}
    corroborating = bool(evidence_keys & {"injury", "opportunity", "matchup", "team_context", "teammate_context", "news"})
    difference = float(raw) - anchor if usable_number(raw) else None
    disagreement = bool(difference is not None and abs(difference) >= max(5.0, abs(anchor) * 0.30))
    if confidence not in {"low", "medium", "high"}:
        reliability = 0.0
    if disagreement and confidence in {None, "low"} and not corroborating:
        reliability = 0.0
    value = round((float(raw) * reliability + anchor * (1.0 - reliability)) if usable_number(raw) else anchor, 3)
    sources_agree = len(refs) < 2 or max(float(v) for v in refs) - min(float(v) for v in refs) <= 3.0
    if usable_number(projection_score):
        estimate_score = float(projection_score)
        if disagreement and not corroborating:
            estimate_score = min(estimate_score, 54.0)
        estimate_confidence = ("high" if estimate_score >= 80 else
                               "medium" if estimate_score >= 55 else "low")
    elif confidence == "high" and sources_agree and count >= 5:
        estimate_score = 85.0
        estimate_confidence = "high"
    elif confidence in {"high", "medium"} and count >= 3 and (not disagreement or corroborating):
        estimate_score = 65.0
        estimate_confidence = "medium"
    else:
        estimate_score = 35.0
        estimate_confidence = "low"
    note = "Confidence-weighted estimate using the custom model and available ESPN/history references."
    if disagreement:
        note = ("Projection disagreement: the raw custom projection differs substantially from independent references. "
                + ("Supported contextual factors corroborate the direction." if corroborating else
                   "The low or unavailable model confidence is not supported by strong contextual evidence, so the estimate is shrunk toward the references."))
    return value, "confidence_aware_blend", {
        "recommendation_projection": value,
        "raw_custom_projection": float(raw) if usable_number(raw) else None,
        "recommendation_confidence": estimate_confidence,
        "recommendation_confidence_score": round(estimate_score),
        "projection_confidence_score": int(projection_score) if usable_number(projection_score) else None,
        "custom_weight": round(reliability, 3),
        "model_disagreement": ({"raw_custom": float(raw), "reference_anchor": round(anchor, 3),
                                "recommendation_estimate": value,
                                "espn_projection": float(espn) if usable_number(espn) else None,
                                "data_confidence": confidence if confidence in {"low", "medium", "high"} else "low",
                                "difference": round(difference, 3), "flagged": disagreement,
                                "supported_by_context": corroborating,
                                "supporting_factors": [
                                    {"label": item.get("label"), "evidence": item.get("evidence"),
                                     "adjustment": item.get("adjustment"), "source": item.get("source")}
                                    for item in factors if isinstance(item, dict)
                                    and item.get("key") in {"injury", "opportunity", "matchup", "team_context", "teammate_context", "news"}
                                    and item.get("evidence")
                                ][:5]} if difference is not None else None),
        "disagreement_supported": corroborating,
        "recommendation_note": note,
    }


def established_starter(player, roster):
    """Numerically identify an incumbent ranked above the team positional median.

    Season PPG and the independent ESPN weekly estimate can each support the
    flag. A projection-only or season-only rank requires at least two roster
    comparators; no player names or position-specific point cutoffs are used.
    """
    if not player.get("is_starter"):
        return False
    position = player.get("position")
    metrics = (
        ("season_fantasy_average", lambda item: item.get("season_fantasy_average")),
        ("espn_projection", lambda item: (item.get("custom_projection") or {}).get("espn_projection", item.get("projected_fantasy_points"))),
    )
    for _, getter in metrics:
        target = getter(player)
        peers = [float(value) for item in roster if item.get("position") == position
                 for value in [getter(item)] if usable_number(value)]
        if len(peers) >= 2 and usable_number(target):
            rank_from_bottom = sum(1 for value in peers if value <= float(target))
            if rank_from_bottom / len(peers) >= 0.5:
                return True
    return False


def established_roster_player(player, roster):
    """Identify a season-productive roster asset that should not be a casual drop."""
    position = player.get("position")
    peers = sorted(float(item["season_fantasy_average"]) for item in roster
                   if item.get("position") == position and usable_number(item.get("season_fantasy_average")))
    average = player.get("season_fantasy_average")
    if len(peers) < 2 or not usable_number(average):
        return False
    played = len([game for game in (player.get("game_log") or []) if usable_number(game.get("fantasy_points"))])
    return played >= 3 and sum(1 for value in peers if value <= float(average)) / len(peers) >= 0.5


def assess_start_sit_swap(incoming, outgoing, roster):
    """Score the decision between two players, separately from either projection."""
    in_value = incoming.get("expected_points")
    out_value = confidence_aware_value(outgoing)[0]
    if not usable_number(in_value) or not usable_number(out_value):
        return {"expected_advantage": None, "uncertainty": None, "confidence": "low",
                "confidence_score": 0, "range_overlap": None,
                "confidence_reasons": ["There is not enough information to compare these players."],
                "established_starter_protection": established_starter(outgoing, roster)}
    edge = float(in_value) - float(out_value)
    in_model = incoming.get("custom_projection") or {}
    out_model = outgoing.get("custom_projection") or {}
    in_sd = in_model.get("standard_deviation")
    out_sd = out_model.get("standard_deviation")
    if not usable_number(in_sd) and usable_number(in_model.get("floor")) and usable_number(in_model.get("ceiling")):
        in_sd = (float(in_model["ceiling"]) - float(in_model["floor"])) / (2 * 1.2815515655446004)
    if not usable_number(out_sd) and usable_number(out_model.get("floor")) and usable_number(out_model.get("ceiling")):
        out_sd = (float(out_model["ceiling"]) - float(out_model["floor"])) / (2 * 1.2815515655446004)
    uncertainty = math.sqrt(float(in_sd) ** 2 + float(out_sd) ** 2) if usable_number(in_sd) and usable_number(out_sd) else None
    def projection_score(model):
        basis = model.get("confidence_basis") or {}
        score = basis.get("score")
        if usable_number(score):
            return float(score)
        return {"high": 85.0, "medium": 65.0, "low": 35.0}.get(model.get("confidence"), 30.0)

    quality = min(projection_score(in_model), projection_score(out_model))
    # Shift each model's observed range to the actual recommendation estimate,
    # since recommendation points may blend raw custom output with ESPN/history.
    def bounds(model, center, sd):
        raw = model.get("our_projection")
        floor, ceiling = model.get("floor"), model.get("ceiling")
        if usable_number(raw) and usable_number(floor) and usable_number(ceiling):
            return (float(center) - max(0.0, float(raw) - float(floor)),
                    float(center) + max(0.0, float(ceiling) - float(raw)))
        if usable_number(sd):
            return float(center) - 1.2815515655446004 * float(sd), float(center) + 1.2815515655446004 * float(sd)
        return None

    in_bounds = bounds(in_model, float(in_value), in_sd)
    out_bounds = bounds(out_model, float(out_value), out_sd)
    if in_bounds and out_bounds:
        overlap_width = max(0.0, min(in_bounds[1], out_bounds[1]) - max(in_bounds[0], out_bounds[0]))
        union_width = max(in_bounds[1], out_bounds[1]) - min(in_bounds[0], out_bounds[0])
        overlap = overlap_width / union_width if union_width > 0 else 1.0
    else:
        overlap = 1.0  # Missing ranges do not count as evidence of separation.
    z_edge = edge / uncertainty if uncertainty and uncertainty > 0 else 0.0
    edge_score = 100.0 * min(1.0, max(0.0, z_edge / 1.75))
    separation_score = 100.0 * (1.0 - min(1.0, max(0.0, overlap)))
    statuses = [str(player.get("injury_status") or "").upper() for player in (incoming, outgoing)]
    health_scores = [100.0 if status in {"ACTIVE", "NORMAL", "HEALTHY", "PROBABLE", "AVAILABLE"}
                     else 40.0 if status in {"QUESTIONABLE", "DTD", "LIMITED"}
                     else 20.0 if status == "DOUBTFUL" else 55.0 for status in statuses]
    components = {"projection_gap": round(edge_score), "range_separation": round(separation_score),
                  "player_data": round(quality), "status_certainty": round(statistics.fmean(health_scores))}
    decision_score = round(statistics.fmean(components.values()))
    confidence = "high" if decision_score >= 80 else "medium" if decision_score >= 55 else "low"
    established = established_starter(outgoing, roster)
    if edge <= 0 or (uncertainty is not None and z_edge < 0.5) or overlap >= 0.8 or quality < 35:
        confidence = "low"
    if established and not (uncertainty is not None and z_edge >= 1.75 and quality >= 75 and overlap <= 0.25):
        confidence = "low"
    reasons = []
    if confidence == "high":
        reasons.append("The projection gap is clear, both players have useful data, and their likely ranges have little overlap.")
    elif confidence == "medium":
        reasons.append("One player is projected higher, but their likely scoring ranges still overlap.")
    else:
        reasons.append("The projections are close or uncertain, so this is basically a toss-up.")
    if min(health_scores) < 55:
        reasons.append("At least one player's health or workload is uncertain.")
    if quality < 55:
        reasons.append("We have limited reliable data for at least one player.")
    return {"expected_advantage": round(edge, 2),
            "uncertainty": round(uncertainty, 2) if uncertainty is not None else None,
            "confidence": confidence, "confidence_score": decision_score,
            "confidence_components": components, "range_overlap": round(overlap, 3),
            "confidence_reasons": reasons[:3], "established_starter_protection": established}


def roster_needs(rosters, team_id, slot_counts, week, confidence_aware=False):
    """Compare each position's starters and usable depth with actual league rosters.

    Labels are derived from the league's median projected starter/depth and
    interquartile spread. They are not hand-assigned player rankings.
    """
    positions = ("QB", "RB", "WR", "TE", "K", "D/ST")
    per_team = {}
    for team in rosters:
        roster = team.get("roster") or []
        team_id_value = team.get("team_id")
        lineup = optimize_lineup(roster, slot_counts, week, confidence_aware=confidence_aware)
        starter_ids = {p.get("player_id") for p in lineup["starters"]}
        data = {}
        for position in positions:
            players = [p for p in roster if p.get("position") == position]
            starters = [p for p in lineup["starters"] if p.get("position") == position]
            value = confidence_aware_value if confidence_aware else fantasy_value
            scores = sorted((value(p)[0] for p in starters if value(p)[0] is not None), reverse=True)
            bench = [value(p)[0] for p in players if p.get("player_id") not in starter_ids and value(p)[0] is not None]
            data[position] = {
                "starter_projection": round(sum(scores), 2) if scores else None,
                "starter_count": len(starters),
                "rostered_count": len(players),
                "usable_bench_count": sum(value > 0 for value in bench),
                "best_bench_projection": max(bench) if bench else None,
            }
        per_team[team_id_value] = data
    result = {}
    for position in positions:
        observed = sorted(row[position]["starter_projection"] for row in per_team.values()
                          if row[position]["starter_projection"] is not None)
        if not observed:
            result[position] = {"label": "Unavailable", "basis": "No league projection data", "metrics": per_team.get(team_id, {}).get(position, {})}
            continue
        median = observed[len(observed) // 2] if len(observed) % 2 else (observed[len(observed)//2-1] + observed[len(observed)//2]) / 2
        q1 = observed[(len(observed)-1)//4]
        q3 = observed[(3*(len(observed)-1))//4]
        own = per_team.get(team_id, {}).get(position, {})
        value = own.get("starter_projection")
        depth = own.get("usable_bench_count", 0)
        thin = own.get("rostered_count", 0) <= own.get("starter_count", 0)
        if value is None:
            label = "Needs improvement"
        elif value < q1 or (value < median and thin):
            label = "Weak"
        elif value > q3 and depth >= 1:
            label = "Strong"
        elif depth == 0:
            label = "Weak depth"
        else:
            label = "Average"
        result[position] = {
            "label": label,
            "basis": "Your optimized starter projection compared with league roster quartiles; usable bench counts rostered players with a positive supported projection.",
            "metrics": own,
            "league_median_starter_projection": round(median, 2),
            "league_lower_quartile": round(q1, 2),
            "league_upper_quartile": round(q3, 2),
            "league_teams_compared": len(observed),
        }
    return result


def optimize_lineup(roster, slot_counts, week, confidence_aware=False):
    """Find the highest-value complete legal assignment to ESPN's real roster slots.

    Each roster player can fill at most one slot. If ESPN's rules cannot be
    filled from the current eligible roster, unfilled slots are returned
    explicitly rather than being silently treated as a legal lineup.
    """
    active_slots = []
    for slot, count in slot_counts.items():
        if slot in {"BE", "IR", "ER", "", "Rookie"}:
            continue
        active_slots.extend([slot] * max(0, int(count or 0)))
    display_order = {"QB": 0, "RB": 1, "WR": 3, "RB/WR/TE": 5, "RB/WR": 5,
                     "WR/TE": 5, "RB/TE": 5, "TE": 6, "K": 7, "D/ST": 8}
    active_slots.sort(key=lambda slot: display_order.get(slot, 9))

    candidates = []
    seen_player_ids = set()
    for player in roster:
        player_id = player.get("player_id")
        if player_id in seen_player_ids:
            continue
        seen_player_ids.add(player_id)
        if player.get("lineup_status") == "reserve":
            continue
        if player.get("bye_week") == week:
            continue
        injury = (player.get("injury_status") or "").upper().replace(" ", "_")
        if injury in {"OUT", "IR", "INJURED_RESERVE", "SUSPENDED", "PUP"}:
            continue
        if player.get("lineup_status") not in {"available", "bench", "starter", "unassigned"}:
            continue
        if not player.get("eligible_positions"):
            continue
        points, source, reliability = (*confidence_aware_value(player),) if confidence_aware else (*fantasy_value(player), {})
        model = player.get("custom_projection") or {}
        candidates.append({**player, **reliability, "expected_points": points, "estimate_source": source,
                           "floor": model.get("floor"), "median": model.get("median"),
                           "ceiling": model.get("ceiling"), "projection_confidence": model.get("confidence")})

    slot_candidates = [
        [index for index, player in enumerate(candidates)
         if slot in (player.get("eligible_positions") or [])]
        for slot in active_slots
    ]

    @lru_cache(maxsize=None)
    def solve(slot_index, used_mask):
        if slot_index == len(active_slots):
            return 0.0, ()
        candidates_here = [i for i in slot_candidates[slot_index]
                           if not (used_mask & (1 << i))]
        # An empty slot is permitted only when the roster cannot fill it. A real
        # estimate always wins over an unscored player; unknown remains visible.
        if not candidates_here:
            return solve(slot_index + 1, used_mask)
        best_score, best_assignment = float("-inf"), ()
        for index in candidates_here:
            value = candidates[index]["expected_points"]
            candidate_score = float(value) if value is not None else -10000.0
            tail_score, tail = solve(slot_index + 1, used_mask | (1 << index))
            score = candidate_score + tail_score
            if score > best_score:
                best_score, best_assignment = score, ((slot_index, index),) + tail
        return best_score, best_assignment

    _, pairs = solve(0, 0)
    selected = {slot_index: player_index for slot_index, player_index in pairs}
    starters = []
    for index, slot in enumerate(active_slots):
        if index in selected:
            player = candidates[selected[index]]
            starters.append({**player, "recommended_slot": slot})
    starter_ids = {player["player_id"] for player in starters}
    # Preserve the complete ESPN roster in the bench group, including bye, IR,
    # and players whose data does not support a numerical recommendation.
    bench = []
    for player in roster:
        if player["player_id"] not in starter_ids:
            points, source, reliability = (*confidence_aware_value(player),) if confidence_aware else (*fantasy_value(player), {})
            bench.append({**player, **reliability, "expected_points": points, "estimate_source": source})
    slot_labels = {}
    occurrences = {}
    for index, slot in enumerate(active_slots):
        occurrences[slot] = occurrences.get(slot, 0) + 1
        if slot == "RB/WR/TE":
            label = "FLEX"
        elif slot in {"RB", "WR"} and active_slots.count(slot) > 1:
            label = f"{slot}{occurrences[slot]}"
        else:
            label = slot
        slot_labels[index] = label
        if index in selected:
            player_index = selected[index]
            candidates[player_index]["recommended_slot_label"] = label
            # Replace the pre-label row with the enriched copy below.
            starters = [({**row, "recommended_slot_label": label}
                         if row.get("player_id") == candidates[player_index].get("player_id") else row)
                        for row in starters]
    unfilled = [slot_labels[index] for index in range(len(active_slots)) if index not in selected]
    legal = (not unfilled and len(starters) == len(active_slots)
             and len({player.get("player_id") for player in starters}) == len(starters)
             and all(player.get("recommended_slot") in (player.get("eligible_positions") or [])
                     for player in starters))
    return {"active_slots": active_slots, "starter_requirements": dict(slot_counts),
            "starters": starters, "bench": bench, "unfilled_slots": unfilled,
            "legal_lineup": legal}


def waiver_score(player):
    games = player.get("game_log") or []
    last3 = average_games(games[-3:])
    last5 = average_games(games[-5:])
    raw = {
        "espn_projection": player.get("projected_fantasy_points"),
        "season_average": player.get("season_fantasy_average"),
        "last_3_average": last3,
        "last_5_average": last5,
    }
    available = [(key, raw[key], weight) for key, weight in WAIVER_WEIGHTS.items()
                 if usable_number(raw[key])]
    total_weight = sum(weight for _, _, weight in available)
    score = sum(float(value) * weight for _, value, weight in available) / total_weight if total_weight else None
    confidence = ("high" if usable_number(raw["espn_projection"]) and usable_number(raw["season_average"]) and len(games) >= 3
                  else "medium" if usable_number(raw["espn_projection"]) and len(games) >= 1
                  else "low")
    usage = usage_summary(games[-5:])
    return {
        "recommendation_score": score,
        "score_components": {key: value for key, value in raw.items()},
        "score_weights": {key: weight for key, _, weight in available},
        "score_formula": "weighted average of available ESPN projection (55%), season average (15%), last 3 actual-game average (15%), and last 5 actual-game average (15%); weights renormalize over available fields",
        "recent_usage": usage,
        "confidence": confidence,
    }


def usage_summary(games):
    stats = [game.get("stats") or {} for game in games]
    aliases = {
        "passing attempts": ("passingAttempts",),
        "carries": ("rushingAttempts", "rushingAttemptsPerGame"),
        "targets": ("receivingTargets", "receivingTargetsPerGame"),
        "receptions": ("receivingReceptions", "receptions"),
    }
    output = {}
    for label, candidates in aliases.items():
        values = [next((row[key] for key in candidates if usable_number(row.get(key))), None)
                  for row in stats]
        values = [value for value in values if value is not None]
        if values:
            output[label] = round(sum(values) / len(values), 2)
    return output
