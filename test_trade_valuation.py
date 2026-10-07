"""General trade-value regressions for replacement-aware rest-of-season grading."""

import unittest
from types import SimpleNamespace

from trade_service import _value_above_replacement, _worth_it_verdict


class TradeValueAboveReplacementTest(unittest.TestCase):
    def setUp(self):
        self.service = SimpleNamespace(league=SimpleNamespace(current_week=1))

    @staticmethod
    def player(player_id, name, position, average, slot="bench"):
        return {
            "player_id": player_id, "name": name, "position": position,
            "season_fantasy_average": average, "lineup_status": slot,
            "injury_status": "ACTIVE", "future_nfl_schedule": [
                {"week": week} for week in range(1, 9)
            ], "trade_projection": {"our_projection": average, "standard_deviation": 3.0},
        }

    def test_replaceable_bench_receiver_gets_credit_for_upgrade_and_roster_fit(self):
        replaceable_wr = self.player(1, "Bench WR", "WR", 5.0)
        wr_replacement = self.player(2, "Next WR", "WR", 4.0)
        rb_replacement = self.player(3, "Next RB", "RB", 6.0)
        rb_starter = self.player(4, "Incoming RB", "RB", 15.0)
        roster = [replaceable_wr, wr_replacement, rb_replacement]
        after = [wr_replacement, rb_replacement, rb_starter]
        before_state = {"roster": roster, "starter_ids": set()}
        after_state = {"roster": after, "starter_ids": set()}
        report = _value_above_replacement(self.service, 1, before_state, after_state,
                                         roster + [rb_starter], [1], [4])
        self.assertTrue(report["supported"])
        self.assertGreater(report["difference"], 0)
        self.assertEqual(report["replacement_levels"]["WR"]["player_id"], 2,
                         "The asset being traded cannot be its own replacement level.")

        verdict, _, _ = _worth_it_verdict(
            0.0, {"supported": True, "difference": 80.0, "uncertainty": 8.0},
            report, [], {"RB": {"usable_depth_change": 1}}, {"you_receive": [{"injury_status": "ACTIVE"}]})
        self.assertIn(verdict, {"YES", "LEAN YES"})

    def test_opposite_side_of_same_value_gap_is_negative(self):
        verdict, _, _ = _worth_it_verdict(
            0.0, {"supported": True, "difference": -80.0, "uncertainty": 8.0},
            {"supported": True, "difference": -65.0}, [], {}, {"you_receive": [{"injury_status": "ACTIVE"}]})
        self.assertIn(verdict, {"LEAN NO", "NO"})

    def test_two_valuable_starters_for_a_slightly_better_player_is_not_automatic_yes(self):
        verdict, _, _ = _worth_it_verdict(
            0.5, {"supported": True, "difference": -40.0, "uncertainty": 10.0},
            {"supported": True, "difference": -35.0}, [], {}, {"you_receive": [{"injury_status": "ACTIVE"}]})
        self.assertIn(verdict, {"LEAN NO", "NO"})

    def test_two_replaceable_bench_assets_can_be_consolidated_for_superior_starter(self):
        verdict, _, details = _worth_it_verdict(
            0.0, {"supported": True, "difference": 70.0, "uncertainty": 12.0},
            {"supported": True, "difference": 58.0}, [], {"RB": {"usable_depth_change": 1}},
            {"you_receive": [{"injury_status": "ACTIVE"}]})
        self.assertEqual(verdict, "YES")
        self.assertGreater(details["value_above_replacement_change"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
