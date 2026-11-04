import unittest
from types import SimpleNamespace
from trade_assets import asset_value, exchange_value, apply_exchange_guardrail, plausible_exchange


class TradeAssetTest(unittest.TestCase):
    def asset(self, pid, value, uncertainty):
        return {'player_id': pid, '_trade_asset': {'supported': True, 'asset_value': value, 'uncertainty': uncertainty}}

    def test_need_cannot_erase_material_overpay(self):
        players = [self.asset(1, 150, 15), self.asset(2, 30, 10)]
        exchange = exchange_value(players, [1], [2])
        for verdict in ('YES', 'LEAN YES', 'EVEN'):
            result, _ = apply_exchange_guardrail(verdict, 'Positive lineup fit.', exchange)
            self.assertEqual(result, 'NO')
        self.assertFalse(plausible_exchange(players, [1], [2]))
        opposite = exchange_value(players, [2], [1])
        self.assertFalse(opposite['material_overpay'])

    def test_replaceable_bench_assets_can_consolidate(self):
        players = [self.asset(1, 5, 5), self.asset(2, 6, 5), self.asset(3, 75, 10)]
        exchange = exchange_value(players, [1, 2], [3])
        self.assertGreater(exchange['difference'], 0)
        self.assertTrue(plausible_exchange(players, [1, 2], [3]))
        self.assertEqual(apply_exchange_guardrail('YES', '', exchange)[0], 'YES')

    def test_two_valuable_starters_are_not_replaceable_depth(self):
        exchange = exchange_value([self.asset(1, 90, 10), self.asset(2, 80, 10), self.asset(3, 100, 10)], [1, 2], [3])
        self.assertEqual(apply_exchange_guardrail('EVEN', '', exchange)[0], 'NO')

    def test_missing_evidence_does_not_certify_discovery(self):
        self.assertFalse(plausible_exchange([{'player_id': 1}, {'player_id': 2}], [1], [2]))

    def test_asset_is_above_real_replacement_not_raw_sum(self):
        player = {'player_id': 1, 'name': 'Player', 'position': 'WR', 'season_fantasy_average': 10,
                  'custom_projection': {'our_projection': 10, 'standard_deviation': 2},
                  'future_nfl_schedule': [{'week': w} for w in [2, 3, 4]]}
        value = asset_value(player, 9, SimpleNamespace(league=SimpleNamespace(current_week=1)), 1)
        self.assertEqual(value['asset_value'], 3)
        self.assertEqual(value['ros_value'], 30)

    def test_rostered_player_cannot_be_own_replacement_in_stale_pool(self):
        from unittest.mock import patch
        from trade_assets import attach_assets
        def player(pid, rate):
            return {'player_id': pid, 'name': f'Player {pid}', 'position': 'WR',
                    'season_fantasy_average': rate,
                    'custom_projection': {'our_projection': rate, 'standard_deviation': 2},
                    'future_nfl_schedule': [{'week': 2}, {'week': 3}]}
        outgoing, available = player(1, 20), player(2, 5)
        service = SimpleNamespace(league=SimpleNamespace(current_week=1),
                                  free_agents=lambda *a: {'players': [outgoing, available]},
                                  memoized=lambda key, ttl, loader: loader())
        with patch('projection_snapshot.snapshot', return_value={'snapshot_id': 'v1', 'players': [{'player_id': 1}]}), \
             patch('projection_snapshot.resolve_players', side_effect=lambda s,w,p: ({x['player_id']:x for x in p}, {})):
            result = attach_assets(service, 1, [outgoing])[0]['_trade_asset']
            self.assertEqual(result['replacement_player_ids'], [2])
            self.assertEqual(result['replacement_weekly_rate'], 5)
