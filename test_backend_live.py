"""Integration checks against the configured real ESPN fantasy league."""

import json
import os
import unittest
from datetime import datetime, timezone

from fastapi.testclient import TestClient

from espn_connection import connect_league, select_team
from main import app


class RealESPNBackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.league = connect_league()
        override = os.getenv("ESPN_TEAM_ID", "").strip()
        cls.my_team = select_team(cls.league.teams, os.environ["ESPN_SWID"], int(override) if override else None)
        cls.client = TestClient(app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def get_json(self, path, expected=200):
        response = self.client.get(path)
        self.assertEqual(response.status_code, expected, response.text)
        self.assertEqual(response.headers["content-type"], "application/json")
        body = response.json()
        text = json.dumps(body).casefold()
        for key in ("ESPN_S2", "ESPN_SWID"):
            self.assertNotIn(key.casefold(), text)
            secret = os.environ[key].strip()
            self.assertNotIn(secret.casefold(), text)
            self.assertNotIn(secret.strip("{}").casefold(), text)
        print(f"Verified real ESPN: {path} -> {expected}", flush=True)
        return body

    def post_json(self, path, body, expected=200):
        response = self.client.post(path, json=body)
        self.assertEqual(response.status_code, expected, response.text)
        self.assertEqual(response.headers["content-type"], "application/json")
        payload = response.json()
        text = json.dumps(payload).casefold()
        for key in ("ESPN_S2", "ESPN_SWID"):
            self.assertNotIn(key.casefold(), text)
            secret = os.environ[key].strip()
            self.assertNotIn(secret.casefold(), text)
            self.assertNotIn(secret.strip("{}").casefold(), text)
        print(f"Verified real ESPN: {path} -> {expected}", flush=True)
        return payload

    def assert_roster(self, roster, week):
        self.assertIsInstance(roster, list)
        self.assertTrue(roster, "Real league roster unexpectedly empty")
        for player in roster:
            for key in ("player_id", "name", "position", "nfl_team", "fantasy_points",
                        "projected_fantasy_points", "lineup_status", "is_starter"):
                self.assertIn(key, player)
            self.assertEqual(player["week"], week)
            self.assertEqual(player["is_starter"], player["lineup_status"] == "starter")
            self.assertIn(player["lineup_status"], ("starter", "bench", "reserve", "unassigned"))
        self.assertTrue(any(p["is_starter"] for p in roster))
        self.assertTrue(any(p["lineup_status"] == "bench" for p in roster))

    def test_league(self):
        data = self.get_json("/api/league")
        self.assertEqual(data["league_name"], self.league.settings.name)
        self.assertEqual(data["current_week"], self.league.current_week)
        self.assertEqual(data["fantasy_team_count"], len(self.league.teams))

    def test_teams(self):
        data = self.get_json("/api/teams")
        self.assertEqual({t["team_id"] for t in data["teams"]}, {t.team_id for t in self.league.teams})
        for team in data["teams"]:
            for owner in team["owners"]:
                self.assertTrue(set(owner) <= {"displayName", "firstName", "lastName"})

    def test_monte_carlo_cache_key_tracks_week_and_projection_not_ui_state(self):
        from copy import deepcopy
        from prediction_service import _cache_key

        matchup = {"fantasy_matchup_id": 23, "week": 5,
                   "home_team": {"team_id": 1, "roster": [{"player_id": 11, "is_starter": True,
                                                               "projected_fantasy_points": 12.0}]},
                   "away_team": {"team_id": 2, "roster": [{"player_id": 22, "is_starter": True,
                                                               "projected_fantasy_points": 9.0}]}}
        insights = {11: {"nfl_team_id": 4, "injury_status": "ACTIVE", "game_log": []},
                    22: {"nfl_team_id": 5, "injury_status": "ACTIVE", "game_log": []}}
        models = {11: {"mean": 12.5, "standard_deviation": 6.0, "confidence": "medium",
                       "adjustments": [], "context_events": []},
                  22: {"mean": 9.0, "standard_deviation": 5.0, "confidence": "medium",
                       "adjustments": [], "context_events": []}}
        states = {4: {"state": "pre", "game_id": "game-4"},
                  5: {"state": "pre", "game_id": "game-5"}}
        original = _cache_key(matchup, states, insights, models, 25_000, "split")

        # Page tabs, view state, and unmodeled bench metadata are not simulation
        # inputs, so UI navigation cannot evict or alter a valid simulation.
        unrelated = deepcopy(matchup)
        unrelated["active_tab"] = "trades"
        unrelated["home_team"]["roster"].append({"player_id": 33, "is_starter": False,
                                                 "projected_fantasy_points": 30.0})
        self.assertEqual(original, _cache_key(unrelated, states, insights, models, 25_000, "split"))

        changed_week = deepcopy(matchup)
        changed_week["week"] = 6
        self.assertNotEqual(original, _cache_key(changed_week, states, insights, models, 25_000, "split"))
        changed_model = deepcopy(models)
        changed_model[11]["mean"] += 1.0
        self.assertNotEqual(original, _cache_key(matchup, states, insights, changed_model, 25_000, "split"))
        changed_espn = deepcopy(matchup)
        changed_espn["home_team"]["roster"][0]["projected_fantasy_points"] += 1.0
        self.assertNotEqual(original, _cache_key(changed_espn, states, insights, models, 25_000, "split"))

    def test_my_team(self):
        data = self.get_json("/api/my-team")
        self.assertEqual(data["team_id"], self.my_team.team_id)
        self.assert_roster(data["roster"], self.league.current_week)

    def test_fantasy_matchups_current_previous_future(self):
        current = self.league.current_week
        weeks = sorted({max(self.league.firstScoringPeriod, current - 1), current,
                        min(self.league.finalScoringPeriod, current + 1)})
        for week in weeks:
            paths = [f"/api/fantasy-matchups/{week}", f"/api/fantasy-matchups?week={week}"]
            if week == current:
                paths.append("/api/fantasy-matchups")
            # Independently fetch ESPN's exact week to verify all fantasy contests
            # and player points, rather than merely checking response shapes.
            periods = [int(p) for p, ws in self.league.settings.matchup_periods.items() if week in ws]
            raw = self.league.espn_request.league_get(
                params={"view": ["mMatchupScore", "mScoreboard"], "scoringPeriodId": week},
                headers={"x-fantasy-filter": json.dumps({"schedule": {"filterMatchupPeriodIds": {"value": periods}}})},
            )
            expected = {m["id"]: m for m in raw["schedule"] if m["matchupPeriodId"] in periods}
            for path in paths:
                with self.subTest(path=path):
                    data = self.get_json(path)
                    self.assertEqual(data["week"], week)
                    self.assertEqual({m["fantasy_matchup_id"] for m in data["fantasy_matchups"]}, set(expected))
                    self.assertEqual(sum(m["involves_my_team"] for m in data["fantasy_matchups"]), 1)
                    for matchup in data["fantasy_matchups"]:
                        upstream = expected[matchup["fantasy_matchup_id"]]
                        for side in ("home", "away"):
                            team = matchup[f"{side}_team"]
                            if side not in upstream:
                                self.assertIsNone(team)
                                continue
                            source = upstream[side]
                            self.assertEqual(team["team_id"], source["teamId"])
                            self.assertAlmostEqual(team["current_fantasy_score"], source.get("totalPointsLive", source["totalPoints"]))
                            self.assert_roster(team["roster"], week)
                            entries = source["rosterForCurrentScoringPeriod"]["entries"]
                            self.assertEqual(len(team["roster"]), len(entries))
                            actual_players = {p["playerPoolEntry"]["player"]["id"]: p["playerPoolEntry"]["player"] for p in entries}
                            for player in team["roster"]:
                                for stat_source, field in ((0, "fantasy_points"), (1, "projected_fantasy_points")):
                                    value = next((s.get("appliedTotal") for s in actual_players[player["player_id"]].get("stats", [])
                                                  if s.get("seasonId") == self.league.year
                                                  and s.get("scoringPeriodId") == week
                                                  and s.get("statSourceId") == stat_source
                                                  and s.get("statSplitTypeId") != 2), None)
                                    self.assertEqual(player[field], value)
                            # Team totals and the roster/player-card query are
                            # separate live ESPN feeds and can update between
                            # calls. Validate the reported provenance instead
                            # of asserting two independently fetched values are
                            # identical. When ESPN omits a team total, the API
                            # explicitly reports a starter-sum source.
                            if team.get("projection_source") == "espn_team_total":
                                self.assertIsInstance(team.get("projected_fantasy_score"), (int, float))
                            elif team.get("projection_source") == "sum_of_espn_starter_projections":
                                starters = [p for p in team["roster"] if p.get("is_starter")]
                                self.assertTrue(starters)
                                self.assertTrue(all(isinstance(p.get("projected_fantasy_points"), (int, float)) for p in starters))
                                self.assertAlmostEqual(team["projected_fantasy_score"],
                                                       sum(p["projected_fantasy_points"] for p in starters), delta=0.01)
                            else:
                                self.assertIsNone(team.get("projected_fantasy_score"))

    def test_monte_carlo_fantasy_predictions_use_real_espn_data(self):
        current_week = self.league.current_week
        league = self.get_json("/api/league")
        source_matchups = self.get_json(f"/api/fantasy-matchups/{current_week}")
        predictions = self.get_json(f"/api/fantasy-predictions?week={current_week}")
        self.assertEqual(predictions["week"], current_week)
        self.assertGreaterEqual(predictions["simulation_count"], 25_000)
        self.assertIn("not ESPN official odds", predictions["model"])
        self.assertEqual(
            {item["fantasy_matchup_id"] for item in predictions["predictions"]},
            {item["fantasy_matchup_id"] for item in source_matchups["fantasy_matchups"]},
        )
        self.assertTrue(all(item["status"] == "estimated" for item in predictions["predictions"]),
                        "every real current-week fantasy matchup should have simulation results")
        for result in predictions["predictions"]:
            if result["status"] == "unavailable":
                self.assertTrue(result["missing_data"])
                continue
            self.assertGreaterEqual(result["simulation_count"], 25_000)
            if result["status"] == "unavailable":
                self.assertTrue(result["missing_data"])
                continue
            self.assertAlmostEqual(result["team_a_win_probability"] + result["team_b_win_probability"] + result["tie_probability"], 1.0, delta=0.00001)
            self.assertEqual(len(result["biggest_remaining_swing_players"]) <= 3, True)
            self.assertIn("custom player projection engine", result["model"].lower())
            self.assertLessEqual(result["team_a"]["likely_score_range"]["low"], result["team_a"]["median_simulated_score"])
            self.assertLessEqual(result["team_a"]["median_simulated_score"], result["team_a"]["likely_score_range"]["high"])
            source = next(item for item in source_matchups["fantasy_matchups"]
                          if item["fantasy_matchup_id"] == result["fantasy_matchup_id"])
            for predicted_side, side_name in ((result["team_a"], "home_team"), (result["team_b"], "away_team")):
                team = source[side_name]
                roster_by_id = {player["player_id"]: player for player in team["roster"]}
                for player in predicted_side["fixed_players"]:
                    self.assertFalse(player["simulated"])
                    source_points = roster_by_id[player["player_id"]]["fantasy_points"]
                    if source_points is None:
                        # ESPN omits points for players fixed at zero because
                        # they are confirmed OUT or on bye. Preserve that
                        # distinction from a completed player with an actual
                        # ESPN score.
                        self.assertEqual(player["fantasy_points"], 0.0)
                        self.assertIn(player["source"], {
                            "structured_player_status_out", "confirmed_nfl_bye",
                        })
                    else:
                        self.assertEqual(player["fantasy_points"], source_points)
                for player in predicted_side["modeled_players"]:
                    self.assertTrue(player["simulated"])
                    if player["status"] == "in":
                        self.assertEqual(player["current_points"], roster_by_id[player["player_id"]]["fantasy_points"])

        repeat = self.get_json(f"/api/fantasy-predictions?week={current_week}")
        estimated_pairs = [(first, again) for first, again in zip(predictions["predictions"], repeat["predictions"])
                           if first["status"] != "unavailable" and again["status"] != "unavailable"]
        # Identical inputs hit the explicit simulation cache; changing live
        # points, clock, projections, status, or custom adjustments invalidates it.
        for first, again in estimated_pairs:
            self.assertEqual(first["team_a_win_probability"], again["team_a_win_probability"])
            self.assertEqual(first["team_b_win_probability"], again["team_b_win_probability"])
            self.assertIn("custom player projection engine", first["model"].lower())
            self.assertGreaterEqual(first["team_a"]["our_projected_score"], 0)
            self.assertGreaterEqual(first["team_b"]["our_projected_score"], 0)

        # A live week can already be completely finished. Finished players are
        # intentionally moved from modeled_players to fixed_players, so never
        # compare a completed week's actual scores with a future projection.
        # Instead, compare two selected, pregame weeks and verify that the
        # custom expectation consumed by Monte Carlo follows each week's real
        # ESPN roster input. This exercises the week-specific ESPN -> engine ->
        # distribution -> simulation path without weakening fixed-player rules.
        future_weeks = [week for week in league["fantasy_weeks"] if week > current_week]

        def modeled_players(data):
            return {player["player_id"]: player for result in data["predictions"]
                    if result["status"] != "unavailable"
                    for side in (result["team_a"], result["team_b"])
                    for player in side["modeled_players"]}

        def assert_week_projection_flows(week, data):
            matchups = self.get_json(f"/api/fantasy-matchups/{week}")
            roster_by_id = {player["player_id"]: player
                            for matchup in matchups["fantasy_matchups"]
                            for side in (matchup["home_team"], matchup["away_team"]) if side
                            for player in (side["roster"] or []) if player["is_starter"]}
            modeled = modeled_players(data)
            pregame = [player for player in modeled.values() if player["status"] == "pre"]
            self.assertTrue(pregame, f"Week {week} should have pregame Monte Carlo players for the selected-week projection check")
            for player in pregame:
                source = roster_by_id[player["player_id"]]
                self.assertEqual(player["espn_projection"], source["projected_fantasy_points"])
                self.assertAlmostEqual(player["expected_final_score"], player["custom_projection"], places=3)
            return modeled

        if future_weeks:
            first_future_week = future_weeks[0]
            first_future = self.get_json(f"/api/fantasy-predictions?week={first_future_week}")
            first_future_players = assert_week_projection_flows(first_future_week, first_future)
            # Include a second future week when configured so meaningful
            # real ESPN projection changes are compared while both outcomes
            # are still modeled rather than locked to completed actual points.
            for second_future_week in future_weeks[1:2]:
                second_future = self.get_json(f"/api/fantasy-predictions?week={second_future_week}")
                second_future_players = assert_week_projection_flows(second_future_week, second_future)
                changed = any(
                    player_id in second_future_players
                    and player.get("espn_projection") is not None
                    and second_future_players[player_id].get("espn_projection") is not None
                    and abs(player["espn_projection"] - second_future_players[player_id]["espn_projection"]) > 0.01
                    and player.get("custom_projection") is not None
                    and second_future_players[player_id].get("custom_projection") is not None
                    and abs(player["custom_projection"] - second_future_players[player_id]["custom_projection"]) > 0.01
                    and abs(player["expected_final_score"] - second_future_players[player_id]["expected_final_score"]) > 0.01
                    for player_id, player in first_future_players.items()
                    if player["status"] == "pre" and second_future_players.get(player_id, {}).get("status") == "pre"
                )
                if changed:
                    break
                first_future_week = second_future_week
                first_future_players = second_future_players
            else:
                changed = False
            self.assertTrue(changed,
                            "a meaningful real ESPN projection change between two pregame weeks must change the custom and modeled expectation")

        previous_week = max(league["first_week"], current_week - 1)
        past_matchups = self.get_json(f"/api/fantasy-matchups/{previous_week}")
        past_predictions = self.get_json(f"/api/fantasy-predictions?week={previous_week}")
        for result in past_predictions["predictions"]:
            if result["status"] == "unavailable":
                continue
            source = next(item for item in past_matchups["fantasy_matchups"]
                          if item["fantasy_matchup_id"] == result["fantasy_matchup_id"])
            for side in (result["team_a"], result["team_b"]):
                self.assertEqual(side["modeled_players"], [])
                team = next(item for item in (source["home_team"], source["away_team"])
                            if item and item["team_id"] == side["team_id"])
                if team["current_fantasy_score"] is not None:
                    self.assertAlmostEqual(side["projected_final_score"], team["current_fantasy_score"], places=2)
                    self.assertAlmostEqual(side["median_simulated_score"], team["current_fantasy_score"], places=2)

    def test_custom_player_projections_use_real_league_data(self):
        from projection_sources.nfl_stats import season_data

        week = self.league.current_week
        matchups = self.get_json(f"/api/fantasy-matchups/{week}")
        payload = self.get_json(f"/api/projections?week={week}")
        self.assertEqual(payload["week"], week)
        self.assertIn("empirical-Bayes", payload["model"])
        self.assertIn("nflverse", payload["source"])
        self.assertIn("player_stats", payload["source_status"]["sources"])
        for source_key in ("player_stats", "team_stats", "schedule", "players"):
            source = payload["source_status"]["sources"][source_key]
            self.assertTrue(source["available"], f"real nflverse {source_key} feed unavailable: {source}")
            retrieved = datetime.fromisoformat(source["retrieved_at"].replace("Z", "+00:00"))
            self.assertIsNotNone(retrieved.tzinfo, f"{source_key} retrieval time must include a timezone")
            self.assertLessEqual(retrieved.astimezone(timezone.utc), datetime.now(timezone.utc))
            if source["source_updated_at"]:
                self.assertTrue(source["source_update_time_available"])
                self.assertEqual(source["freshness_basis"], "source_updated_at")
            else:
                self.assertFalse(source["source_update_time_available"])
                self.assertEqual(source["freshness_basis"], "retrieved_at")
                self.assertIn("unavailable", source["source_update_note"].casefold())

        player_stats = season_data(self.league.year)["player_stats"]
        self.assertTrue(player_stats, "nflverse player_stats feed must contain statistical rows")
        required_stats = {"player_id", "week", "season_type", "position_group", "team", "opponent_team",
                          "passing_yards", "rushing_yards", "receiving_yards", "attempts", "carries",
                          "targets", "fantasy_points", "fantasy_points_ppr"}
        self.assertTrue(required_stats.issubset(player_stats[0]),
                        f"nflverse player_stats is missing required fields: {required_stats - set(player_stats[0])}")
        rostered = {player["player_id"]: player
                    for matchup in matchups["fantasy_matchups"]
                    for side in (matchup["home_team"], matchup["away_team"]) if side
                    for player in (side["roster"] or [])}
        by_id = {record["player_id"]: record for record in payload["players"]}
        self.assertEqual(set(by_id), set(rostered))
        matchup_adjustments = 0
        role_evidence = 0
        role_adjustments = 0
        market_contexts = 0
        for player_id, record in by_id.items():
            self.assertEqual(record["player"]["name"], rostered[player_id]["name"])
            projection = record["projection"]
            self.assertEqual(projection["espn_projection"], rostered[player_id]["projected_fantasy_points"])
            self.assertIn(projection["confidence"], {"low", "medium", "high"})
            self.assertIsInstance(projection["adjustments"], list)
            for factor in projection["adjustments"]:
                self.assertIsInstance(factor["adjustment"], (int, float))
                self.assertTrue(factor["evidence"])
                self.assertTrue(factor["source"])
            if projection.get("projection_context"):
                context = projection["projection_context"]
                matchup_factor = next((row for row in projection["adjustments"] if row["key"] == "matchup"), None)
                if matchup_factor:
                    matchup_adjustments += 1
                    matchup = context["defensive_matchup"]
                    self.assertGreaterEqual(matchup["games_sampled"], 1)
                    self.assertNotEqual(matchup["points_allowed_per_game"], None)
                    self.assertAlmostEqual(matchup_factor["adjustment"], round(
                        (projection["espn_projection"] or 0) * matchup["percent_vs_league_average"], 3))
                role = context.get("role_trend") or {}
                if role.get("role_direction") in {"increasing", "decreasing", "stable"}:
                    role_evidence += 1
                if any(row["key"] == "role_trend" for row in projection["adjustments"]):
                    role_adjustments += 1
                market_contexts += bool((context.get("team_and_game_environment") or {}).get("market", {}).get("available"))
                weather = context.get("weather") or {}
                if weather.get("available"):
                    self.assertFalse(any(row["key"] == "weather" for row in projection["adjustments"]))
            if projection["our_projection"] is not None and projection["standard_deviation"] is not None:
                self.assertLessEqual(projection["floor"], projection["median"])
                self.assertLessEqual(projection["median"], projection["ceiling"])
                self.assertGreaterEqual(projection["standard_deviation"], 0)
            if projection["our_projection"] is not None and projection["espn_projection"] is not None:
                adjusted = projection["espn_projection"] + sum(item["adjustment"] for item in projection["adjustments"])
                self.assertAlmostEqual(projection["our_projection"], adjusted, places=2)

        self.assertGreater(matchup_adjustments, 0, "real opponent points-allowed data should affect applicable players")
        self.assertGreater(role_evidence, 0, "real snap-count history should provide role context for eligible players")
        self.assertGreater(role_adjustments, 0, "real snap-share changes should independently affect supported player projections")
        self.assertGreater(market_contexts, 0, "real nflverse market context should join to NFL games for rostered players")

        # The pure engine is deterministic for the same observed ESPN inputs.
        from projection_engine import project_players
        players = [record["player"] for record in payload["players"]]
        first = project_players(players, week)
        second = project_players(players, week)
        self.assertEqual(first, second)

        future_week = next((candidate for candidate in self.league.settings.matchup_periods
                            if int(candidate) > week), None)
        if future_week is not None:
            future_week = int(future_week)
            future_data = self.get_json(f"/api/projections?week={future_week}")
            future_by_id = {record["player_id"]: record for record in future_data["players"]}
            changed_projection = any(
                player_id in future_by_id
                and record["projection"]["espn_projection"] is not None
                and future_by_id[player_id]["projection"]["espn_projection"] is not None
                and abs(record["projection"]["espn_projection"] - future_by_id[player_id]["projection"]["espn_projection"]) > 0.01
                and abs(record["projection"]["our_projection"] - future_by_id[player_id]["projection"]["our_projection"]) > 0.01
                for player_id, record in by_id.items()
                if record["projection"]["our_projection"] is not None
                and future_by_id.get(player_id, {}).get("projection", {}).get("our_projection") is not None
            )
            self.assertTrue(changed_projection, "a changed real ESPN weekly projection should change our player estimate")

        sample = next(iter(by_id.values()))
        details = self.get_json(f"/api/players/{sample['player_id']}?week={week}")
        self.assertIn("custom_projection", details)
        self.assertEqual(details["custom_projection"]["week"], week)

    def test_free_agents(self):
        self.assertTrue(self.get_json("/api/free-agents")["players"])
        for position in ("QB", "RB", "WR", "TE"):
            data = self.get_json(f"/api/free-agents?position={position}&limit=5")
            self.assertLessEqual(len(data["players"]), 5)
            self.assertTrue(data["players"])
            for player in data["players"]:
                self.assertEqual(player["position"], position)
                self.assertEqual(player["lineup_status"], "available")
                self.assertFalse(player["is_starter"])

    def test_start_sit_uses_real_roster_and_eligible_league_slots(self):
        week = self.league.current_week
        data = self.get_json(f"/api/start-sit?week={week}")
        self.assertEqual(data["team_id"], self.my_team.team_id)
        self.assertEqual(data["week"], week)
        self.assertTrue(data["recommended_starters"])
        self.assertTrue(data["legal_lineup"])
        self.assertTrue(data["scoring_rules"]["position_slot_counts"])
        roster_ids = {player.playerId for player in self.my_team.roster}
        starters = data["recommended_starters"]
        bench = data["bench"]
        self.assertEqual(len({player["player_id"] for player in starters + bench}), len(starters) + len(bench))
        self.assertTrue({player["player_id"] for player in starters + bench} <= roster_ids)
        self.assertFalse({player["player_id"] for player in starters} & {player["player_id"] for player in bench})
        slot_counts = data["scoring_rules"]["position_slot_counts"]
        recommended_counts = {}
        for player in starters:
            slot = player["recommended_slot"]
            recommended_counts[slot] = recommended_counts.get(slot, 0) + 1
            self.assertIn(slot, player["eligible_positions"], f"{player['name']} is not ESPN-eligible for {slot}")
        for slot, count in recommended_counts.items():
            self.assertLessEqual(count, slot_counts[slot])
        self.assertEqual(sum(recommended_counts.values()), sum(slot_counts.values()))
        self.assertEqual(recommended_counts, slot_counts)
        self.assertTrue(data["model"])
        self.assertIn("ESPN", data["model"])
        for player in starters:
            self.assertIsInstance(player.get("custom_projection"), dict)
            self.assertEqual(player.get("estimate_source"), "confidence_aware_blend")
            self.assertIsNotNone(player["expected_points"])
            self.assertEqual(player["expected_points"], player["recommendation_projection"])
            self.assertEqual(player["raw_custom_projection"], player["custom_projection"]["our_projection"])
            self.assertIn(player["recommendation_confidence"], ("low", "medium", "high"))
            self.assertIn(player.get("projection_confidence"), ("low", "medium", "high", None))
        self.assertIsInstance(data["lineup_changes"]["improvement_points"], (int, float))
        configured_weeks = sorted({week for weeks in self.league.settings.matchup_periods.values() for week in weeks})
        previous = next((candidate for candidate in reversed(configured_weeks) if candidate < week), None)
        future = next((candidate for candidate in configured_weeks if candidate > week), None)
        for selected in (previous, future):
            if selected is None:
                continue
            alternate = self.get_json(f"/api/start-sit?week={selected}")
            self.assertEqual(alternate["week"], selected)
            self.assertTrue(all(p["week"] == selected for p in alternate["recommended_starters"] + alternate["bench"]))

    def test_waivers_only_rank_real_available_unrostered_players(self):
        week = self.league.current_week
        advice = self.get_json(f"/api/waiver-advice?week={week}&limit=20")
        roster = self.get_json(f"/api/my-team?week={week}")["roster"]
        pool = self.get_json(f"/api/free-agents?week={week}&limit=20")["players"]
        roster_ids = {player["player_id"] for player in roster}
        pool_ids = {player["player_id"] for player in pool}
        self.assertEqual(advice["week"], week)
        self.assertGreater(advice["free_agent_pool_size"], 0)
        self.assertTrue(advice["ranking_model"])
        self.assertIn("custom projection engine remains a primary input", advice["ranking_model"].lower())
        self.assertTrue(advice["roster_needs"])
        self.assertTrue(all("label" in row and "basis" in row for row in advice["roster_needs"].values()))
        all_recommended = advice["best_overall_adds"] + advice["best_qb_adds"] + advice["best_rb_adds"] + advice["best_wr_adds"] + advice["best_te_adds"]
        for player in all_recommended:
            self.assertNotIn(player["player_id"], roster_ids)
            self.assertIn(player["player_id"], pool_ids)
            self.assertIn(player["availability_status"], ("FREEAGENT", "WAIVERS"))
            self.assertIn(player["confidence"], ("high", "medium", "low"))
            self.assertIn("recommendation_score", player)
        move = advice["personalized_move"]
        if move:
            self.assertNotIn(move["add"]["player_id"], roster_ids)
            self.assertIn(move["add"]["player_id"], pool_ids)
            dropped = next(player for player in roster if player["player_id"] == move["drop"]["player_id"])
            self.assertEqual(dropped["lineup_status"], "bench")
            self.assertIn(dropped["injury_status"], ("ACTIVE", "NORMAL"))
            self.assertTrue(move.get("reason"))
            self.assertIn("starting_lineup", move["effect"])
            self.assertTrue(move["weekly_lineup_change"] >= advice["minimum_add_drop_advantage"] or
                            (move["add"].get("needs_match") and (move.get("rest_of_season_change") or 0) >= 8))
        else:
            self.assertTrue(advice["move_note"])

    def test_waiver_multi_position_filter_keeps_real_pool_and_roster_needs(self):
        week = self.league.current_week
        advice = self.get_json(f"/api/waiver-advice?week={week}&limit=40&positions=RB&positions=WR")
        self.assertEqual(advice["selected_positions"], ["RB", "WR"])
        self.assertTrue(advice["roster_needs"].get("TE"), "Roster needs continue to reflect the full ESPN roster.")
        rows = advice["best_overall_adds"] + advice["upside_stashes"] + advice["streaming_options"]
        if advice["personalized_move"]:
            rows.append(advice["personalized_move"]["add"])
        self.assertTrue(all(player["position"] in {"RB", "WR"} for player in rows))
        pool = self.get_json(f"/api/free-agents?week={week}&limit=40")["players"]
        pool_ids = {player["player_id"] for player in pool if player["position"] in {"RB", "WR"}}
        self.assertTrue(all(player["player_id"] in pool_ids for player in rows))

    def test_player(self):
        player = self.my_team.roster[0]
        data = self.get_json(f"/api/players/{player.playerId}")
        self.assertEqual(data["player_id"], player.playerId)
        self.assertEqual(data["name"], player.name)
        self.assertIn("weekly_stats", data)
        for field in ("jersey_number", "nfl_opponent", "nfl_game_time", "bye_week",
                      "season_fantasy_average", "last_3_games", "last_5_games",
                      "game_log", "game_stats"):
            self.assertIn(field, data)
        self.assertEqual(data["weekly_stats"], [
            {"week": g["week"], "fantasy_points": g["fantasy_points"],
             "projected_fantasy_points": g["projected_fantasy_points"]}
            for g in data["game_log"]
        ])
        self.assertEqual(data["last_3_games"], data["game_log"][-3:])
        self.assertEqual(data["last_5_games"], data["game_log"][-5:])

    def test_team_defense_player_profile(self):
        defense = next((player for player in self.my_team.roster if player.playerId < 0), None)
        if defense is not None:
            data = self.get_json(f"/api/players/{defense.playerId}")
            self.assertEqual(data["player_id"], defense.playerId)
            self.assertEqual(data["name"], defense.name)
            self.assertTrue(data.get("nfl_team_logo_url", "").startswith("https://a.espncdn.com/i/teamlogos/nfl/"))
            self.assertRegex(data.get("nfl_team_color") or "", r"^[0-9a-fA-F]{6}$")

    def test_nfl_live_status_is_distinct_from_fantasy_matchups(self):
        data = self.get_json("/api/nfl/live-status")
        self.assertTrue(data["updated_at"])
        self.assertIsInstance(data["in_progress_team_ids"], list)
        # This endpoint supplies only actual NFL game state for LIVE indicators;
        # fantasy team matchups retain their separate schema and route.
        self.assertNotIn("fantasy_matchups", data)
        self.assertTrue(all(isinstance(team, int) for team in data["in_progress_team_ids"]))

    def test_nfl_schedule_and_game_details_are_separate_real_nfl_data(self):
        current = self.get_json("/api/nfl/schedule")
        self.assertEqual(current["sport"], "NFL")
        self.assertEqual(current["week"], current["current_week"])
        self.assertTrue(current["games"])
        for game in current["games"]:
            self.assertTrue(game["event_id"])
            self.assertTrue(game["home_team"]["abbreviation"])
            self.assertTrue(game["away_team"]["abbreviation"])
            for team in (game["home_team"], game["away_team"]):
                if team.get("logo_url"):
                    self.assertIn("espncdn.com/i/teamlogos/nfl/", team["logo_url"])
                if team.get("primary_color"):
                    self.assertRegex(team["primary_color"], r"^[0-9a-fA-F]{6}$")
            market = game.get("market_probability")
            if market:
                self.assertEqual(market["source"], "Kalshi public markets")
                self.assertTrue(market["event_identifier"].startswith("KXNFLGAME-"))
                self.assertTrue(market["market_identifiers"])
                self.assertTrue(market["retrieved_at"])
                self.assertAlmostEqual(market["away_probability"] + market["home_probability"], 1.0, delta=0.00001)
            self.assertNotIn("fantasy_matchups", game)
        # A public market can close before every NFL game in the current week
        # finishes, so a current-week slate is not guaranteed to contain an
        # open contract. Check the next real slate too, and require at least
        # one exact current/upcoming event match while allowing unavailable
        # games to remain honestly unpriced.
        upcoming = self.get_json(f"/api/nfl/schedule?week={min(18, current['current_week'] + 1)}")
        market_games = [game for game in [*current["games"], *upcoming["games"]]
                        if game.get("market_probability")]
        self.assertTrue(market_games,
                        "Kalshi returned no exact current or upcoming NFL moneyline markets.")
        for week in (max(1, current["current_week"] - 1), min(18, current["current_week"] + 1)):
            selected = self.get_json(f"/api/nfl/schedule?week={week}")
            self.assertEqual(selected["week"], week)
            self.assertTrue(all(game["home_team"] and game["away_team"] for game in selected["games"]))
        details = self.get_json(f"/api/nfl/games/{current['games'][0]['event_id']}")
        self.assertEqual(details["event_id"], current["games"][0]["event_id"])
        self.assertIsInstance(details["leaders"], list)

    def test_trade_targets_endpoint_uses_both_real_lineups(self):
        week = self.league.current_week
        data = self.get_json(f"/api/trades/targets?week={week}&position=ALL")
        matchups = self.get_json(f"/api/fantasy-matchups/{week}")
        self.assertEqual(data["week"], week)
        self.assertIsInstance(data["trade_targets"], list)
        for row in data["trade_targets"]:
            self.assertGreater(row["analysis"]["weekly_lineup_change"]["you"], 0)
            self.assertGreater(row["analysis"]["weekly_lineup_change"]["other_team"], 0)
        teams = {team["team_id"]: team for matchup in matchups["fantasy_matchups"]
                 for team in (matchup.get("home_team"), matchup.get("away_team")) if team}
        own = teams[matchups["my_team_id"]]
        own_qbs = [player for player in own["roster"] if player.get("position") == "QB" and player.get("is_starter")]
        league_qb_values = [player["projected_fantasy_points"] for team in teams.values()
                            for player in team["roster"]
                            if player.get("position") == "QB" and player.get("is_starter")
                            and isinstance(player.get("projected_fantasy_points"), (int, float))]
        if own_qbs and league_qb_values:
            from statistics import median
            own_qb = own_qbs[0]
            status = str(own_qb.get("injury_status") or "").upper()
            projection = own_qb.get("projected_fantasy_points")
            if (status not in {"OUT", "DOUBTFUL", "IR", "INJURED RESERVE"}
                    and own_qb.get("bye_week") != week and isinstance(projection, (int, float))
                    and projection >= median(league_qb_values)):
                self.assertFalse(any(row["player"].get("position") == "QB" for row in data["trade_targets"]))

    def test_league_trade_research_returns_only_numerically_analyzed_real_packages(self):
        week = self.league.current_week
        matchups = self.get_json(f"/api/fantasy-matchups/{week}")
        teams = {team["team_id"]: team for matchup in matchups["fantasy_matchups"]
                 for team in (matchup.get("home_team"), matchup.get("away_team")) if team}
        own_ids = {player["player_id"] for player in teams[matchups["my_team_id"]]["roster"]}
        result = self.get_json(f"/api/trades/targets?week={week}&position=RB&include_research_ideas=true")
        self.assertEqual(result["position"], "RB")
        ideas = result["research_trade_ideas"]
        self.assertIsInstance(ideas, list)
        for idea in ideas:
            self.assertIn(idea["package_shape"], {"1-for-1", "2-for-1", "1-for-2", "2-for-2"})
            self.assertTrue(any(player["position"] == "RB" for player in idea["you_receive"]))
            self.assertTrue(all(player["player_id"] in own_ids for player in idea["you_give"]))
            partner_ids = {player["player_id"] for player in teams[idea["partner_team_id"]]["roster"]}
            self.assertTrue(all(player["player_id"] in partner_ids for player in idea["you_receive"]))
            self.assertEqual(idea["validation_type"], "POSSIBLE TRADE TO EXPLORE")
            self.assertIn("you", idea["weekly_lineup_change"])
            self.assertIn("other_team", idea["weekly_lineup_change"])

    def test_manual_trade_has_separate_user_verdict_and_manager_fit(self):
        week = self.league.current_week
        matchups = self.get_json(f"/api/fantasy-matchups/{week}")
        teams = {team["team_id"]: team for matchup in matchups["fantasy_matchups"]
                 for team in (matchup.get("home_team"), matchup.get("away_team")) if team}
        own = teams[matchups["my_team_id"]]
        other = next(team for team in teams.values() if team["team_id"] != own["team_id"])
        give = next(player for player in own["roster"] if player.get("lineup_status") == "bench")
        receive = next(player for player in other["roster"] if player.get("lineup_status") == "bench")
        result = self.post_json("/api/trades/analyze", {
            "team_id": other["team_id"], "give_player_ids": [give["player_id"]],
            "receive_player_ids": [receive["player_id"]], "week": week,
        })
        verdict = result["verdict"]
        self.assertIn(verdict["worth_it"], {"YES", "LEAN YES", "EVEN", "LEAN NO", "NO"})
        self.assertIn(verdict["acceptance_likelihood"], {"HIGH", "MEDIUM", "LOW", "VERY LOW"})
        self.assertTrue(verdict["worth_it_reason"])
        self.assertTrue(verdict["acceptance_reason"])
        self.assertIn("not a probability", verdict["method"])
    def test_season_end_and_missing_player(self):
        # Ask the real provider for unpublished playoff weeks and a nonexistent
        # player; neither case is populated from substitute league data.
        last = self.league.finalScoringPeriod
        data = self.get_json(f"/api/fantasy-matchups/{last}")
        self.assertEqual(data["week"], last)
        self.assertTrue(all(m["week"] == last for m in data["fantasy_matchups"]))
        error = self.get_json("/api/players/2147483647", 404)
        self.assertEqual(error["error"]["code"], "player_not_found")

    def test_invalid_requests(self):
        for path in ("/api/fantasy-matchups/0", f"/api/fantasy-matchups/{self.league.finalScoringPeriod + 1}",
                     "/api/free-agents?position=INVALID", "/api/free-agents?limit=0",
                     "/api/players/0"):
            data = self.get_json(path, 422)
            self.assertIn("error", data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
