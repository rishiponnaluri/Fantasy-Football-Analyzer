"""Focused identity/discovery regressions. Fantasy math is deliberately not retested here."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from fantasy_team_images import image_fields, is_private_upload, team_image
from espn_service import APIError
from trade_discovery_ranking import rank_suggestions, ranking_key


def idea(verdict='YES', acceptance='HIGH', weekly=3, ros=20, replacement=15, confidence='MEDIUM', player_id=1, need=False):
    return {'partner_team_id':2,'you_give':[{'player_id':player_id}], 'you_receive':[{'player_id':player_id+100}],
            'weekly_lineup_change':{'you':weekly},'rest_of_season_change':{'you':ros},
            'positional_impact':{'you':{'RB':{'before_strength':'Weak' if need else 'Strong','after_strength':'Average'}}},
            'verdict':{'worth_it':verdict,'acceptance_likelihood':acceptance,'worth_it_confidence':confidence,
                       'worth_it_breakdown':{'value_above_replacement_change':replacement,'position_improved':['RB'] if need else []}}}


class FinalFunctionalityTests(unittest.TestCase):
    def test_custom_image_uses_observed_logo_mapping_and_proxy(self):
        team=SimpleNamespace(team_id=3,logo_url='https://mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/real-image')
        data=image_fields(team)
        self.assertEqual(data['custom_team_logo_url'],'/api/backend/teams/3/image')
        self.assertEqual(data['team_logo_url'],data['custom_team_logo_url'])
        self.assertIsNone(data['default_team_logo_url'])
        team.logo_url='https://g.espncdn.com/default.svg'
        self.assertEqual(image_fields(team)['default_team_logo_url'],team.logo_url)
        team.logo_url=None
        self.assertIsNone(image_fields(team)['team_logo_url'])

    def test_image_proxy_does_not_accept_arbitrary_destination_or_redirect(self):
        self.assertFalse(is_private_upload('https://mystique-api.fantasy.espn.com.evil.invalid/apis/v1/domains/lm/images/x'))
        service=SimpleNamespace(teams={3:SimpleNamespace(logo_url='https://example.invalid/x')})
        with self.assertRaises(APIError),patch('fantasy_team_images.requests.get') as get:
            team_image(service,3)
        get.assert_not_called()

    def test_image_proxy_preserves_server_side_auth_and_validates_image(self):
        cookie={'private':'test-only'}
        service=SimpleNamespace(teams={3:SimpleNamespace(logo_url='https://mystique-api.fantasy.espn.com/apis/v1/domains/lm/images/x')},
                                league=SimpleNamespace(espn_request=SimpleNamespace(cookies=cookie)),memoized=lambda key,ttl,load:load())
        response=Mock(status_code=200,headers={'Content-Type':'image/jpeg'})
        response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False)
        response.iter_content.return_value=[b'portrait']
        with patch('fantasy_team_images.requests.get',return_value=response) as get:
            self.assertEqual(team_image(service,3),(b'portrait','image/jpeg'))
            self.assertEqual(get.call_args.kwargs['cookies'],cookie)
            self.assertFalse(get.call_args.kwargs['allow_redirects'])
        response.status_code=302
        with patch('fantasy_team_images.requests.get',return_value=response),self.assertRaises(APIError):team_image(service,3)

    def test_directory_uses_player_positions_not_lineup_slot_ids_and_no_projection_work(self):
        from espn_service import ESPNService
        raw = [{'id': 11, 'fullName':'Test QB', 'defaultPositionId':1,'proTeamId':2},
               {'id':12,'fullName':'Test WR','defaultPositionId':3,'proTeamId':11},
               {'id':13,'fullName':'Test IDP','defaultPositionId':7,'proTeamId':2}]
        service=ESPNService.__new__(ESPNService)
        service.memoized=lambda key,ttl,load:load()
        service.league=SimpleNamespace(espn_request=SimpleNamespace(get_pro_players=Mock(return_value=raw)),teams=[])
        rows=service.player_directory()['players']
        self.assertEqual([(p['name'],p['position']) for p in rows],[('Test QB','QB'),('Test WR','WR')])
        self.assertTrue(all('custom_projection' not in p for p in rows))

    def test_eighteen_second_browser_poll_does_not_mean_eighteen_second_espn_call(self):
        import threading
        from espn_service import ESPNService
        service=ESPNService.__new__(ESPNService)
        service._memo_lock=threading.RLock();service._memo_cache={};service._memo_locks={}
        service.week=lambda selected:selected or 9
        service._fetch_fantasy_matchups=Mock(return_value={'week':9})
        service._fetch_my_team_info=Mock(return_value={'week':9})
        with patch('espn_service.time.monotonic',return_value=100):
            service.fantasy_matchups();service.my_team_info()
        with patch('espn_service.time.monotonic',return_value=118):
            service.fantasy_matchups();service.my_team_info()
        self.assertEqual(service._fetch_fantasy_matchups.call_count,1)
        self.assertEqual(service._fetch_my_team_info.call_count,1)
        with patch('espn_service.time.monotonic',return_value=136):
            service.fantasy_matchups();service.my_team_info()
        self.assertEqual(service._fetch_fantasy_matchups.call_count,2)

    def test_public_nfl_reads_single_flight_and_keep_last_good_on_failure(self):
        import nfl_service
        from projection_sources import cache
        from concurrent.futures import ThreadPoolExecutor
        key='nfl-live-json:test-only-scoreboard:{"week": 9}'
        for store in (cache._CACHE,cache._FAILURES):store.pop(key,None)
        try:
            with patch('nfl_service._get_json_uncached',return_value={'week':9,'events':[]}) as upstream:
                with ThreadPoolExecutor(max_workers=6) as pool:
                    rows=list(pool.map(lambda _:nfl_service._get_json('test-only-scoreboard',{'week':9}),range(6)))
                self.assertEqual(upstream.call_count,1)
                self.assertTrue(all(row['week']==9 for row in rows))
            stamp,value,meta=cache._CACHE[key];cache._CACHE[key]=(stamp-31,value,meta)
            with patch('nfl_service._get_json_uncached',side_effect=RuntimeError('provider down')):
                self.assertEqual(nfl_service._get_json('test-only-scoreboard',{'week':9}),{'week':9,'events':[]})
        finally:
            for store in (cache._CACHE,cache._FAILURES):store.pop(key,None)

    def test_automatic_discovery_excludes_negative_and_unnecessary_even(self):
        rows=[idea(v,player_id=i) for i,v in enumerate(['NO','LEAN NO','EVEN','YES','LEAN YES'])]
        self.assertEqual({r['verdict']['worth_it'] for r in rank_suggestions(rows)},{'YES','LEAN YES'})
        self.assertEqual(rows[0]['verdict']['worth_it'],'NO') # Manual verdict untouched.

    def test_useful_plausible_deals_precede_large_unlikely_gains(self):
        plausible=idea('LEAN YES','MEDIUM',weekly=2,player_id=1)
        unlikely=idea('YES','LOW',weekly=25,ros=300,replacement=300,player_id=2)
        self.assertEqual(rank_suggestions([unlikely,plausible]),[plausible,unlikely])

    def test_confidence_and_central_benefits_rank_deterministically(self):
        low=idea(confidence='LOW',player_id=1);high=idea(confidence='HIGH',player_id=2)
        self.assertEqual(rank_suggestions([low,high])[0],high)
        self.assertEqual(rank_suggestions([high,low]),rank_suggestions([low,high]))
        self.assertEqual(len(rank_suggestions([low,low])),1)
        self.assertLess(ranking_key(idea(weekly=3)),ranking_key(idea(weekly=0)))

    def test_even_requires_real_need_and_plausibility_and_no_positive(self):
        even=idea('EVEN','MEDIUM',need=True)
        self.assertEqual(rank_suggestions([even]),[even])
        self.assertEqual(rank_suggestions([idea('EVEN',need=False)]),[])
        self.assertEqual(rank_suggestions([idea('EVEN','LOW',need=True)]),[])
        self.assertEqual(rank_suggestions([even,idea('LEAN YES',player_id=2)])[0]['verdict']['worth_it'],'LEAN YES')

if __name__=='__main__':unittest.main()
