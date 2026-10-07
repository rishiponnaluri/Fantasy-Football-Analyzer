"""Evidence-confidence regressions; projection values themselves stay unchanged."""
import unittest

import numpy as np

from prediction_service import _confidence
from projection_engine import project_player


def history(values):
    return [{"week": week, "fantasy_points": value, "stats": {"receivingTargets": 8, "rushingAttempts": 0}}
            for week, value in enumerate(values, 1)]


class ProjectionConfidenceTests(unittest.TestCase):
    def test_established_stable_player_can_be_high(self):
        player = {"player_id": 1, "position": "WR", "projected_fantasy_points": 18.0,
                  "injury_status": "ACTIVE", "nfl_opponent": "SEA", "game_log": history([17, 19, 18, 20, 17, 19]),
                  "_projection_context": {"role_trend": {"recent_snap_share": .86, "season_snap_share": .85,
                      "recent_opportunities_per_game": 8, "earlier_opportunities_per_game": 8,
                      "sample_games": 5}, "defensive_matchup": {"available": True},
                      "team_and_game_environment": {"available": True}}}
        result = project_player(player, 7)
        self.assertEqual(result["confidence"], "high")
        self.assertGreaterEqual(result["confidence_basis"]["score"], 80)

    def test_large_source_disagreement_caps_confidence_at_medium(self):
        player = {"player_id": 4, "position": "WR", "projected_fantasy_points": 26.0,
                  "injury_status": "ACTIVE", "nfl_opponent": "SEA",
                  "game_log": history([17, 19, 18, 20, 17, 19]),
                  "_projection_context": {"role_trend": {"recent_snap_share": .86, "season_snap_share": .85,
                      "recent_opportunities_per_game": 8, "earlier_opportunities_per_game": 8,
                      "sample_games": 5}, "defensive_matchup": {"available": True},
                      "team_and_game_environment": {"available": True}}}
        result = project_player(player, 7)
        self.assertGreaterEqual(result["confidence_basis"]["score"], 80)
        self.assertLess(result["confidence_basis"]["components"]["source_agreement"], 55)
        self.assertFalse(result["confidence_basis"]["high_confidence_eligible"])
        self.assertEqual(result["confidence"], "medium")

    def test_new_starter_and_unresolved_status_are_low(self):
        player = {"player_id": 2, "position": "RB", "projected_fantasy_points": 15,
                  "injury_status": "QUESTIONABLE", "game_log": history([3]),
                  "_projection_context": {"role_trend": {"role_direction": "increasing", "sample_games": 1}}}
        result = project_player(player, 3)
        self.assertEqual(result["confidence"], "low")
        self.assertLess(result["confidence_basis"]["score"], 55)

    def test_status_change_reduces_projection_confidence(self):
        player = {"player_id": 3, "position": "RB", "projected_fantasy_points": 14,
                  "injury_status": "ACTIVE", "nfl_opponent": "SEA", "game_log": history([12, 14, 13, 15, 14]),
                  "_projection_context": {"role_trend": {"recent_snap_share": .7, "season_snap_share": .7,
                      "recent_opportunities_per_game": 15, "earlier_opportunities_per_game": 15,
                      "sample_games": 4}, "defensive_matchup": {"available": True},
                      "team_and_game_environment": {"available": True}}}
        healthy = project_player(player, 6)
        player["injury_status"] = "DOUBTFUL"
        injured = project_player(player, 6)
        self.assertLess(injured["confidence_basis"]["score"], healthy["confidence_basis"]["score"])


class MatchupConfidenceTests(unittest.TestCase):
    def test_narrow_pregame_simulation_is_low_confidence(self):
        players = [{"status": "pre", "sd": 8, "mean": 15, "confidence_score": 75,
                    "injury_status": "ACTIVE"} for _ in range(18)]
        label, score, _, reasons = _confidence(players, np.array([120., 130.]), np.array([119., 131.]), .52, .48)
        self.assertEqual(label, "low")
        self.assertLess(score, 55)
        self.assertIn("The simulated win chances are close.", reasons)

    def test_clear_pregame_favorite_is_distinguished_from_toss_up(self):
        players = [{"status": "pre", "sd": 8, "mean": 15, "confidence_score": 85,
                    "injury_status": "ACTIVE"} for _ in range(18)]
        label, score, _, _ = _confidence(players, np.array([130., 132.]), np.array([110., 112.]), .78, .22)
        self.assertEqual(label, "medium")
        self.assertGreaterEqual(score, 55)

    def test_large_edge_with_completed_points_is_high_confidence(self):
        players = [{"status": "completed", "fixed": 110, "mean": 110, "confidence_score": 85}]
        players += [{"status": "in", "fixed": None, "mean": 8, "sd": 1, "confidence_score": 85,
                     "injury_status": "ACTIVE"}]
        label, score, components, _ = _confidence(players, np.array([122., 123., 124.]),
                                                   np.array([111., 112., 113.]), .96, .04)
        self.assertEqual(label, "high")
        self.assertGreaterEqual(score, 80)
        self.assertGreater(components["completed_scoring"], 80)


if __name__ == "__main__":
    unittest.main()
