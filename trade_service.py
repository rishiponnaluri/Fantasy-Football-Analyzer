"""Explainable trade analysis over real ESPN rosters and the custom projections."""

from __future__ import annotations

import math
from itertools import combinations
from datetime import datetime, timezone
from statistics import median

from espn_service import APIError
from projection_engine import project_players
from projection_sources.context import enrich_players
from recommendation_service import optimize_lineup, roster_needs


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _prepare(service, other_team_id: int, selected: int | None):
    week = service.week(selected)
    my_team = service.my_team()
    if other_team_id == my_team.team_id:
        raise APIError(422, "invalid_trade_team", "Select a fantasy team other than your own.")
    if other_team_id not in service.teams:
        raise APIError(404, "fantasy_team_not_found", f"Fantasy team {other_team_id} was not found in your ESPN league.")
    matchups = service.fantasy_matchups(week)
    teams = {}
    for matchup in matchups["fantasy_matchups"]:
        for side in ("home_team", "away_team"):
            team = matchup.get(side)
            if team and team.get("roster") is not None:
                teams[team["team_id"]] = team
    my = teams.get(my_team.team_id)
    other = teams.get(other_team_id)
    if not my or not other:
        raise APIError(502, "trade_roster_unavailable", "ESPN did not supply both selected fantasy rosters for this week.")
    all_rosters = list(teams.values())
    state_cache = {}
    for team in all_rosters:
        team["_trade_state_cache"] = state_cache
    my["_league_rosters"] = all_rosters
    other["_league_rosters"] = all_rosters
    raw_players = [dict(player, fantasy_team_id=team["team_id"], fantasy_team_name=team["team_name"])
                   for team in (my, other) for player in team["roster"]]
    ids = [player["player_id"] for player in raw_players]
    insight = {}
    for offset in range(0, len(ids), 50):
        insight.update(service.player_insights(ids[offset:offset + 50], week))
    players = []
    for original in raw_players:
        detail = insight.get(original["player_id"], {})
        merged = {**detail, **original}
        # Player card carries historical stats, position eligibility, and bye
        # data; ESPN's selected-week roster remains authoritative for points/slot.
        for key in ("game_log", "season_fantasy_average", "season_fantasy_points", "eligible_positions",
                    "bye_week", "nfl_opponent", "nfl_game_time", "jersey_number", "age", "height", "weight"):
            if original.get(key) is None and detail.get(key) is not None:
                merged[key] = detail[key]
        players.append(merged)
    enriched, source_status = enrich_players(players, service.league.year, week, service)
    normalized = list(enriched.values())
    projected = project_players(normalized, week, service.league.current_week)
    for player in normalized:
        model = projected[player["player_id"]]
        player["trade_projection"] = model
        player["custom_projection"] = model
        player["espn_projected_fantasy_points"] = player.get("projected_fantasy_points")
        if _number(model.get("our_projection")):
            player["projected_fantasy_points"] = model["our_projection"]
            player["trade_projection_source"] = "custom_projection_engine"
        else:
            player["trade_projection_source"] = "ESPN projection or season-average fallback"
    rules = service.recommendation_settings()
    return week, my, other, normalized, rules, source_status


def _team_state(team, players, rules, week):
    roster = [player for player in players if player.get("fantasy_team_id") == team["team_id"]]
    # League-wide search evaluates many packages against the same untouched
    # baseline rosters. Cache those immutable states for this one request; each
    # distinct post-trade roster still goes through the same lineup optimizer.
    state_cache = team.get("_trade_state_cache")
    state_key = (team["team_id"], tuple(sorted(player["player_id"] for player in roster)))
    if state_cache is not None and state_key in state_cache:
        return state_cache[state_key]
    lineup = optimize_lineup(roster, rules["position_slot_counts"], week)
    starter_ids = {player["player_id"] for player in lineup["starters"]}
    positions = {}
    comparisons = []
    for row in team.get("_league_rosters") or [team]:
        if row.get("team_id") == team["team_id"]:
            comparisons.append({**row, "roster": roster})
        else:
            comparisons.append(row)
    league_comparison = team.get("_roster_need_context") or roster_needs(
        comparisons, team["team_id"], rules["position_slot_counts"], week)
    for position in ("QB", "RB", "WR", "TE", "K", "D/ST"):
        group = [player for player in roster if player.get("position") == position]
        starters = [player for player in lineup["starters"] if player.get("position") == position]
        bench_values = [float(player["trade_projection"]["our_projection"]) for player in group
                        if player["player_id"] not in starter_ids and _number((player.get("trade_projection") or {}).get("our_projection"))]
        starter_values = [float(player["trade_projection"]["our_projection"]) for player in starters
                          if _number((player.get("trade_projection") or {}).get("our_projection"))]
        values = [player.get("trade_projection", {}).get("our_projection") for player in group]
        values = [float(value) for value in values if _number(value)]
        need = max(0, int(rules["position_slot_counts"].get(position, 0)) - len(starters))
        positions[position] = {"rostered": len(group), "starting_slots": int(rules["position_slot_counts"].get(position, 0)),
                               "projected_starters": len(starters), "available_depth": max(0, len(group) - len(starters)),
                               "average_projection": round(sum(values) / len(values), 2) if values else None,
                               "replacement_projection": max(bench_values) if bench_values else None,
                               "replacement_value": round(min(starter_values) - max(bench_values), 2) if starter_values and bench_values else None,
                               "need": need, "strength": league_comparison.get(position, {}).get("label", "Unavailable"),
                               "league_comparison": league_comparison.get(position)}
    projected_total = sum(player["expected_points"] for player in lineup["starters"]
                          if _number(player.get("expected_points")))
    result = {"roster": roster, "lineup": lineup, "starter_ids": starter_ids,
              "projected_starting_total": round(projected_total, 2), "positions": positions}
    if state_cache is not None:
        state_cache[state_key] = result
    return result


def _remaining_weeks_value(player, service, week):
    average, _source = _ros_expected_rate(player, week)
    if not _number(average):
        return None, 0
    schedule = player.get("future_nfl_schedule")
    if not isinstance(schedule, list):
        return None, 0
    # Count real ESPN schedule games in the remaining season; the per-game
    # estimate is grounded in recommendation/history data, not extrapolated
    # from a bye-week zero.
    first = max(week, service.league.current_week + 1)
    count = len([game for game in schedule if _number(game.get("week")) and game["week"] >= first])
    return round(float(average) * count, 2), count


def _ros_expected_rate(player, week):
    """Use current recommendation evidence for ROS, excluding a bye-week forecast.

    The custom projection is a one-week estimate, so for a player's bye week it
    is not extrapolated into future weeks. Instead, season scoring and the
    model's available recent averages anchor the estimate. In other weeks the
    existing confidence-aware recommendation estimate combines the raw custom
    projection with ESPN and actual production references.
    """
    if player.get("bye_week") != week:
        from recommendation_service import confidence_aware_value
        estimate, _source, _explanation = confidence_aware_value(player)
        if _number(estimate):
            return float(estimate), "confidence-aware custom/ESPN/history estimate"
    model = player.get("trade_projection") or player.get("custom_projection") or {}
    references = [value for value in (
        player.get("season_fantasy_average"),
        model.get("recent_3_game_average"),
        model.get("recent_5_game_average"),
    ) if _number(value)]
    if references:
        return sum(float(value) for value in references) / len(references), "season and recent actual scoring"
    estimate = model.get("our_projection")
    return (float(estimate), "custom projection fallback") if _number(estimate) else (None, None)


def _rest_of_season_value_fit(service, week, players, give_ids, receive_ids):
    """Compare exchanged real ROS values using schedule, projection and history.

    Per-game value uses the existing confidence-aware recommendation estimate
    when the selected week is not a bye; bye-week players use their season and
    recent actual scoring instead. Remaining games come from ESPN's schedule,
    and the uncertainty band uses the existing custom-model standard deviation.
    """
    by_id = {player["player_id"]: player for player in players}
    give_value = receive_value = variance = 0.0
    for sign, player_ids in ((-1, give_ids), (1, receive_ids)):
        for player_id in player_ids:
            player = by_id.get(player_id)
            if not player:
                return {"supported": False, "within_uncertainty": False}
            value, games = _remaining_weeks_value(player, service, week)
            model = player.get("trade_projection") or player.get("custom_projection") or {}
            sd = model.get("standard_deviation")
            if value is None or not games or not _number(sd) or sd < 0:
                return {"supported": False, "within_uncertainty": False}
            if sign < 0:
                give_value += value
            else:
                receive_value += value
            variance += float(sd) ** 2 * games
    difference = receive_value - give_value
    uncertainty = math.sqrt(variance)
    return {"supported": True, "within_uncertainty": abs(difference) <= uncertainty,
            "give_value": round(give_value, 2), "receive_value": round(receive_value, 2),
            "difference": round(difference, 2), "uncertainty": round(uncertainty, 2),
            "method": "Confidence-aware custom/ESPN/history estimate × remaining scheduled games; bye-week estimates use season and recent actual scoring. Combined custom-model standard deviation × √games."}


def _value_above_replacement(service, week, before_state, after_state, players, give_ids, receive_ids):
    """Measure the trade against this roster's next usable player at each position.

    A position's replacement rate is the best non-starter already available on
    the user's roster, using the same ROS estimate as the traded assets. This is a roster-specific replacement level,
    rather than a league-wide fixed RB/WR premium. A two-for-one is valued as
    one incoming asset plus the replacement-level roster spot created by the
    consolidation, through the per-player value-above-replacement arithmetic.
    """
    by_id = {player["player_id"]: player for player in players}
    relevant_positions = {by_id[player_id].get("position") for player_id in give_ids + receive_ids
                          if player_id in by_id}
    replacement_levels = {}
    position_reports = {}

    def usable(player):
        status = str(player.get("injury_status") or "").upper().replace(" ", "_")
        return (status not in {"OUT", "DOUBTFUL", "IR", "INJURED_RESERVE", "SUSPENDED", "PUP"}
                and player.get("lineup_status") not in {"reserve", "IR", "ER"})

    def rate(player):
        return _ros_expected_rate(player, week)

    for position in relevant_positions:
        if not position:
            continue
        candidates = [player for player in before_state["roster"]
                      if player.get("position") == position
                      and player["player_id"] not in before_state["starter_ids"]
                      and player["player_id"] not in give_ids
                      and usable(player)]
        candidates_with_rate = [(rate(player)[0], player, rate(player)[1])
                                for player in candidates if rate(player)[0] is not None]
        if not candidates_with_rate:
            continue
        replacement_rate, replacement_player, source = max(candidates_with_rate, key=lambda row: row[0])
        replacement_levels[position] = {"player_id": replacement_player["player_id"],
                                        "player_name": replacement_player.get("name"),
                                        "points_per_game": round(replacement_rate, 2),
                                        "source": source}

    def position_value(state, position, baseline_rate):
        total = 0.0
        unavailable_players = 0
        players_in_position = [player for player in state["roster"] if player.get("position") == position]
        for player in players_in_position:
            raw_value, games = _remaining_weeks_value(player, service, week)
            if raw_value is None or games <= 0:
                # Unchanged roster players cancel in before/after comparison.
                # Do not discard an otherwise supported trade because an
                # unrelated teammate has no schedule or season-average data.
                unavailable_players += 1
                continue
            total += raw_value - baseline_rate * games
        return round(total, 2), unavailable_players

    all_supported = all(
        _remaining_weeks_value(by_id[player_id], service, week)[0] is not None
        and _remaining_weeks_value(by_id[player_id], service, week)[1] > 0
        for player_id in give_ids + receive_ids if player_id in by_id
    )
    before_total = after_total = 0.0
    for position in relevant_positions:
        if position not in replacement_levels:
            all_supported = False
            continue
        baseline = replacement_levels[position]["points_per_game"]
        before_value, before_unavailable = position_value(before_state, position, baseline)
        after_value, after_unavailable = position_value(after_state, position, baseline)
        before_total += before_value
        after_total += after_value
        position_reports[position] = {"before_value_above_replacement": before_value,
                                      "after_value_above_replacement": after_value,
                                      "change": round(after_value - before_value, 2),
                                      "players_without_ros_data": max(before_unavailable, after_unavailable),
                                      "replacement": replacement_levels[position]}

    if not all_supported:
        return {"supported": False, "method": "Roster-specific replacement values require a usable same-position bench player and remaining-season schedule data.",
                "positions": position_reports, "replacement_levels": replacement_levels}
    variance = 0.0
    traded_variance_supported = True
    for player_id in give_ids + receive_ids:
        player = by_id.get(player_id) or {}
        model = player.get("trade_projection") or {}
        sd = model.get("standard_deviation")
        _value, games = _remaining_weeks_value(player, service, week)
        if not _number(sd) or not games:
            traded_variance_supported = False
            continue
        variance += float(sd) ** 2 * games
    position_coefficients = {}
    for player_id in receive_ids:
        position = by_id[player_id].get("position")
        position_coefficients[position] = position_coefficients.get(position, 0) + 1
    for player_id in give_ids:
        position = by_id[player_id].get("position")
        position_coefficients[position] = position_coefficients.get(position, 0) - 1
    replacement_variance_supported = True
    for position, coefficient in position_coefficients.items():
        if not coefficient:
            continue
        replacement = replacement_levels[position]
        player = by_id[replacement["player_id"]]
        sd = (player.get("trade_projection") or {}).get("standard_deviation")
        _value, games = _remaining_weeks_value(player, service, week)
        if not _number(sd) or not games:
            replacement_variance_supported = False
            continue
        variance += coefficient ** 2 * float(sd) ** 2 * games
    return {"supported": True, "before": round(before_total, 2), "after": round(after_total, 2),
            "difference": round(after_total - before_total, 2), "positions": position_reports,
            "replacement_levels": replacement_levels,
            "uncertainty": round(math.sqrt(variance), 2) if traded_variance_supported and replacement_variance_supported else None,
            "method": "For each affected position, compare remaining-season value with the best usable same-position bench option on your roster. This measures value beyond the next player you could use; in a consolidation, it also accounts for the replacement-level roster spot you open."}


def _worth_it_verdict(weekly_delta, value_fit, replacement_fit, position_improved, depth_impact, risk):
    """Classify the user's side from expected value and its measured uncertainty.

    One- and two-standard-deviation bands come from the traded players'
    existing modeled uncertainty. The weekly change and rest-of-season
    value-above-replacement change are kept in point units and combined once;
    the replacement comparison avoids counting a replaceable bench player's
    full production as lost value.
    """
    value_delta = (replacement_fit.get("difference") if replacement_fit.get("supported")
                   else value_fit.get("difference"))
    uncertainty = replacement_fit.get("uncertainty") if replacement_fit.get("supported") else None
    if not _number(uncertainty):
        uncertainty = value_fit.get("uncertainty") if value_fit.get("supported") else None
    uncertainty_available = _number(uncertainty)
    if not _number(value_delta):
        value_delta = 0.0
    net_value = float(weekly_delta or 0.0) + float(value_delta)
    if uncertainty_available:
        uncertainty = float(uncertainty)
        if net_value > 2 * uncertainty:
            worth = "YES"
        elif net_value > uncertainty:
            worth = "LEAN YES"
        elif net_value >= -uncertainty:
            worth = "EVEN"
        elif net_value > -2 * uncertainty:
            worth = "LEAN NO"
        else:
            worth = "NO"
    elif net_value > 0:
        # Missing uncertainty is not evidence that the estimate is precise.
        worth = "LEAN YES"
    elif net_value < 0:
        worth = "LEAN NO"
    else:
        worth = "EVEN"

    if uncertainty_available and -uncertainty <= net_value <= uncertainty:
        weak_position_depth_gain = any(
            change.get("usable_depth_change", 0) > 0
            and change.get("strength_before") in {"Weak", "Weak depth", "Needs improvement"}
            for change in depth_impact.values())
        weak_position_depth_loss = any(
            change.get("usable_depth_change", 0) < 0
            and change.get("strength_before") in {"Weak", "Weak depth", "Needs improvement"}
            for change in depth_impact.values())
        if net_value > 0 and (position_improved or weak_position_depth_gain):
            worth = "LEAN YES"
        elif net_value < 0 and weak_position_depth_loss:
            worth = "LEAN NO"

    risky_incoming = any(str(item.get("injury_status") or "").upper().replace(" ", "_")
                         in {"QUESTIONABLE", "DOUBTFUL", "OUT", "IR", "INJURED_RESERVE", "PUP"}
                         for item in risk.get("you_receive", []))
    # A notable unresolved health flag makes the top verdict cautious without
    # guessing a return date or changing any projection/confidence calculation.
    if risky_incoming and worth == "YES":
        worth = "LEAN YES"

    if worth in {"YES", "LEAN YES"}:
        phrases = []
        if abs(float(weekly_delta or 0.0)) <= 0.5:
            phrases.append("Your best starting lineup is unchanged this week")
        elif weekly_delta > 0:
            phrases.append(f"Your best starting lineup gains about {weekly_delta:+.1f} points this week")
        else:
            phrases.append(f"Your best starting lineup gives up about {abs(weekly_delta):.1f} points this week")
        if replacement_fit.get("supported"):
            phrases.append(f"The trade adds about {replacement_fit['difference']:+.1f} points above your current same-position replacements over the rest of the season")
        elif value_fit.get("supported"):
            phrases.append(f"The rest-of-season player-value estimate changes {value_fit['difference']:+.1f} points")
        if position_improved:
            phrases.append(f"It improves your {', '.join(position_improved)} depth")
        worth_reason = ". ".join(phrases) + "."
        depth_changes = [(position, change["usable_depth_change"])
                         for position, change in depth_impact.items()
                         if change["usable_depth_change"]]
        depth_notes = ([f"adds {change} usable {position} option{'s' if change != 1 else ''}"
                        for position, change in depth_changes if change > 0]
                       + [f"leaves {abs(change)} fewer usable {position} option{'s' if change != -1 else ''}"
                          for position, change in depth_changes if change < 0])
        if depth_notes:
            worth_reason += " It also " + " and ".join(depth_notes) + "."
        if risky_incoming:
            worth_reason += " The incoming player's status makes this a cautious lean."
    elif worth == "EVEN":
        worth_reason = "The expected gain is within the players' uncertainty, so neither side has a clear value edge."
    else:
        if replacement_fit.get("supported"):
            worth_reason = (f"After accounting for your same-position replacements, the trade changes your rest-of-season value by about "
                            f"{replacement_fit['difference']:+.1f} points; the current-week lineup change is {weekly_delta:+.1f} points.")
        else:
            worth_reason = (f"Your best starting lineup changes by {weekly_delta:+.1f} points this week and the rest-of-season value estimate changes "
                            f"{value_fit.get('difference', 0):+.1f} points.")
    return worth, worth_reason, {"expected_value_change": round(net_value, 2),
                                 "uncertainty_band": round(float(uncertainty), 2) if uncertainty_available else None,
                                 "value_above_replacement_change": round(float(value_delta), 2),
                                 "position_improved": position_improved,
                                 "depth_change": depth_impact}


def _trade_result(service, week, own, other, players, rules, give_ids, receive_ids):
    own_state = _team_state(own, players, rules, week)
    other_state = _team_state(other, players, rules, week)
    own_after_roster = ([p for p in own_state["roster"] if p["player_id"] not in give_ids]
                        + [{**p, "fantasy_team_id": own["team_id"]} for p in other_state["roster"] if p["player_id"] in receive_ids])
    other_after_roster = ([p for p in other_state["roster"] if p["player_id"] not in receive_ids]
                          + [{**p, "fantasy_team_id": other["team_id"]} for p in own_state["roster"] if p["player_id"] in give_ids])
    own_after = _team_state({**own, "roster": own_after_roster}, own_after_roster, rules, week)
    other_after = _team_state({**other, "roster": other_after_roster}, other_after_roster, rules, week)
    own_delta = round(own_after["projected_starting_total"] - own_state["projected_starting_total"], 2)
    other_delta = round(other_after["projected_starting_total"] - other_state["projected_starting_total"], 2)
    by_id = {player["player_id"]: player for player in players}
    give = [by_id[item] for item in give_ids]
    receive = [by_id[item] for item in receive_ids]
    def ros(items):
        result, available = 0.0, True
        games = 0
        for player in items:
            value, count = _remaining_weeks_value(player, service, week)
            if value is None:
                available = False
            else:
                result += value
                games += count
        return round(result, 2) if available else None, games
    all_ros = lambda roster: ros(roster)
    own_before_ros, _ = all_ros(own_state["roster"])
    own_after_ros, _ = all_ros(own_after_roster)
    other_before_ros, _ = all_ros(other_state["roster"])
    other_after_ros, _ = all_ros(other_after_roster)
    def ros_delta(before, after):
        return round(after - before, 2) if before is not None and after is not None else None
    def player_info(player):
        model = player.get("trade_projection") or {}
        return {"player_id": player["player_id"], "name": player["name"], "position": player.get("position"),
                "nfl_team": player.get("nfl_team"), "headshot_url": player.get("headshot_url"),
                "nfl_team_id": player.get("nfl_team_id"), "nfl_team_logo_url": player.get("nfl_team_logo_url"),
                "weekly_projection": model.get("our_projection"), "espn_projection": player.get("espn_projected_fantasy_points"),
                "season_average": player.get("season_fantasy_average"), "confidence": model.get("confidence"),
                "uncertainty": model.get("standard_deviation"), "bye_week": player.get("bye_week"),
                "injury_status": player.get("injury_status"), "lineup_slot": player.get("lineup_slot"),
                "trade_projection_source": player.get("trade_projection_source")}
    def positional_impact(before, after):
        return {position: {"before_depth": before["positions"][position]["rostered"],
                           "after_depth": after["positions"][position]["rostered"],
                           "before_strength": before["positions"][position]["strength"],
                           "after_strength": after["positions"][position]["strength"],
                           "before_usable_depth": before["positions"][position]["available_depth"],
                           "after_usable_depth": after["positions"][position]["available_depth"],
                           "starting_slots": before["positions"][position]["starting_slots"],
                           "before_starting_projection": before["positions"][position]["average_projection"],
                           "after_starting_projection": after["positions"][position]["average_projection"]}
                for position in before["positions"]}
    def affected_slots(before, after):
        old = {item["player_id"]: item.get("recommended_slot") for item in before["lineup"]["starters"]}
        new = {item["player_id"]: item.get("recommended_slot") for item in after["lineup"]["starters"]}
        return [{"player_id": pid, "player_name": (by_id.get(pid) or {}).get("name"), "before": old.get(pid), "after": new.get(pid)}
                for pid in old.keys() | new.keys() if old.get(pid) != new.get(pid)]
    def bye_conflicts(roster, incoming):
        conflicts = []
        for player in incoming:
            bye = player.get("bye_week")
            if not _number(bye):
                continue
            same_position = [item for item in roster if item.get("position") == player.get("position")
                             and item.get("bye_week") == bye and item["player_id"] != player["player_id"]]
            if same_position:
                conflicts.append({"incoming_player": player["name"], "position": player.get("position"),
                                  "bye_week": bye, "same_position_players_on_bye": [item["name"] for item in same_position]})
        return conflicts
    result = {
        "week": week, "my_team": {"team_id": own["team_id"], "team_name": own["team_name"]},
        "other_team": {"team_id": other["team_id"], "team_name": other["team_name"]},
        "you_give": [player_info(p) for p in give], "you_receive": [player_info(p) for p in receive],
        "weekly_lineup_change": {"you": own_delta, "other_team": other_delta,
            "you_before": own_state["projected_starting_total"], "you_after": own_after["projected_starting_total"],
            "other_before": other_state["projected_starting_total"], "other_after": other_after["projected_starting_total"],
            "you_starting_lineup_after": [player_info(p) | {"recommended_slot": p.get("recommended_slot")} for p in own_after["lineup"]["starters"]],
            "other_starting_lineup_after": [player_info(p) | {"recommended_slot": p.get("recommended_slot")} for p in other_after["lineup"]["starters"]]},
        "rest_of_season_change": {"you": ros_delta(own_before_ros, own_after_ros), "other_team": ros_delta(other_before_ros, other_after_ros),
            "you_before": own_before_ros, "you_after": own_after_ros,
            "other_team_before": other_before_ros, "other_team_after": other_after_ros,
            "method": "Confidence-aware custom/ESPN/history estimates × ESPN remaining schedule; bye-week estimates use season and recent actual scoring."},
        "positional_impact": {"you": positional_impact(own_state, own_after), "other_team": positional_impact(other_state, other_after)},
        "affected_starting_lineup_slots": {"you": affected_slots(own_state, own_after), "other_team": affected_slots(other_state, other_after)},
        "depth_impact": {"you": {position: {"before": own_state["positions"][position]["strength"],
                                                       "after": own_after["positions"][position]["strength"],
                                                       "usable_before": own_state["positions"][position]["available_depth"],
                                                       "usable_after": own_after["positions"][position]["available_depth"]}
                                     for position in own_after["positions"]},
                         "other_team": {position: {"before": other_state["positions"][position]["strength"],
                                                              "after": other_after["positions"][position]["strength"],
                                                              "usable_before": other_state["positions"][position]["available_depth"],
                                                              "usable_after": other_after["positions"][position]["available_depth"]}
                                        for position in other_after["positions"]}},
        "risk": {"you_give": [{"name": p["name"], "confidence": (p.get("trade_projection") or {}).get("confidence"), "standard_deviation": (p.get("trade_projection") or {}).get("standard_deviation"), "injury_status": p.get("injury_status")} for p in give],
                 "you_receive": [{"name": p["name"], "confidence": (p.get("trade_projection") or {}).get("confidence"), "standard_deviation": (p.get("trade_projection") or {}).get("standard_deviation"), "injury_status": p.get("injury_status")} for p in receive]},
        "bye_week_implications": {"you_receive": [{"name": p["name"], "position": p.get("position"), "bye_week": p.get("bye_week")} for p in receive],
                                  "you_give": [{"name": p["name"], "position": p.get("position"), "bye_week": p.get("bye_week")} for p in give],
                                  "you_conflicts": bye_conflicts(own_state["roster"], receive),
                                  "other_team_conflicts": bye_conflicts(other_state["roster"], give)},
        "team_strength_before": {"you": own_state["positions"], "other_team": other_state["positions"]},
        "model": "The current-week effect re-optimizes each actual ESPN roster under the league's eligible lineup slots using the custom projection when available, then ESPN projection or season average as disclosed fallback. Bench players count only if they enter the optimized lineup. No trade is submitted to ESPN.",
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }
    own_ros = result["rest_of_season_change"]["you"]
    other_ros = result["rest_of_season_change"]["other_team"]
    value_fit = _rest_of_season_value_fit(service, week, players, give_ids, receive_ids)
    result["rest_of_season_value_fit"] = value_fit
    replacement_fit = _value_above_replacement(service, week, own_state, own_after, players, give_ids, receive_ids)
    result["value_above_replacement"] = replacement_fit
    uncertainty_values = [player.get("uncertainty") for player in give + receive]
    weekly_uncertainty = (round(math.sqrt(sum(float(value) ** 2 for value in uncertainty_values)), 2)
                          if uncertainty_values and all(_number(value) for value in uncertainty_values) else None)
    own_position_improved = [position for position, change in result["positional_impact"]["you"].items()
                             if change["after_strength"] in {"Average", "Strong"}
                             and change["before_strength"] in {"Weak", "Weak depth", "Needs improvement"}]
    other_position_improved = [position for position, change in result["positional_impact"]["other_team"].items()
                               if change["after_strength"] in {"Average", "Strong"}
                               and change["before_strength"] in {"Weak", "Weak depth", "Needs improvement"}]
    own_depth_change = {position: {"usable_depth_change": change["after_usable_depth"] - change["before_usable_depth"],
                                   "strength_before": change["before_strength"],
                                   "strength_after": change["after_strength"]}
                        for position, change in result["positional_impact"]["you"].items()}
    worth, worth_reason, worth_details = _worth_it_verdict(
        own_delta, value_fit, replacement_fit, own_position_improved, own_depth_change, result["risk"])
    if other_delta >= 1 and (other_ros is None or other_ros >= 0) and other_position_improved:
        acceptance, acceptance_reason = "HIGH", f"Their best starting lineup gains about {other_delta:+.1f} points per week, and they add help at {', '.join(other_position_improved)}."
    elif other_delta >= 0 and (other_ros is None or other_ros >= 0):
        acceptance, acceptance_reason = "MEDIUM", f"Their best lineup stays close ({other_delta:+.1f} points per week), and the offer gives them useful depth."
    elif other_delta >= -1 and other_position_improved and (other_ros is None or other_ros >= -ros_neutral_band):
        acceptance, acceptance_reason = "MEDIUM", f"Their best lineup changes very little ({other_delta:+.1f} points per week), while the trade helps at {', '.join(other_position_improved)}."
    elif other_delta < -2 and (other_ros is None or other_ros < 0):
        acceptance, acceptance_reason = "VERY LOW", f"Their best starting lineup loses about {abs(other_delta):.1f} points per week, with no rest-of-season gain to make up for it."
    else:
        acceptance, acceptance_reason = "LOW", f"Their best lineup changes by {other_delta:+.1f} points per week" + (f"; rest-of-season estimate changes {other_ros:+.1f}." if other_ros is not None else "; rest-of-season value is unavailable.")
    result["verdict"] = {
        "worth_it": worth, "worth_it_reason": worth_reason,
        "acceptance_likelihood": acceptance, "acceptance_reason": acceptance_reason,
        "weekly_uncertainty": weekly_uncertainty,
        "worth_it_breakdown": worth_details,
        "method": "Your verdict combines this week's legal-lineup change with rest-of-season value above your best same-position bench replacement. One- and two-standard-deviation bands use the traded players' existing projection uncertainty. Roster need/depth describes fit; acceptance is calculated separately from the other manager's lineup, rest-of-season change, and position needs. Acceptance likelihood is a roster-fit category, not a probability or a claim about manager behavior, and it is not part of your verdict.",
    }
    return result


def analyze(service, request: dict):
    selected = request.get("week")
    week, own, other, players, rules, _status = _prepare(service, request["team_id"], selected)
    own_ids = {p["player_id"] for p in players if p["fantasy_team_id"] == own["team_id"]}
    other_ids = {p["player_id"] for p in players if p["fantasy_team_id"] == other["team_id"]}
    give = list(dict.fromkeys(request["give_player_ids"]))
    receive = list(dict.fromkeys(request["receive_player_ids"]))
    if (len(give) != len(request["give_player_ids"]) or len(receive) != len(request["receive_player_ids"])
            or set(give) & set(receive) or not set(give) <= own_ids or not set(receive) <= other_ids):
        raise APIError(422, "invalid_trade_players", "Select unique players from your roster to give and the chosen team's roster to receive.")
    return _trade_result(service, week, own, other, players, rules, give, receive)


def _trade_position_set(position=None, positions=None):
    if positions is not None:
        supplied = positions
    elif isinstance(position, str):
        supplied = [position] if position else None
    elif position is not None:
        supplied = list(position)
    else:
        supplied = None
    if supplied is None or any(str(item).upper() == "ALL" for item in supplied):
        return None
    expanded = set()
    for item in supplied:
        normalized = str(item).upper()
        if normalized == "FLEX":
            expanded.update({"RB", "WR", "TE"})
        elif normalized in {"QB", "RB", "WR", "TE", "K", "D/ST"}:
            expanded.add(normalized)
    return expanded


def _matches_trade_positions(player, selected_positions):
    return selected_positions is None or player.get("position") in selected_positions


def suggestions(service, team_id: int, mode: str, selected: int | None, positions=None):
    week, own, other, players, rules, _status = _prepare(service, team_id, selected)
    selected_positions = _trade_position_set(positions=positions)
    league_rosters = []
    own_roster = [player for player in players if player.get("fantasy_team_id") == own["team_id"]]
    other_roster = [player for player in players if player.get("fantasy_team_id") == other["team_id"]]
    for row in own.get("_league_rosters") or [own, other]:
        if row.get("team_id") == own["team_id"]:
            league_rosters.append({**row, "roster": own_roster})
        elif row.get("team_id") == other["team_id"]:
            league_rosters.append({**row, "roster": other_roster})
        else:
            league_rosters.append(row)
    state_cache = own.get("_trade_state_cache", {})
    for row in league_rosters:
        row["_trade_state_cache"] = state_cache
    own_needs = roster_needs(league_rosters, own["team_id"], rules["position_slot_counts"], week)
    other_needs = roster_needs(league_rosters, other["team_id"], rules["position_slot_counts"], week)
    own["_roster_need_context"] = own_needs
    other["_roster_need_context"] = other_needs
    own_state, other_state = _team_state(own, players, rules, week), _team_state(other, players, rules, week)
    own_weak = {position for position, row in own_needs.items() if row.get("label") in {"Weak", "Weak depth", "Needs improvement"}}
    own_strong = {position for position, row in own_needs.items() if row.get("label") == "Strong"}
    other_weak = {position for position, row in other_needs.items() if row.get("label") in {"Weak", "Weak depth", "Needs improvement"}}
    other_strong = {position for position, row in other_needs.items() if row.get("label") == "Strong"}
    targets = [p for p in other_state["roster"] if p.get("position") in own_weak and p.get("position") in other_strong
               and _matches_trade_positions(p, selected_positions)]
    partner_assets = [p for p in own_state["roster"] if p.get("position") in other_weak and p.get("position") in own_strong]
    own_surplus = [p for p in own_state["roster"] if p.get("lineup_status") != "reserve"]
    other_surplus = [p for p in other_state["roster"] if p.get("lineup_status") != "reserve"]
    def candidate_key(p):
        return (p.get("trade_projection", {}).get("confidence") == "high",
                p.get("trade_projection", {}).get("our_projection") is not None,
                p.get("trade_projection", {}).get("our_projection") or -999)
    own_surplus.sort(key=candidate_key, reverse=True)
    other_surplus.sort(key=candidate_key, reverse=True)
    base = {p["player_id"]: p for p in players}
    own_candidates = own_surplus[:12]
    other_candidates = other_surplus[:12]
    found = []
    for giving in own_candidates:
        for receiving in other_candidates:
            if not _matches_trade_positions(receiving, selected_positions):
                continue
            result = _trade_result(service, week, own, other, players, rules, [giving["player_id"]], [receiving["player_id"]])
            you_delta = result["weekly_lineup_change"]["you"]
            their_delta = result["weekly_lineup_change"]["other_team"]
            if you_delta is None or their_delta is None:
                continue
            if mode == "conservative" and (you_delta < 0.5 or their_delta < 0.5):
                continue
            if mode == "balanced" and (you_delta <= 0 or their_delta <= 0):
                continue
            if mode == "aggressive" and (you_delta < -2 or their_delta < -2 or max(you_delta, their_delta) < 2):
                continue
            # Candidates must improve actual optimized lineups for both sides;
            # exchanging two starters is allowed only when the replacement fits better.
            if you_delta <= 0 or their_delta <= 0:
                continue
            value_fit = _rest_of_season_value_fit(service, week, players,
                                                  [player["player_id"] for player in result["you_give"]],
                                                  [player["player_id"] for player in result["you_receive"]])
            if not value_fit["supported"] or not value_fit["within_uncertainty"]:
                continue
            result["rest_of_season_value_fit"] = value_fit
            result["plausibility"] = ("High" if abs(value_fit["difference"]) <= value_fit["uncertainty"] * 0.5
                                      else "Medium")
            result["plausibility_basis"] = (f"Rest-of-season player value difference {abs(value_fit['difference']):.1f} "
                                            f"is within the combined modeled uncertainty {value_fit['uncertainty']:.1f} points.")
            result["suggestion_reason"] = (f"Both teams' ESPN lineups were re-optimized with custom projections where available. "
                                            f"The move changes projected starters by {you_delta:+.2f} for your team and {their_delta:+.2f} for {other['team_name']}; "
                                            "the trade is shown only when both lineups improve and exchanged rest-of-season value is within modeled uncertainty.")
            result["mode"] = mode
            found.append(result)
    found.sort(key=lambda item: (min(item["weekly_lineup_change"]["you"], item["weekly_lineup_change"]["other_team"]),
                                 sum(item["weekly_lineup_change"][key] for key in ("you", "other_team"))), reverse=True)
    return {"week": week, "mode": mode, "my_team": own["team_name"], "other_team": other["team_name"],
            "last_updated": datetime.now(timezone.utc).isoformat(), "suggestions": found[:5],
            "roster_needs": {"you": own_needs, "other_team": other_needs},
            "best_trade_targets": [{"player_id": p["player_id"], "name": p["name"], "position": p.get("position"),
                                    "team": p.get("nfl_team"), "reason": f"Your {p.get('position')} group is below league comparison while {other['team_name']} has above-median depth there."}
                                   for p in targets[:8]],
            "best_trade_partners": [{"player_id": p["player_id"], "name": p["name"], "position": p.get("position"),
                                     "team": p.get("nfl_team"), "reason": f"{other['team_name']} has a measured {p.get('position')} need and your roster has depth in that group."}
                                    for p in partner_assets[:8]],
            "message": None if found else f"No {mode} one-for-one trade met the evidence and lineup-fit criteria for both teams. No trade was sent to ESPN."}


def league_targets(service, selected: int | None, position: str | None = None,
                   include_research_ideas: bool = False, target_player_ids=None,
                   positions=None, target_team_id: int | None = None):
    week = service.week(selected)
    ttl = 25 if week == service.league.current_week else 180
    target_ids = tuple(sorted({int(player_id) for player_id in (target_player_ids or [])}))
    selected_positions = _trade_position_set(position, positions)
    position_key = tuple(sorted(selected_positions)) if selected_positions is not None else None
    key = ("league_trade_discovery", week, position_key, bool(include_research_ideas), target_ids, target_team_id)
    return service.memoized(key, ttl, lambda: _build_league_targets(
        service, week, position_key, include_research_ideas, target_ids, target_team_id))


def _build_league_targets(service, week: int, position: str | None = None,
                          include_research_ideas: bool = False, target_player_ids=(),
                          target_team_id: int | None = None):
    """Evaluate plausible one-for-one target packages across every league roster.

    This batches the real ESPN player cards and custom projection work once,
    then sends each package through the same lineup-aware _trade_result used by
    the manual analyzer and existing suggestion endpoint.
    """
    from projection_sources.espn import league_projection_payload

    matchups = service.fantasy_matchups(week)
    my_id = matchups["my_team_id"]
    team_rows = {}
    for matchup in matchups["fantasy_matchups"]:
        for side in ("home_team", "away_team"):
            row = matchup.get(side)
            if row and row.get("roster") is not None:
                team_rows[row["team_id"]] = row
    if target_team_id is not None and target_team_id not in team_rows:
        raise APIError(404, "trade_team_not_found", "The selected fantasy team was not found for this week.")
    own = team_rows.get(my_id)
    if not own:
        raise APIError(502, "trade_roster_unavailable", "ESPN did not provide your roster for trade target analysis.")

    projection_data = league_projection_payload(service, week)
    normalized = []
    for record in projection_data.get("players", []):
        player = dict(record.get("player") or {})
        model = record.get("projection") or {}
        player["trade_projection"] = model
        player["custom_projection"] = model
        player["espn_projected_fantasy_points"] = player.get("projected_fantasy_points")
        if _number(model.get("our_projection")):
            player["projected_fantasy_points"] = model["our_projection"]
            player["trade_projection_source"] = "custom_projection_engine"
        else:
            player["trade_projection_source"] = "ESPN projection or season-average fallback"
        normalized.append(player)
    source_status = projection_data.get("source_status", {})

    rules = service.recommendation_settings()
    league_rosters = [{**team, "roster": [p for p in normalized if p.get("fantasy_team_id") == team_id]}
                      for team_id, team in team_rows.items()]
    state_cache = {}
    for row in team_rows.values():
        row["_trade_state_cache"] = state_cache
    for row in league_rosters:
        row["_trade_state_cache"] = state_cache
    own_state = _team_state(own, normalized, rules, week)
    own_needs = roster_needs(league_rosters, my_id, rules["position_slot_counts"], week)
    own_weak = {pos for pos, row in own_needs.items() if row.get("label") in {"Weak", "Weak depth", "Needs improvement"}}
    own_strong = {pos for pos, row in own_needs.items() if row.get("label") == "Strong"}
    # K/DST roster depth is useful for waiver/streaming advice, but rarely
    # creates a credible proactive trade target. Keep trade discovery focused
    # on positions where a real player-for-player package can improve both
    # optimized lineups.
    eligible_target_positions = {"QB", "RB", "WR", "TE"}
    # Do not manufacture a need for a second QB from roster count alone when
    # the user's healthy starter already meets or beats the league's real
    # projected-starter median. This follows the roster-needs analysis while
    # avoiding a low-value backup target for an elite, healthy starter.
    own_qb_starters = [p for p in own_state["lineup"]["starters"]
                       if p.get("position") == "QB" and str(p.get("injury_status") or "").upper()
                       not in {"OUT", "DOUBTFUL", "IR", "INJURED RESERVE"}
                       and p.get("bye_week") != week]
    league_qb_starters = []
    for roster in league_rosters:
        state = own_state if roster["team_id"] == my_id else _team_state(roster, normalized, rules, week)
        candidates = [p for p in state["lineup"]["starters"]
                      if p.get("position") == "QB"]
        if candidates:
            league_qb_starters.append(max(candidates, key=lambda player: float(player.get("expected_points") or -999)))
    if own_qb_starters and league_qb_starters:
        user_qb = max(own_qb_starters, key=lambda player: float(player.get("expected_points") or -999))
        source_keys = ("expected_points", "espn_projected_fantasy_points", "season_fantasy_average")
        healthy_qb_is_league_average_or_better = any(
            _number(user_qb.get(key))
            and (values := [float(player[key]) for player in league_qb_starters if _number(player.get(key))])
            and float(user_qb[key]) >= median(values)
            for key in source_keys
        )
        if healthy_qb_is_league_average_or_better:
            own_weak.discard("QB")
    if position is not None:
        eligible_target_positions = set(position) if not isinstance(position, str) else {position}
        eligible_target_positions &= {"QB", "RB", "WR", "TE", "K", "D/ST"}

    target_rows, suggestions_rows, partners, exploratory_rows = [], [], [], []
    research_rows = []
    by_id = {p["player_id"]: p for p in normalized}
    for other_id, other in team_rows.items():
        if other_id == my_id:
            continue
        if target_team_id is not None and other_id != target_team_id:
            continue
        other_needs = roster_needs(league_rosters, other_id, rules["position_slot_counts"], week)
        other["_league_rosters"] = league_rosters
        own["_league_rosters"] = league_rosters
        own["_roster_need_context"] = own_needs
        other["_roster_need_context"] = other_needs
        other_state = _team_state(other, normalized, rules, week)
        # A target can be tradable because the receiving manager has usable
        # depth, even when league-relative starter strength is only Average.
        # The shared lineup optimizer below is the final gate for both sides.
        target_pool = [p for p in other_state["roster"]
                       if (p.get("position") in (own_weak & eligible_target_positions)
                           or p.get("player_id") in target_player_ids)
                       and p.get("lineup_status") != "reserve"]
        give_pool = [p for p in own_state["roster"] if p.get("lineup_status") != "reserve"]
        target_pool.sort(key=lambda p: (p.get("player_id") in target_player_ids,
                                        bool((p.get("trade_projection") or {}).get("our_projection") is not None),
                                        (p.get("trade_projection") or {}).get("our_projection") or -999), reverse=True)
        give_pool.sort(key=lambda p: ((p.get("trade_projection") or {}).get("our_projection") is not None,
                                      (p.get("trade_projection") or {}).get("our_projection") or -999), reverse=True)
        candidates = []
        for receiving in target_pool[:10]:
            for giving in give_pool[:12]:
                result = _trade_result(service, week, own, other, normalized, rules,
                                       [giving["player_id"]], [receiving["player_id"]])
                you_delta = result["weekly_lineup_change"]["you"]
                their_delta = result["weekly_lineup_change"]["other_team"]
                if not (_number(you_delta) and _number(their_delta)):
                    continue
                value_fit = _rest_of_season_value_fit(service, week, normalized,
                                                      [player["player_id"] for player in result["you_give"]],
                                                      [player["player_id"] for player in result["you_receive"]])
                other_position = giving.get("position")
                incoming_fit = result["positional_impact"]["other_team"].get(other_position, {})
                other_need_improved = (incoming_fit.get("after_strength") in {"Average", "Strong"}
                                       and incoming_fit.get("before_strength") in {"Weak", "Weak depth", "Needs improvement"})
                other_ros_delta = result["rest_of_season_change"].get("other_team")
                if you_delta > 0 and their_delta > 0 and value_fit["supported"] and value_fit["within_uncertainty"]:
                    category = "IMMEDIATE WIN-WIN"
                    validation = "MODEL-VALIDATED TRADE"
                elif (you_delta > 0 and their_delta >= -0.5 and other_need_improved
                      and _number(other_ros_delta) and other_ros_delta >= 0):
                    category = "ROSTER-BALANCING"
                    validation = "POSSIBLE TRADE TO EXPLORE"
                elif (you_delta >= -0.5 and their_delta >= -0.5 and other_need_improved
                      and _number(other_ros_delta) and other_ros_delta > 0
                      and value_fit["supported"] and value_fit["within_uncertainty"]):
                    category = "UPSIDE TRADE"
                    validation = "POSSIBLE TRADE TO EXPLORE"
                else:
                    continue
                result["partner_team_id"] = other_id
                result["partner_team_name"] = other["team_name"]
                result["rest_of_season_value_fit"] = value_fit
                result["trade_category"] = category
                result["validation_type"] = validation
                result["plausibility"] = ("High" if abs(value_fit["difference"]) <= value_fit["uncertainty"] * 0.5
                                          else "Medium")
                result["plausibility_basis"] = (f"Rest-of-season player value difference {abs(value_fit['difference']):.1f} "
                                                f"is within the combined modeled uncertainty {value_fit['uncertainty']:.1f} points.")
                result["suggestion_reason"] = (f"Both real starting lineups improve after eligibility-aware optimization: "
                    f"{own['team_name']} {you_delta:+.2f} and {other['team_name']} {their_delta:+.2f} points per week.")
                candidates.append(result)
                exploratory_rows.append(result)
        candidates.sort(key=lambda item: (min(item["weekly_lineup_change"]["you"], item["weekly_lineup_change"]["other_team"]),
                                          sum(item["weekly_lineup_change"][side] for side in ("you", "other_team"))), reverse=True)
        for result in [row for row in candidates if row["trade_category"] == "IMMEDIATE WIN-WIN"][:5]:
            partners.append({"team_id": other_id, "team_name": other["team_name"],
                             "needs": other_needs, "best_weekly_fit": min(result["weekly_lineup_change"]["you"], result["weekly_lineup_change"]["other_team"])})
            receiving = result["you_receive"][0]
            their_need = other_needs.get(receiving.get("position"), {})
            me_need = own_needs.get(receiving.get("position"), {})
            min_delta = min(result["weekly_lineup_change"]["you"], result["weekly_lineup_change"]["other_team"])
            ros = result["rest_of_season_change"]
            plausible = (min_delta >= 1 and _number(ros.get("you")) and ros["you"] >= 0
                         and _number(ros.get("other_team")) and ros["other_team"] >= 0)
            result["plausibility"] = "High" if plausible else "Medium"
            result["plausibility_basis"] = "Both teams improve optimized weekly starters; high fit also requires nonnegative measured rest-of-season roster change for both teams." if plausible else "Both teams improve optimized weekly starters; one or both rest-of-season changes are unavailable or negative."
            result["target_reason"] = (f"Addresses your {receiving.get('position')} need ({me_need.get('label', 'league comparison')}); "
                                       f"{other['team_name']} receives {result['you_give'][0]['name']} and their optimized lineup changes {result['weekly_lineup_change']['other_team']:+.2f} points per week. "
                                       f"Their {result['you_give'][0].get('position')} comparison: {(other_needs.get(result['you_give'][0].get('position')) or {}).get('label', 'unavailable')}.")
            candidates_row = result
            suggestions_rows.append(candidates_row)
            target_rows.append({"player": receiving, "team_id": other_id, "team_name": other["team_name"],
                                "analysis": result, "reason": result["target_reason"]})

        if include_research_ideas:
            # League-wide discovery gets a bounded, broader candidate search than the
            # strict one-for-one target board. All proposals still run through
            # _trade_result, which re-optimizes both real ESPN rosters using
            # the league's eligible lineup slots and the same projections.
            requested_positions = (eligible_target_positions & {"QB", "RB", "WR", "TE"}
                                   if position is not None else
                                   (own_weak & {"QB", "RB", "WR", "TE"}) or {"RB", "WR", "TE"})
            desired_targets = [player for player in other_state["roster"]
                               if (player.get("position") in requested_positions
                                   or player.get("player_id") in target_player_ids)
                               and player.get("lineup_status") != "reserve"]
            desired_targets.sort(key=lambda player: (
                player.get("player_id") in target_player_ids,
                player.get("lineup_status") == "bench",
                (player.get("trade_projection") or {}).get("our_projection") is not None,
                (player.get("trade_projection") or {}).get("our_projection") or -999), reverse=True)
            if target_player_ids:
                explicit = [player for player in desired_targets if player.get("player_id") in target_player_ids]
                usual = [player for player in desired_targets if player.get("player_id") not in target_player_ids]
                desired_targets = explicit + usual[:max(0, 2-len(explicit))]
            else:
                desired_targets = desired_targets[:2]

            partner_weak = {pos for pos, row in other_needs.items()
                            if row.get("label") in {"Weak", "Weak depth", "Needs improvement"}}
            assets = [player for player in own_state["roster"] if player.get("lineup_status") != "reserve"]
            assets.sort(key=lambda player: (
                player.get("position") in partner_weak,
                player.get("lineup_status") == "bench",
                (player.get("trade_projection") or {}).get("our_projection") is not None,
                (player.get("trade_projection") or {}).get("our_projection") or -999), reverse=True)
            assets = assets[:4]
            give_packages = [[player] for player in assets]
            give_packages.extend([list(pair) for pair in combinations(assets, 2)])

            companions = [player for player in other_state["roster"]
                          if player.get("lineup_status") == "bench"
                          and player.get("position") not in requested_positions]
            companions.sort(key=lambda player: (
                player.get("position") in own_weak,
                (player.get("trade_projection") or {}).get("our_projection") is not None,
                (player.get("trade_projection") or {}).get("our_projection") or -999), reverse=True)
            companions = companions[:2]

            package_pairs = {}
            for target in desired_targets:
                incoming_sets = [[target]] + [[target, companion] for companion in companions]
                for incoming in incoming_sets:
                    for giving in give_packages:
                        if len(giving) == len(incoming) and len(giving) not in {1, 2}:
                            continue
                        give_ids = [player["player_id"] for player in giving]
                        receive_ids = [player["player_id"] for player in incoming]
                        shape = f"{len(give_ids)}-for-{len(receive_ids)}"
                        key = (other_id, tuple(sorted(give_ids)), tuple(sorted(receive_ids)))
                        if key in package_pairs:
                            continue
                        package_pairs[key] = True
                        result = _trade_result(service, week, own, other, normalized, rules, give_ids, receive_ids)
                        weekly = result["weekly_lineup_change"]
                        own_delta = weekly["you"]
                        other_delta = weekly["other_team"]
                        fit = _rest_of_season_value_fit(service, week, normalized, give_ids, receive_ids)

                        def need_improved(side, positions_incoming):
                            need_data = own_needs if side == "you" else other_needs
                            impact = (result.get("positional_impact") or {}).get(side, {})
                            return any(
                                pos in need_data
                                and need_data[pos].get("label") in {"Weak", "Weak depth", "Needs improvement"}
                                and ((impact.get(pos) or {}).get("after_strength") in {"Average", "Strong"}
                                     or ((impact.get(pos) or {}).get("after_usable_depth", 0)
                                         > (impact.get(pos) or {}).get("before_usable_depth", 0)))
                                for pos in positions_incoming)

                        own_positions_in = {player.get("position") for player in incoming}
                        if position is not None and not (own_positions_in & eligible_target_positions):
                            continue
                        partner_positions_in = {player.get("position") for player in giving}
                        own_need_fit = need_improved("you", own_positions_in)
                        partner_need_fit = need_improved("other_team", partner_positions_in)
                        # Keep ideas only when both managers have a measurable
                        # lineup, depth, need, or supported ROS reason to engage.
                        own_case = own_delta >= -0.5 and (own_delta > 0 or own_need_fit)
                        partner_case = other_delta >= -0.5 and (other_delta > 0 or partner_need_fit)
                        value_case = (fit.get("supported") and fit.get("within_uncertainty"))
                        if not (own_case and partner_case and (value_case or (own_need_fit and partner_need_fit))):
                            continue
                        result.update({
                            "partner_team_id": other_id, "partner_team_name": other["team_name"],
                            "trade_category": "PLAUSIBLE IDEA", "validation_type": "POSSIBLE TRADE TO EXPLORE",
                            "package_shape": shape, "requested_position": position,
                            "rest_of_season_value_fit": fit,
                            "plausibility": "Medium" if value_case else "Low",
                            "plausibility_basis": ("Both real optimized rosters show a measured lineup/depth reason and package value fits observed uncertainty."
                                                    if value_case else "Both real optimized rosters show a measured need/depth reason; rest-of-season value or uncertainty is unavailable."),
                            "reason_for_you": (f"Adds {', '.join(sorted(p for p in own_positions_in if p))} options to your roster; "
                                               f"your optimized weekly lineup changes {own_delta:+.1f} and the relevant need/depth comparison was rechecked."),
                            "reason_for_partner": (f"They receive {', '.join(sorted(p for p in partner_positions_in if p))} options; "
                                                   f"their optimized weekly lineup changes {other_delta:+.1f} and the relevant need/depth comparison was rechecked."),
                        })
                        research_rows.append(result)

    suggestions_rows.sort(key=lambda item: (item["plausibility"] == "High",
        min(item["weekly_lineup_change"]["you"], item["weekly_lineup_change"]["other_team"])), reverse=True)
    exploratory_rows.sort(key=lambda item: ({"IMMEDIATE WIN-WIN": 0, "ROSTER-BALANCING": 1, "UPSIDE TRADE": 2}.get(item.get("trade_category"), 3),
                                              min(item["weekly_lineup_change"]["you"], item["weekly_lineup_change"]["other_team"])), reverse=False)
    target_rows.sort(key=lambda item: (item["analysis"]["plausibility"] == "High",
        item["analysis"]["weekly_lineup_change"]["you"]), reverse=True)
    research_rows.sort(key=lambda item: (
        item["rest_of_season_value_fit"].get("within_uncertainty", False),
        min(item["weekly_lineup_change"]["you"], item["weekly_lineup_change"]["other_team"]),
        item["weekly_lineup_change"]["you"] + item["weekly_lineup_change"]["other_team"]), reverse=True)
    unique_targets = []
    seen_target_ids = set()
    for row in target_rows:
        key = (row["team_id"], row["player"]["player_id"])
        if key in seen_target_ids:
            continue
        seen_target_ids.add(key)
        unique_targets.append(row)
    selected_position_output = (position if isinstance(position, str) else
                                position[0] if isinstance(position, tuple) and len(position) == 1 else
                                list(position) if isinstance(position, tuple) else None)
    return {"week": week, "team_id": my_id, "team_name": own["team_name"],
            "last_updated": datetime.now(timezone.utc).isoformat(), "position": selected_position_output,
        "trade_targets": unique_targets[:40], "suggestions": suggestions_rows[:30],
            "possible_trades_to_explore": exploratory_rows[:40],
            "research_trade_ideas": research_rows[:24] if include_research_ideas else [],
            "trade_categories": {category: sum(row.get("trade_category") == category for row in exploratory_rows)
                                 for category in ("IMMEDIATE WIN-WIN", "ROSTER-BALANCING", "UPSIDE TRADE")},
            "best_trade_partners": sorted(partners, key=lambda row: row["best_weekly_fit"], reverse=True)[:8],
            "roster_needs": own_needs, "model": "Uses the existing roster-aware trade analyzer; real ESPN player cards and custom projections where supported.",
        "message": None if target_rows else "No high-confidence automatic trade found. Possible roster-balancing and upside trades are listed separately only when both rosters have a measured need and supported value evidence.",
        "target_team_id": target_team_id}
