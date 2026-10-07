import unittest
from unittest.mock import patch

import market_odds_service


class MarketOddsTests(unittest.TestCase):
    def test_midpoints_normalize_and_keep_raw_pair_contracts(self):
        self.assertEqual(market_odds_service.normalize_binary_prices(.66, .35), (.653465, .346535))
        self.assertIsNone(market_odds_service.normalize_binary_prices(0, 0))

    def test_exact_team_pair_date_and_resolution_match(self):
        game = {
            "kickoff": "2026-10-04T17:00:00Z",
            "status": {"state": "pre"},
            "away_team": {"abbreviation": "IND"},
            "home_team": {"abbreviation": "WSH"},
        }
        rows = [
            {"event_ticker": "KXNFLGAME-26OCT04INDWAS", "ticker": "KXNFLGAME-26OCT04INDWAS-IND",
             "status": "active", "yes_bid_dollars": ".65", "yes_ask_dollars": ".67",
             "updated_time": "2026-10-01T10:00:00Z",
             "rules_primary": "If Indianapolis wins the IND Colts vs WAS Commanders Pro Football game originally scheduled for Oct 4, 2026, then the market resolves to Yes."},
            {"event_ticker": "KXNFLGAME-26OCT04INDWAS", "ticker": "KXNFLGAME-26OCT04INDWAS-WAS",
             "status": "active", "yes_bid_dollars": ".33", "yes_ask_dollars": ".35",
             "updated_time": "2026-10-01T10:00:00Z",
             "rules_primary": "If Washington wins the IND Colts vs WAS Commanders Pro Football game originally scheduled for Oct 4, 2026, then the market resolves to Yes."},
            # A loose text match is rejected because the exact event date differs.
            {"event_ticker": "KXNFLGAME-26OCT11INDWAS", "ticker": "KXNFLGAME-26OCT11INDWAS-IND",
             "status": "active", "yes_bid_dollars": ".99", "yes_ask_dollars": "1.00",
             "rules_primary": "If Indianapolis wins the IND Colts vs WAS Commanders Pro Football game originally scheduled for Oct 11, 2026, then the market resolves to Yes."},
        ]
        with patch.object(market_odds_service, "_fetch_markets", return_value=rows):
            result = market_odds_service.market_probability(game)
        self.assertEqual(result["event_identifier"], "KXNFLGAME-26OCT04INDWAS")
        self.assertAlmostEqual(result["away_probability"] + result["home_probability"], 1, places=5)
        self.assertEqual(result["source"], "Kalshi public markets")
        self.assertEqual(len(result["market_identifiers"]), 2)
        self.assertEqual(result["raw_yes_bid_ask"]["IND"]["bid"], .65)

    def test_missing_market_is_unavailable_not_a_fabricated_percentage(self):
        game = {"kickoff": "2026-10-04T17:00:00Z", "status": {"state": "pre"},
                "away_team": {"abbreviation": "IND"}, "home_team": {"abbreviation": "WSH"}}
        with patch.object(market_odds_service, "_fetch_markets", return_value=[]):
            self.assertIsNone(market_odds_service.market_probability(game))


if __name__ == "__main__":
    unittest.main()
