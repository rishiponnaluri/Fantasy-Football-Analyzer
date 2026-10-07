"""The same automatic trade-position filter is shared by every search path."""
import unittest

from trade_service import _trade_position_set, _matches_trade_positions


class TradePositionFilterTests(unittest.TestCase):
    def test_single_and_multiple_position_filters(self):
        rb = _trade_position_set(positions=["RB"])
        self.assertTrue(_matches_trade_positions({"position": "RB"}, rb))
        self.assertFalse(_matches_trade_positions({"position": "QB"}, rb))

        rb_wr = _trade_position_set(positions=["RB", "WR"])
        self.assertTrue(_matches_trade_positions({"position": "RB"}, rb_wr))
        self.assertTrue(_matches_trade_positions({"position": "WR"}, rb_wr))
        self.assertFalse(_matches_trade_positions({"position": "TE"}, rb_wr))

    def test_flex_expands_only_to_flex_eligible_positions(self):
        flex = _trade_position_set(positions=["FLEX"])
        for position in ("RB", "WR", "TE"):
            self.assertTrue(_matches_trade_positions({"position": position}, flex))
        self.assertFalse(_matches_trade_positions({"position": "QB"}, flex))

    def test_empty_filter_matches_nothing_and_all_is_unrestricted(self):
        self.assertEqual(_trade_position_set(positions=[]), set())
        self.assertFalse(_matches_trade_positions({"position": "RB"}, set()))
        self.assertIsNone(_trade_position_set(position="ALL"))


if __name__ == "__main__":
    unittest.main()
