import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import player_news as news
from scripts.refresh_player_news import run_once


class PlayerNewsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'WATCHLIST_DB_PATH': self.tmp.name + '/test.sqlite3'})
        self.env.start()
        self.player = {'player_id': 1, 'name': 'Player One', 'nfl_team': 'SEA', 'injury_status': 'OUT'}

    def tearDown(self):
        self.env.stop(); self.tmp.cleanup()

    def test_dedupe_attribution_and_no_invented_url(self):
        first = news.record(self.player, 10, 6, 'ESPN Fantasy roster status', 'availability', 'OUT', '2026-10-19T12:00:00Z')
        later = {**first, 'retrieved_at': '2026-10-19T13:00:00Z'}
        self.assertEqual(news.store([first, later]), 1)
        saved = news.updates(10, 1)[0]
        self.assertIsNone(saved['url']); self.assertIsNone(saved['published_at'])
        self.assertEqual(saved['source'], 'ESPN Fantasy roster status')
        self.assertEqual(saved['impact'], 'HIGH')
        self.assertEqual(news.impact('practice', 'Limited'), 'MEDIUM')
        self.assertEqual(news.impact('team_news', 'Article'), 'LOW')

    def test_matching_requires_provider_id_and_week(self):
        meta = {'injuries': {'retrieved_at': '2026-10-19T12:00:00Z', 'url': 'https://example.org/feed'}, 'weekly_rosters': {}}
        rows = [{'gsis_id': 'a', 'week': '6', 'season_type': 'REG', 'report_status': 'OUT'},
                {'gsis_id': 'b', 'week': '6', 'season_type': 'REG', 'report_status': 'Q'}]
        result = news.normalize_nflverse([self.player], 10, 6, {'1': {'gsis_id': 'a'}}, rows, [], meta)
        self.assertEqual(len(result), 1); self.assertEqual(result[0]['player_id'], 1)
        self.assertEqual(result[0]['url'], meta['injuries']['url'])
        self.assertEqual(news.normalize_nflverse([self.player], 10, 6, {}, rows, [], meta), [])

    def test_job_uses_service_and_provider_failure_is_isolated(self):
        service = SimpleNamespace(league=SimpleNamespace(league_id=10, year=2026), week=lambda _: 6,
                                  my_team_info=lambda _: {'roster': [self.player]}, player_insights=lambda *_: {})
        with patch('main.get_espn_service', return_value=service), patch('projection_sources.cache.nflverse_csv', side_effect=RuntimeError('offline')):
            result = run_once()
            self.assertEqual(result['status'], 'partial')
            self.assertEqual(result['monitored'], 1)
            self.assertEqual(len(news.updates(10, 1)), 1)
            self.assertEqual(run_once()['status'], 'cached')

    def test_script_calls_same_job(self):
        with patch('main.get_espn_service', return_value='service'), patch('player_news.refresh', return_value={'status': 'ok'}) as refresh:
            self.assertEqual(run_once(True)['status'], 'ok')
            refresh.assert_called_once_with('service', force=True)

    def test_feed_update_time_is_not_invented_report_publication(self):
        sources = {'injuries': {'retrieved_at': '2026-10-19T12:00:00Z',
                               'source_updated_at': '2026-10-19T10:00:00Z',
                               'url': 'https://example.org/feed'}, 'weekly_rosters': {}}
        rows = [{'gsis_id': 'a', 'week': '6', 'season_type': 'REG', 'report_status': 'OUT'}]
        result = news.normalize_nflverse([self.player], 10, 6, {'1': {'gsis_id': 'a'}}, rows, [], sources)
        self.assertIsNone(result[0]['published_at'])
        self.assertEqual(result[0]['source_updated_at'], sources['injuries']['source_updated_at'])
        self.assertEqual(news.store(result), 1)
        sources['injuries']['source_updated_at'] = '2026-10-19T11:00:00Z'
        repeated = news.normalize_nflverse([self.player], 10, 6, {'1': {'gsis_id': 'a'}}, rows, [], sources)
        self.assertEqual(news.store(repeated), 0, 'An unrelated feed timestamp change cannot duplicate identical player news')
