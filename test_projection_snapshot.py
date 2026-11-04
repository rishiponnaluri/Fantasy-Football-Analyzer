import copy
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import projection_snapshot as ps
from projection_engine import project_players
from recommendation_service import confidence_aware_value


class ProjectionSnapshotTest(unittest.TestCase):
    def setUp(self):
        ps._CURRENT.clear(); ps._VERSIONS.clear(); ps._LOCKS.clear()
        self.service = SimpleNamespace(league=SimpleNamespace(league_id=999, year=2026, current_week=6))
        self.players = [{'player_id': i, 'name': f'Player {i}', 'position': 'TE',
                         'projected_fantasy_points': 12 + i, 'season_fantasy_average': 10 + i,
                         'game_log': [{'week': w, 'fantasy_points': float(6 + w * i)} for w in range(1, 6)]}
                        for i in [1, 2, 3]]
        models = project_players(self.players, 6, 6)
        self.payload = {'week': 6, 'last_updated': '2026-10-19T00:00:00+00:00',
                        'players': [{'player_id': p['player_id'], 'player': p, 'projection': models[p['player_id']]} for p in self.players]}

    def test_single_flight_and_consistent_canonical_value(self):
        with patch('projection_sources.espn._build_league_projection_payload', side_effect=lambda *a: copy.deepcopy(self.payload)) as build:
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: ps.snapshot(self.service, 6), range(8)))
            self.assertEqual(build.call_count, 1)
            for result in results: self.assertEqual(result, results[0])
            for surface in ('dashboard', 'quick_view', 'start_sit', 'trade'):
                subset, _ = ps.resolve_players(self.service, 6, [self.players[0]])
                value = subset[1]['custom_projection']['recommendation_projection']
                self.assertEqual(value, results[0]['players'][0]['projection']['recommendation_projection'], surface)
                self.assertEqual(confidence_aware_value(subset[1])[0], value)
            self.assertEqual(build.call_count, 1, 'Quick View must not rebuild the cohort')

    def test_refresh_is_atomic_and_unchanged_inputs_keep_values(self):
        with patch('projection_sources.espn._build_league_projection_payload', side_effect=lambda *a: copy.deepcopy(self.payload)):
            old = ps.snapshot(self.service, 6)
            same = ps.snapshot(self.service, 6, refresh=True)
            self.assertEqual(old['input_fingerprint'], same['input_fingerprint'])
            self.assertEqual(old['players'][0]['projection']['recommendation_projection'], same['players'][0]['projection']['recommendation_projection'])
            self.assertNotEqual(old['snapshot_id'], same['snapshot_id'])
            self.payload['players'][0]['projection']['our_projection'] += 4
            new = ps.snapshot(self.service, 6, refresh=True)
            self.assertNotEqual(old['snapshot_id'], new['snapshot_id'])
            token = ps.requested_snapshot.set(old['snapshot_id'])
            try: self.assertEqual(ps.snapshot(self.service, 6)['players'], old['players'])
            finally: ps.requested_snapshot.reset(token)

    def test_point_model_deterministic(self):
        self.assertEqual(project_players(self.players, 6, 6), project_players(self.players, 6, 6))

    def test_failed_refresh_does_not_replace_published_snapshot(self):
        with patch('projection_sources.espn._build_league_projection_payload', return_value=copy.deepcopy(self.payload)):
            old = ps.snapshot(self.service, 6)
        with patch('projection_sources.espn._build_league_projection_payload', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError): ps.snapshot(self.service, 6, refresh=True)
            self.assertEqual(ps.snapshot(self.service, 6)['snapshot_id'], old['snapshot_id'])

    def test_extra_player_is_single_flight_and_refresh_can_update_it(self):
        extra = {**self.players[0], 'player_id': 44, 'name': 'Available player'}
        self.service.player_insights = lambda ids, week: {44: dict(extra)}
        def enrich(players, *args):
            return {p['player_id']: p for p in players}, {}
        with patch('projection_sources.espn._build_league_projection_payload', side_effect=lambda *a: copy.deepcopy(self.payload)), \
             patch('projection_sources.context.enrich_players', side_effect=enrich) as context:
            first, _ = ps.resolve_players(self.service, 6, [extra])
            again, _ = ps.resolve_players(self.service, 6, [extra])
            self.assertEqual(first[44]['recommendation_projection'], again[44]['recommendation_projection'])
            self.assertEqual(context.call_count, 1)
            extra['projected_fantasy_points'] += 10
            ps.snapshot(self.service, 6, refresh=True)
            changed, _ = ps.resolve_players(self.service, 6, [extra])
            self.assertNotEqual(first[44]['recommendation_projection'], changed[44]['recommendation_projection'])
            self.assertEqual(context.call_count, 2)
