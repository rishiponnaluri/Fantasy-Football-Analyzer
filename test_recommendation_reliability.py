"""Deterministic Start/Sit recommendation-layer regressions.

These controlled projections exercise numerical safety boundaries only; runtime
player data always comes from ESPN and the connected projection/context sources.
"""
import unittest
from copy import deepcopy

from recommendation_service import assess_start_sit_swap, confidence_aware_value, optimize_lineup


class ConfidenceAwareRecommendationTests(unittest.TestCase):
    def test_barkley_collins_scenario_keeps_exact_espn_slots_legal(self):
        slots = {"QB": 1, "RB": 2, "WR": 2, "RB/WR/TE": 1, "TE": 1, "K": 1, "D/ST": 1}
        rows = [
            (1, "Saquon Barkley", "RB", 13, ["RB", "RB/WR/TE"], True),
            (2, "Bucky Irving", "RB", 12, ["RB", "RB/WR/TE"], True),
            (3, "Aaron Jones", "RB", 11, ["RB", "RB/WR/TE"], True),
            (4, "Jaxon Smith-Njigba", "WR", 17, ["WR", "RB/WR/TE"], True),
            (5, "DJ Moore", "WR", 12, ["WR", "RB/WR/TE"], True),
            # Collins beats Barkley by projection, but cannot fill an RB slot.
            (6, "Nico Collins", "WR", 22, ["WR", "RB/WR/TE"], False),
            (7, "Lamar Jackson", "QB", 20, ["QB"], True),
            (8, "George Kittle", "TE", 10, ["TE", "RB/WR/TE"], True),
            (9, "Kicker", "K", 8, ["K"], True),
            (10, "Steelers D/ST", "D/ST", 8, ["D/ST"], True),
        ]
        roster = [{"player_id": pid, "name": name, "position": position,
                   "expected_points": estimate, "eligible_positions": eligibility,
                   "lineup_status": "starter" if starter else "bench", "is_starter": starter,
                   "lineup_slot": position if position != "RB" or name != "Aaron Jones" else "RB/WR/TE",
                   "custom_projection": {"our_projection": estimate, "floor": estimate - 5,
                                        "median": estimate, "ceiling": estimate + 5}}
                  for pid, name, position, estimate, eligibility, starter in rows]
        result = optimize_lineup(roster, slots, week=4, confidence_aware=True)

        starters = result["starters"]
        self.assertTrue(result["legal_lineup"])
        self.assertEqual(result["unfilled_slots"], [])
        self.assertEqual(len(starters), 9)
        self.assertEqual(len({player["player_id"] for player in starters}), 9)
        self.assertEqual(sum(player["recommended_slot"] == "QB" for player in starters), 1)
        self.assertEqual(sum(player["recommended_slot"] == "RB" for player in starters), 2)
        self.assertEqual(sum(player["recommended_slot"] == "WR" for player in starters), 2)
        self.assertEqual(sum(player["recommended_slot"] == "TE" for player in starters), 1)
        self.assertEqual(sum(player["recommended_slot"] == "K" for player in starters), 1)
        self.assertEqual(sum(player["recommended_slot"] == "D/ST" for player in starters), 1)
        self.assertIn("Saquon Barkley", {player["name"] for player in starters})
        collins = next(player for player in starters if player["name"] == "Nico Collins")
        self.assertIn(collins["recommended_slot"], {"WR", "RB/WR/TE"})
        self.assertTrue(collins["eligible_positions"] and collins["recommended_slot"] in collins["eligible_positions"])
        flex = next(player for player in starters if player["recommended_slot"] == "RB/WR/TE")
        self.assertIn(flex["position"], {"RB", "WR", "TE"})
        self.assertIn(collins["recommended_slot_label"], {"WR1", "WR2", "FLEX"})

    def test_bye_only_defense_leaves_slot_unfilled_and_preserves_other_optimal_starters(self):
        slots = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "RB/WR/TE": 1, "K": 1, "D/ST": 1}
        positions = ["QB", "RB", "RB", "WR", "WR", "TE", "RB", "K", "D/ST", "WR"]
        roster = [{"player_id": index, "name": f"Player {index}", "position": position,
                   "lineup_status": "bench", "bye_week": 9 if position == "D/ST" else 12,
                   "eligible_positions": [position, "RB/WR/TE"] if position in {"RB", "WR", "TE"} else [position],
                   "custom_projection": {"our_projection": 10 + index}}
                  for index, position in enumerate(positions)]
        original = deepcopy(roster)
        for confidence_aware in (False, True):
            with self.subTest(confidence_aware=confidence_aware):
                complete = optimize_lineup(roster, slots, week=8, confidence_aware=confidence_aware)
                incomplete = optimize_lineup(roster, slots, week=9, confidence_aware=confidence_aware)
                self.assertTrue(complete["legal_lineup"])
                self.assertEqual(complete["unfilled_slots"], [])
                self.assertEqual(len(complete["starters"]), 9)
                self.assertFalse(incomplete["legal_lineup"])
                self.assertEqual(incomplete["unfilled_slots"], ["D/ST"])
                self.assertEqual(len(incomplete["starters"]), 8)
                self.assertEqual(
                    [(p["player_id"], p["recommended_slot"], p["expected_points"]) for p in incomplete["starters"]],
                    [(p["player_id"], p["recommended_slot"], p["expected_points"]) for p in complete["starters"]
                     if p["recommended_slot"] != "D/ST"])
                defense = next(p for p in incomplete["bench"] if p["position"] == "D/ST")
                self.assertEqual(defense["bye_week"], 9)
                self.assertEqual(defense["custom_projection"], original[8]["custom_projection"])
                self.assertEqual(len({p["player_id"] for p in incomplete["starters"] + incomplete["bench"]}), len(roster))
                available_again = optimize_lineup(roster, slots, week=10, confidence_aware=confidence_aware)
                self.assertTrue(available_again["legal_lineup"])
                self.assertEqual(available_again["starters"], complete["starters"])
        self.assertEqual(roster, original, "Optimization must not mutate BYE state or projection inputs")

    def test_missing_required_position_is_reported_without_discarding_eligible_players(self):
        roster = [{"player_id": 1, "name": "Quarterback", "eligible_positions": ["QB"],
                   "lineup_status": "starter", "custom_projection": {"our_projection": 20}}]
        result = optimize_lineup(roster, {"QB": 1, "D/ST": 1}, week=9, confidence_aware=True)
        self.assertFalse(result["legal_lineup"])
        self.assertEqual(result["unfilled_slots"], ["D/ST"])
        self.assertEqual([p["player_id"] for p in result["starters"]], [1])
        self.assertEqual(result["starters"][0]["recommended_slot"], "QB")
        self.assertEqual(result["bench"], [])

    def test_missing_confidence_and_extreme_custom_disagreement_shrink_to_real_references(self):
        incumbent = {
            "name": "Established starter scenario", "position": "RB", "is_starter": True,
            "season_fantasy_average": 16.2, "projected_fantasy_points": 14.3,
            "custom_projection": {"our_projection": 4.72, "espn_projection": 14.3,
                                 "confidence": None, "confidence_basis": {},
                                 "standard_deviation": None, "adjustments": []},
        }
        alternative = {
            "name": "Modest alternative scenario", "position": "RB", "is_starter": False,
            "season_fantasy_average": 12.8, "projected_fantasy_points": 12.7,
            "custom_projection": {"our_projection": 12.4, "espn_projection": 12.7,
                                 "confidence": "low", "confidence_basis": {"prior_games": 2,
                                 "shrinkage_from_observed_variance": 0.3}, "standard_deviation": 6.0,
                                 "adjustments": []},
        }
        roster = [incumbent, alternative]
        incumbent_value, _, details = confidence_aware_value(incumbent)
        alternative_value, _, alternative_details = confidence_aware_value(alternative)
        alternative.update(alternative_details, expected_points=alternative_value)
        assessment = assess_start_sit_swap(alternative, incumbent, roster)

        self.assertEqual(details["raw_custom_projection"], 4.72)
        self.assertEqual(details["custom_weight"], 0.0)
        self.assertTrue(details["model_disagreement"]["flagged"])
        self.assertGreater(incumbent_value, 14.0)
        self.assertLess(alternative_value, incumbent_value)
        self.assertEqual(assessment["confidence"], "low")
        self.assertTrue(assessment["established_starter_protection"])
        self.assertIsNone(assessment["uncertainty"])

    def test_strong_reliable_evidence_can_still_support_benching_established_starter(self):
        incumbent = {
            "name": "Established starter with supported decline", "position": "WR", "is_starter": True,
            "season_fantasy_average": 18.0, "projected_fantasy_points": 8.5, "custom_weight": 0.9,
            "custom_projection": {"our_projection": 8.0, "espn_projection": 8.5, "confidence": "high",
                                 "confidence_basis": {"prior_games": 10, "shrinkage_from_observed_variance": 0.9},
                                 "standard_deviation": 1.0,
                                 "adjustments": [{"key": "opportunity", "adjustment": -6.0}]},
        }
        alternative = {
            "name": "Reliable alternative", "position": "WR", "is_starter": False,
            "season_fantasy_average": 15.0, "projected_fantasy_points": 19.0, "custom_weight": 0.9,
            "custom_projection": {"our_projection": 19.5, "espn_projection": 19.0, "confidence": "high",
                                 "confidence_basis": {"prior_games": 10, "shrinkage_from_observed_variance": 0.9},
                                 "standard_deviation": 1.0,
                                 "adjustments": [{"key": "opportunity", "adjustment": 3.0}]},
            "expected_points": 19.0,
        }
        assessment = assess_start_sit_swap(alternative, incumbent, [incumbent, alternative])
        self.assertTrue(assessment["established_starter_protection"])
        self.assertEqual(assessment["confidence"], "high")
        self.assertGreater(assessment["expected_advantage"], 2 * assessment["uncertainty"])

    def test_swap_inside_observed_uncertainty_is_a_toss_up(self):
        incumbent = {
            "name": "Current starter", "position": "TE", "is_starter": True,
            "season_fantasy_average": 9.0, "custom_weight": 0.6,
            "custom_projection": {"our_projection": 9.0, "confidence": "medium",
                                 "confidence_basis": {"prior_games": 5, "shrinkage_from_observed_variance": 0.6},
                                 "standard_deviation": 5.0, "adjustments": []},
        }
        alternative = {
            "name": "Alternative", "position": "TE", "is_starter": False,
            "custom_weight": 0.6, "expected_points": 9.7,
            "custom_projection": {"our_projection": 9.7, "confidence": "medium",
                                 "confidence_basis": {"prior_games": 5, "shrinkage_from_observed_variance": 0.6},
                                 "standard_deviation": 5.0, "adjustments": []},
        }
        assessment = assess_start_sit_swap(alternative, incumbent, [incumbent, alternative])
        self.assertEqual(assessment["confidence"], "low")
        self.assertLess(assessment["expected_advantage"], assessment["uncertainty"])


if __name__ == "__main__":
    unittest.main()
