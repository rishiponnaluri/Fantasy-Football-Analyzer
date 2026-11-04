// These checks require the running frontend AND real FastAPI league connection.
// There are no mocked requests, fixture responses, or substituted league data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveRefreshIntervalMs } from '../src/lib/live-refresh.mjs';
const frontend = process.env.FRONTEND_URL || 'http://127.0.0.1:3000';
const backend = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
async function get(url, status = 200) {
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assert.match(response.headers.get('content-type'), /application\/json/);
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes('espn_s2') && !serialized.includes('SWID'));
  return data;
}
async function send(url, method, body, status = 200) {
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  assert.match(response.headers.get('content-type'), /application\/json/);
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes('espn_s2') && !serialized.includes('SWID'));
  return data;
}
function withoutRetrievalTimes(value) {
  if (Array.isArray(value)) return value.map(withoutRetrievalTimes);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'retrieved_at').map(([key, item]) => [key, withoutRetrievalTimes(item)]),
  );
  return value;
}
test('automatic refresh cadence tightens for live NFL games', () => {
  assert.equal(liveRefreshIntervalMs('live'), 30_000);
  assert.equal(liveRefreshIntervalMs('idle'), 120_000);
  assert.equal(liveRefreshIntervalMs('unknown'), 60_000);
});
test('frontend serves the real dashboard application', async () => {
  const response = await fetch(frontend);
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const label of ['Dashboard', 'My Team', 'League Matchups', 'Start/Sit', 'Waivers', 'NFL Schedule']) assert.ok(html.includes(label));
  assert.ok(!html.includes('Coming Soon') && !html.includes('IN DEVELOPMENT'));
  assert.ok(html.includes('Fantasy Football Analyzer'));
  assert.ok(html.includes('Analyzer'));
  assert.ok(!html.includes('Ask Analyzer'));
  assert.ok(!html.includes('Fourth &amp; Goal'));
});

test('league-wide Trade Targets proxy only returns real two-sided improving packages', async () => {
  const league = await get(`${frontend}/api/backend/league`);
  const data = await get(`${frontend}/api/backend/trades/targets?week=${league.current_week}&position=ALL`);
  assert.equal(data.week, league.current_week);
  assert.ok(Array.isArray(data.trade_targets));
  assert.ok(data.model.includes('roster-aware trade analyzer'));
  const matchups = await get(`${frontend}/api/backend/fantasy-matchups/${league.current_week}`);
  const rosterIds = new Set(matchups.fantasy_matchups.flatMap(matchup => [matchup.home_team, matchup.away_team].filter(Boolean).flatMap(team => team.roster.map(player => player.player_id))));
  for (const row of data.trade_targets) {
    assert.ok(rosterIds.has(row.player.player_id));
    assert.ok(row.analysis.you_receive.some(player => player.player_id === row.player.player_id));
    assert.ok(row.analysis.weekly_lineup_change.you > 0);
    assert.ok(row.analysis.weekly_lineup_change.other_team > 0);
    assert.ok(['High', 'Medium'].includes(row.analysis.plausibility));
  }
  const wrOnly = await get(`${frontend}/api/backend/trades/targets?week=${league.current_week}&position=WR`);
  assert.ok(wrOnly.trade_targets.every(row => row.player.position === 'WR'));
});

test('automatic trade discovery shares position and manager filters across targets and packages', async () => {
  const league = await get(`${frontend}/api/backend/league`);
  const matchups = await get(`${frontend}/api/backend/fantasy-matchups/${league.current_week}`);
  const teams = matchups.fantasy_matchups.flatMap(matchup => [matchup.home_team, matchup.away_team]).filter(Boolean);
  const own = teams.find(team => team.team_id === matchups.my_team_id);
  const partner = teams.find(team => team.team_id !== matchups.my_team_id);
  assert.ok(own && partner);
  async function discover(positions, scope = 'league_wide', teamId = partner.team_id) {
    const query = new URLSearchParams({ week: String(league.current_week), search_mode: scope, mode: 'balanced' });
    if (scope === 'specific_team') query.set('team_id', String(teamId));
    for (const position of positions) query.append('positions', position);
    return get(`${frontend}/api/backend/trades/discovery?${query}`);
  }
  for (const selected of [['RB'], ['WR'], ['RB', 'WR']]) {
    const data = await discover(selected);
    const allowed = new Set(selected);
    for (const row of data.trade_targets) assert.ok(allowed.has(row.player.position));
    for (const proposal of data.suggestions) {
      assert.ok(proposal.you_receive.some(player => allowed.has(player.position)),
        `received package must include one selected target position: ${JSON.stringify(selected)}`);
    }
  }
  const selectedTeam = await discover(['RB'], 'specific_team', partner.team_id);
  assert.equal(selectedTeam.search_mode, 'specific_team');
  assert.equal(selectedTeam.target_team_id, partner.team_id);
  for (const row of selectedTeam.trade_targets) {
    assert.equal(row.team_id, partner.team_id);
    assert.equal(row.player.position, 'RB');
  }
  for (const proposal of selectedTeam.suggestions) {
    assert.equal(proposal.partner_team_id, partner.team_id);
    assert.ok(proposal.you_receive.some(player => player.position === 'RB'));
  }
});

test('removed assistant endpoint is not exposed by the frontend proxy', async () => {
  await get(`${frontend}/api/backend/assistant`, 404);
});
test('player profiles and NFL live status are proxied from ESPN without client credentials', async () => {
  const roster = await get(`${frontend}/api/backend/my-team`);
  const playerId = roster.roster[0].player_id;
  const [profile, upstream, live, nflStatus] = await Promise.all([
    get(`${frontend}/api/backend/players/${playerId}`), get(`${backend}/api/players/${playerId}`),
    get(`${frontend}/api/backend/nfl/live-status`), get(`${backend}/api/nfl/live-status`),
  ]);
  assert.equal(profile.player_id, playerId);
  assert.equal(profile.name, upstream.name);
  assert.match(profile.headshot_url, /^https:\/\/a\.espncdn\.com\/i\/headshots\/nfl\/players\/full\//);
  assert.equal(profile.roster_status, 'rostered');
  assert.ok(profile.rankings && Object.hasOwn(profile.rankings, 'season_points'));
  assert.ok(Array.isArray(profile.news));
  for (const field of ['nfl_team_id','jersey_number','injury_status','nfl_opponent','nfl_game_time','bye_week','fantasy_points','projected_fantasy_points','season_fantasy_average','last_3_games','last_5_games','game_log','weekly_stats','game_stats']) assert.deepEqual(profile[field], upstream[field]);
  const { source_status: _profileSources, ...profileProjection } = profile.custom_projection;
  const { source_status: _upstreamSources, ...upstreamProjection } = upstream.custom_projection;
  // Independent real requests may receive equivalent cached weather/source
  // evidence milliseconds apart. Compare all model data but that retrieval time.
  assert.deepEqual(withoutRetrievalTimes(profileProjection), withoutRetrievalTimes(upstreamProjection));
  assert.ok(profile.custom_projection.source_status.sources.player_stats.available);
  assert.ok(upstream.custom_projection.source_status.sources.player_stats.available);
  assert.deepEqual(live.in_progress_team_ids, nflStatus.in_progress_team_ids);
  assert.ok(Array.isArray(live.in_progress_team_ids));
  const page = await fetch(`${frontend}/players/${playerId}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('player-detail-loading'));
  const defense = roster.roster.find(player => player.player_id < 0);
  if (defense) {
    const defenseProfile = await get(`${frontend}/api/backend/players/${defense.player_id}`);
    assert.equal(defenseProfile.player_id, defense.player_id);
  }
});
test('player model projections are real, deterministic, and proxied without credentials', async () => {
  const league = await get(`${frontend}/api/backend/league`);
  const week = league.current_week;
  const [data, upstream, matchups] = await Promise.all([
    get(`${frontend}/api/backend/projections?week=${week}`), get(`${backend}/api/projections?week=${week}`),
    get(`${backend}/api/fantasy-matchups/${week}`),
  ]);
  assert.equal(data.week, week);
  assert.equal(data.player_count, upstream.player_count);
  assert.match(data.model, /empirical-Bayes/);
  const rostered = new Map(matchups.fantasy_matchups.flatMap(matchup => [matchup.home_team, matchup.away_team].filter(Boolean).flatMap(team => team.roster.map(player => [player.player_id, player]))));
  assert.equal(data.players.length, rostered.size);
  for (const record of data.players) {
    const player = rostered.get(record.player_id);
    assert.ok(player);
    assert.equal(record.projection.espn_projection, player.projected_fantasy_points);
    assert.ok(['low','medium','high'].includes(record.projection.confidence));
    assert.ok(Array.isArray(record.projection.adjustments));
    const { our_projection: ours, espn_projection: espn } = record.projection;
    if (ours !== null && espn !== null) {
      const total = espn + record.projection.adjustments.reduce((sum, item) => sum + item.adjustment, 0);
      assert.ok(Math.abs(ours - total) < 0.01);
    }
    if (ours !== null && record.projection.floor !== null) {
      assert.ok(record.projection.floor <= record.projection.median);
      assert.ok(record.projection.median <= record.projection.ceiling);
    }
  }
});
test('league and roster proxy agree with independent real FastAPI requests', async () => {
  const [league, original, team, originalTeam] = await Promise.all([
    get(`${frontend}/api/backend/league`), get(`${backend}/api/league`),
    get(`${frontend}/api/backend/my-team`), get(`${backend}/api/my-team`),
  ]);
  assert.equal(league.league_name, original.league_name);
  assert.equal(league.current_week, original.current_week);
  assert.equal(team.team_id, originalTeam.team_id);
  assert.equal(team.team_name, originalTeam.team_name);
  assert.deepEqual(team.roster.map(p => p.player_id), originalTeam.roster.map(p => p.player_id));
  assert.ok(team.roster.some(p => p.is_starter));
  assert.ok(team.roster.some(p => p.lineup_status === 'bench'));
  assert.equal(team.roster.length, originalTeam.roster.length);
});
test('current, previous and future fantasy weeks return every real contest', async () => {
  const league = await get(`${frontend}/api/backend/league`);
  const weeks = [...new Set([Math.max(league.first_week, league.current_week - 1), league.current_week, Math.min(league.last_week, league.current_week + 1)])];
  for (const week of weeks) {
    const [data, upstream] = await Promise.all([
      get(`${frontend}/api/backend/fantasy-matchups/${week}`), get(`${backend}/api/fantasy-matchups/${week}`),
    ]);
    assert.equal(data.week, week);
    assert.deepEqual(data.fantasy_matchups.map(m => m.fantasy_matchup_id), upstream.fantasy_matchups.map(m => m.fantasy_matchup_id));
    assert.ok(data.fantasy_matchups.some(m => m.involves_my_team));
    for (const matchup of data.fantasy_matchups) {
      for (const side of ['home_team','away_team']) {
        const team = matchup[side];
        if (!team) continue;
        assert.equal(typeof team.team_name, 'string');
        assert.ok(Array.isArray(team.roster));
        for (const player of team.roster) {
          assert.equal(player.week, week);
          for (const field of ['fantasy_points','projected_fantasy_points']) assert.ok(player[field] === null || typeof player[field] === 'number');
        }
      }
    }
  }
});
test('unpublished future fantasy matchups stay empty and validation errors stay useful', async () => {
  const league = await get(`${frontend}/api/backend/league`);
  const [data, original] = await Promise.all([
    get(`${frontend}/api/backend/fantasy-matchups/${league.last_week}`), get(`${backend}/api/fantasy-matchups/${league.last_week}`),
  ]);
  assert.equal(data.week, league.last_week);
  assert.equal(data.fantasy_matchups.length, original.fantasy_matchups.length);
  const error = await get(`${frontend}/api/backend/fantasy-matchups/0`, 422);
  assert.equal(error.error.code, 'invalid_request');
});

test('custom-distribution Monte Carlo covers every matchup, caches unchanged inputs, and fixes completed scores', async () => {
  const league = await get(`${frontend}/api/backend/league`);
  const [matchups, first] = await Promise.all([
    get(`${frontend}/api/backend/fantasy-matchups/${league.current_week}`),
    get(`${frontend}/api/backend/fantasy-predictions?week=${league.current_week}`),
  ]);
  assert.equal(first.week, league.current_week);
  assert.ok(first.simulation_count >= 25_000);
  assert.match(first.model, /Monte Carlo/);
  assert.match(first.model, /not ESPN official odds/);
  assert.deepEqual(new Set(first.predictions.map(item => item.fantasy_matchup_id)), new Set(matchups.fantasy_matchups.map(item => item.fantasy_matchup_id)));
  assert.ok(first.predictions.every(item => item.status === 'estimated'), 'each real league matchup should have an estimate');
  for (const result of first.predictions) {
    assert.equal(result.status, 'estimated');
    assert.ok(result.simulation_count >= 25_000);
    assert.ok(Math.abs(result.team_a_win_probability + result.team_b_win_probability + result.tie_probability - 1) < 0.00001);
    assert.ok(result.team_a.our_projected_score >= 0 && result.team_b.our_projected_score >= 0);
    assert.match(result.model, /custom player projection engine/);
    assert.match(result.correlation_method, /Shared zero-mean NFL game/);
    assert.ok(result.correlation_data.team_correlation_loading > 0);
    assert.match(result.game_environment_method, /Real NFL game IDs share environment draws/);
    for (const player of result.biggest_remaining_swing_players) {
      assert.ok(player.high_outcome_win_probability >= player.low_outcome_win_probability);
      assert.ok(Math.abs(player.win_probability_swing - (player.high_outcome_win_probability - player.low_outcome_win_probability)) < 0.00001);
    }
    assert.ok(result.team_a.score_percentiles.p10 <= result.team_a.score_percentiles.p25);
    assert.ok(result.team_a.score_percentiles.p25 <= result.team_a.score_percentiles.median);
    assert.ok(result.team_a.score_percentiles.median <= result.team_a.score_percentiles.p75);
    assert.ok(result.team_a.score_percentiles.p75 <= result.team_a.score_percentiles.p90);
    assert.equal(result.team_a.fixed_players.every(player => player.simulated === false), true);
    assert.equal(result.team_a.modeled_players.every(player => player.simulated === true), true);
    const source = matchups.fantasy_matchups.find(item => item.fantasy_matchup_id === result.fantasy_matchup_id);
    for (const [side, team] of [[result.team_a, source.home_team], [result.team_b, source.away_team]]) {
      const playersById = new Map(team.roster.map(player => [player.player_id, player]));
      for (const player of side.fixed_players) {
        const sourcePoints = playersById.get(player.player_id).fantasy_points;
        if (sourcePoints === null) {
          assert.equal(player.fantasy_points, 0);
          assert.ok(['structured_player_status_out', 'confirmed_nfl_bye'].includes(player.source));
        } else assert.equal(player.fantasy_points, sourcePoints);
      }
      for (const player of side.modeled_players) {
        if (player.status === 'in') assert.equal(player.current_points, playersById.get(player.player_id).fantasy_points);
      }
    }
  }
  const repeated = await get(`${frontend}/api/backend/fantasy-predictions?week=${league.current_week}`);
  const estimates = first.predictions.filter(item => item.status !== 'unavailable');
  const repeatedById = new Map(repeated.predictions.map(item => [item.fantasy_matchup_id, item]));
  const withUnfinishedPlayers = estimates.filter(item => item.team_a.modeled_players.length + item.team_b.modeled_players.length > 0);
  if (withUnfinishedPlayers.length) {
    // A live clock is itself a meaningful input: remaining uncertainty should
    // shrink between real requests, so only require a cache hit for upcoming
    // or otherwise non-live players whose context has not started changing.
    for (const item of withUnfinishedPlayers.filter(item =>
      [...item.team_a.modeled_players, ...item.team_b.modeled_players].every(player => player.status !== 'in'))) {
      assert.equal(item.team_a_win_probability, repeatedById.get(item.fantasy_matchup_id).team_a_win_probability, 'unchanged real inputs should reuse the cached simulation');
      assert.equal(item.team_b_win_probability, repeatedById.get(item.fantasy_matchup_id).team_b_win_probability);
    }
  }

  const pastWeek = Math.max(league.first_week, league.current_week - 1);
  const [pastMatchups, past] = await Promise.all([
    get(`${frontend}/api/backend/fantasy-matchups/${pastWeek}`), get(`${frontend}/api/backend/fantasy-predictions?week=${pastWeek}`),
  ]);
  assert.equal(past.week, pastWeek);
  for (const result of past.predictions.filter(item => item.status !== 'unavailable')) {
    const source = pastMatchups.fantasy_matchups.find(item => item.fantasy_matchup_id === result.fantasy_matchup_id);
    for (const side of [result.team_a, result.team_b]) {
      assert.deepEqual(side.modeled_players, [], 'completed player outcomes must never be simulated again');
      const team = [source.home_team, source.away_team].find(item => item?.team_id === side.team_id);
      assert.ok(Math.abs(side.projected_final_score - team.current_fantasy_score) < 0.01);
      assert.ok(Math.abs(side.median_simulated_score - team.current_fantasy_score) < 0.01);
    }
  }

  // The current fantasy week may be fully finished. In that case every real
  // NFL outcome correctly moves to fixed_players, so compare two upcoming
  // pregame weeks instead of demanding a simulated expectation for completed
  // actuals. Check the full selected-week input -> custom distribution -> MC
  // expectation path for each week before comparing changed real projections.
  const futureWeeks = league.fantasy_weeks.filter(week => week > league.current_week);
  const pregameSamples = [];
  const addPregameSample = async (week, response) => {
    const source = await get(`${frontend}/api/backend/fantasy-matchups/${week}`);
    const rosterById = new Map(source.fantasy_matchups.flatMap(matchup => [matchup.home_team, matchup.away_team]
      .filter(Boolean).flatMap(team => team.roster.filter(player => player.is_starter).map(player => [player.player_id, player]))));
    const modeled = new Map(response.predictions.flatMap(item => [item.team_a, item.team_b].filter(Boolean)
      .flatMap(side => side.modeled_players.map(player => [player.player_id, player]))));
    const pregame = [...modeled.values()].filter(player => player.status === 'pre');
    assert.ok(pregame.length, `Week ${week} should have real pregame players for the week-specific projection check`);
    for (const player of pregame) {
      const rosterPlayer = rosterById.get(player.player_id);
      assert.ok(rosterPlayer, `${player.name} should come from the selected ESPN week roster`);
      assert.equal(player.espn_projection, rosterPlayer.projected_fantasy_points);
      assert.ok(Math.abs(player.expected_final_score - player.custom_projection) < 0.001,
        'a pregame simulated expectation should use that selected week custom projection');
    }
    pregameSamples.push({ week, modeled });
  };

  const currentModeled = new Map(first.predictions.flatMap(item => [item.team_a, item.team_b].filter(Boolean)
    .flatMap(side => side.modeled_players.map(player => [player.player_id, player]))));
  if ([...currentModeled.values()].some(player => player.status === 'pre')) {
    await addPregameSample(league.current_week, first);
  }
  for (const week of futureWeeks) {
    if (pregameSamples.length >= 2) break;
    const response = await get(`${frontend}/api/backend/fantasy-predictions?week=${week}`);
    assert.equal(response.week, week);
    assert.ok(response.predictions.every(item => item.status === 'unavailable' || item.simulation_count >= 25_000));
    await addPregameSample(week, response);
  }

  let changed = false;
  for (let leftIndex = 0; leftIndex < pregameSamples.length && !changed; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < pregameSamples.length && !changed; rightIndex += 1) {
      const left = pregameSamples[leftIndex].modeled;
      const right = pregameSamples[rightIndex].modeled;
      changed = [...left].some(([id, current]) => {
        const upcoming = right.get(id);
        return upcoming && current.status === 'pre' && upcoming.status === 'pre'
          && typeof current.espn_projection === 'number' && typeof upcoming.espn_projection === 'number'
          && Math.abs(current.espn_projection - upcoming.espn_projection) > 0.01
          && typeof current.custom_projection === 'number' && typeof upcoming.custom_projection === 'number'
          && Math.abs(current.custom_projection - upcoming.custom_projection) > 0.01
          && Math.abs(current.expected_final_score - upcoming.expected_final_score) > 0.01;
      });
    }
  }
  if (pregameSamples.length > 1) {
    assert.ok(changed, 'a meaningful ESPN projection change between pregame weeks should change that player’s modeled expectation');
  } else {
    // When ESPN has no second configured pregame period, current-week fixed
    // scores and the single future-week projection-flow checks above are the
    // only valid real-data assertions; completed outcomes remain immutable.
    assert.equal(pregameSamples.length, 1);
  }
});

test('real NFL schedule supports separate regular-season weeks and game details', async () => {
  const current = await get(`${frontend}/api/backend/nfl/schedule`);
  assert.equal(current.sport, 'NFL');
  assert.ok(current.current_week >= 1 && current.current_week <= 18);
  assert.equal(current.week, current.current_week);
  assert.ok(Array.isArray(current.games));
  assert.ok(current.games.length > 0);
  const historicalWeek = Math.max(1, current.current_week - 1);
  const futureWeek = Math.min(18, current.current_week + 1);
  const historical = await get(`${frontend}/api/backend/nfl/schedule?week=${historicalWeek}`);
  const future = await get(`${frontend}/api/backend/nfl/schedule?week=${futureWeek}`);
  assert.equal(historical.week, historicalWeek);
  assert.equal(future.week, futureWeek);
  assert.ok(historical.games.every(game => game.home_team && game.away_team && game.event_id));
  assert.ok(future.games.every(game => game.home_team && game.away_team && game.event_id));
  const details = await get(`${frontend}/api/backend/nfl/games/${current.games[0].event_id}`);
  assert.equal(details.event_id, current.games[0].event_id);
  assert.ok(details.home_team && details.away_team);
  assert.ok(Array.isArray(details.leaders));
  const invalid = await get(`${frontend}/api/backend/nfl/schedule?week=19`, 422);
  assert.equal(invalid.error.code, 'invalid_request');
});

test('watchlist searches real ESPN players and persists labeled add/update/remove operations', async () => {
  const roster = await get(`${frontend}/api/backend/my-team`);
  const existing = await get(`${frontend}/api/backend/watchlist`);
  const existingIds = new Set(existing.items.map(item => item.player_id));
  const player = roster.roster.find(item => !existingIds.has(item.player_id));
  assert.ok(player, 'needs an unwatched real roster player for isolated CRUD verification');
  const search = await get(`${frontend}/api/backend/players/search?q=${encodeURIComponent(player.name)}&limit=20`);
  assert.ok(search.players.some(item => item.player_id === player.player_id));
  let added = false;
  try {
    const saved = await send(`${frontend}/api/backend/watchlist`, 'POST', { player_id: player.player_id, label: 'Trade Target' });
    added = true;
    assert.equal(saved.player_id, player.player_id);
    assert.equal(saved.label, 'Trade Target');
    assert.equal(saved.player.player_id, player.player_id);
    const listed = await get(`${frontend}/api/backend/watchlist`);
    assert.ok(listed.items.some(item => item.player_id === player.player_id && item.label === 'Trade Target'));
    const hydrated = listed.items.find(item => item.player_id === player.player_id)?.player;
    assert.equal(hydrated?.player_id, player.player_id);
    assert.ok(hydrated?.custom_projection, 'saved player data is batch-hydrated from the real player model');
    const updated = await send(`${frontend}/api/backend/watchlist/${player.player_id}`, 'PATCH', { label: 'Waiver Target' });
    assert.equal(updated.label, 'Waiver Target');
    const removed = await send(`${frontend}/api/backend/watchlist/${player.player_id}`, 'DELETE');
    assert.equal(removed.removed, true);
    added = false;
    const finalItems = await get(`${frontend}/api/backend/watchlist`);
    assert.ok(!finalItems.items.some(item => item.player_id === player.player_id));
  } finally {
    if (added) await send(`${frontend}/api/backend/watchlist/${player.player_id}`, 'DELETE');
  }
});

test('player search filters real ESPN rosters by NFL team, position, ownership and sort', async () => {
  const roster = await get(`${frontend}/api/backend/my-team`);
  const sample = roster.roster.find(player => player.position && player.nfl_team);
  assert.ok(sample);
  const params = new URLSearchParams({ team: sample.nfl_team, position: sample.position, status: 'rostered', sort: 'season_points', limit: '20' });
  const result = await get(`${frontend}/api/backend/players/search?${params}`);
  assert.ok(result.players.length > 0);
  assert.ok(result.players.every(player => player.nfl_team === sample.nfl_team && player.position === sample.position && player.roster_status === 'rostered'));
  const sorted = result.players.map(player => player.season_fantasy_points).filter(value => typeof value === 'number');
  assert.deepEqual(sorted, [...sorted].sort((a, b) => b - a));
  const available = await get(`${frontend}/api/backend/players/search?position=QB&status=available&limit=10`);
  assert.ok(available.players.every(player => player.position === 'QB' && player.roster_status === 'available'));
  const queriedAvailable = await get(`${frontend}/api/backend/players/search?q=Patrick&status=available&limit=30`);
  assert.ok(queriedAvailable.players.every(player => player.roster_status === 'available'),
    'name search combined with Available must exclude unknown players outside ESPN\'s free-agent pool');
  const queriedRostered = await get(`${frontend}/api/backend/players/search?q=Patrick&status=rostered&limit=30`);
  assert.ok(queriedRostered.players.every(player => player.roster_status === 'rostered'));
});

test('Trade Analyzer re-optimizes actual fantasy rosters and never submits a trade', async () => {
  const matchups = await get(`${frontend}/api/backend/fantasy-matchups`);
  const matchup = matchups.fantasy_matchups.find(item => item.involves_my_team && item.home_team && item.away_team);
  assert.ok(matchup);
  const own = matchup.home_team.team_id === matchups.my_team_id ? matchup.home_team : matchup.away_team;
  const other = matchup.home_team.team_id === matchups.my_team_id ? matchup.away_team : matchup.home_team;
  const give = own.roster.find(player => player.position && !['reserve', 'available'].includes(player.lineup_status));
  const receive = other.roster.find(player => player.position && !['reserve', 'available'].includes(player.lineup_status));
  assert.ok(give && receive);
  const result = await send(`${frontend}/api/backend/trades/analyze`, 'POST', {
    team_id: other.team_id, give_player_ids: [give.player_id], receive_player_ids: [receive.player_id], week: matchup.week,
  });
  assert.equal(result.my_team.team_id, own.team_id);
  assert.equal(result.other_team.team_id, other.team_id);
  assert.equal(result.you_give[0].player_id, give.player_id);
  assert.equal(result.you_receive[0].player_id, receive.player_id);
  assert.equal(typeof result.weekly_lineup_change.you, 'number');
  assert.equal(typeof result.weekly_lineup_change.other_team, 'number');
  assert.equal(result.weekly_lineup_change.you_starting_lineup_after.length > 0, true);
  assert.ok(result.model.includes('No trade is submitted'));
  const ideas = await get(`${frontend}/api/backend/trades/suggestions?team_id=${other.team_id}&mode=balanced&week=${matchup.week}`);
  assert.ok(Array.isArray(ideas.suggestions));
  assert.ok(Array.isArray(ideas.best_trade_targets));
  assert.ok(Array.isArray(ideas.best_trade_partners));
  assert.ok(ideas.roster_needs.you && ideas.roster_needs.other_team);
  for (const idea of ideas.suggestions) {
    assert.ok(own.roster.some(player => player.player_id === idea.you_give[0].player_id));
    assert.ok(other.roster.some(player => player.player_id === idea.you_receive[0].player_id));
    assert.ok(idea.weekly_lineup_change.you > 0 && idea.weekly_lineup_change.other_team > 0);
    assert.ok(Math.abs(idea.rest_of_season_value_fit.difference) <= idea.rest_of_season_value_fit.uncertainty);
    assert.ok(['High','Medium'].includes(idea.plausibility));
  }
  for (const mode of ['conservative', 'aggressive']) {
    const suggestions = await get(`${frontend}/api/backend/trades/suggestions?team_id=${other.team_id}&mode=${mode}&week=${matchup.week}`);
    assert.equal(suggestions.mode, mode);
    for (const idea of suggestions.suggestions) {
      assert.equal(idea.mode, mode);
      assert.ok(own.roster.some(player => player.player_id === idea.you_give[0].player_id));
      assert.ok(other.roster.some(player => player.player_id === idea.you_receive[0].player_id));
    }
  }
});

test('Start/Sit recommendations use the real roster, ESPN lineup eligibility and selected fantasy week', async () => {
  const [league, roster, advice] = await Promise.all([
    get(`${frontend}/api/backend/league`), get(`${frontend}/api/backend/my-team`),
    get(`${frontend}/api/backend/start-sit`),
  ]);
  assert.equal(advice.team_id, roster.team_id);
  assert.equal(advice.week, league.current_week);
  assert.ok(advice.recommended_starters.length > 0);
  assert.equal(advice.legal_lineup, advice.unfilled_slots.length === 0);
  assert.equal(advice.recommended_starters.length + advice.unfilled_slots.length,
    Object.values(advice.scoring_rules.position_slot_counts).reduce((total, count) => total + count, 0));
  const rosterIds = new Set(roster.roster.map(player => player.player_id));
  const starters = new Set();
  const slotCounts = {};
  for (const player of advice.recommended_starters) {
    assert.ok(rosterIds.has(player.player_id));
    assert.ok(!starters.has(player.player_id));
    starters.add(player.player_id);
    assert.ok(player.eligible_positions.includes(player.recommended_slot));
    assert.notEqual(player.bye_week, advice.week, 'BYE players cannot fill a starting slot');
    assert.ok(!['OUT', 'IR', 'INJURED_RESERVE', 'SUSPENDED', 'PUP'].includes((player.injury_status || '').toUpperCase().replaceAll(' ', '_')));
    assert.equal(player.estimate_source, 'confidence_aware_blend');
    assert.equal(player.expected_points, player.recommendation_projection);
    assert.equal(player.raw_custom_projection, player.custom_projection.our_projection);
    assert.ok(['low', 'medium', 'high'].includes(player.recommendation_confidence));
    assert.ok(player.projection_confidence == null || ['low', 'medium', 'high'].includes(player.projection_confidence));
    slotCounts[player.recommended_slot] = (slotCounts[player.recommended_slot] || 0) + 1;
  }
  for (const [slot, count] of Object.entries(slotCounts)) assert.ok(count <= advice.scoring_rules.position_slot_counts[slot]);
  const accountedSlots = {...slotCounts};
  for (const label of advice.unfilled_slots) {
    const slot = label === 'FLEX' ? 'RB/WR/TE' : label.replace(/\d+$/, '');
    assert.ok(slot in advice.scoring_rules.position_slot_counts);
    accountedSlots[slot] = (accountedSlots[slot] || 0) + 1;
    assert.ok(!advice.bench.some(player => player.eligible_positions.includes(slot)
      && player.bye_week !== advice.week
      && ['available', 'bench', 'starter', 'unassigned'].includes(player.lineup_status)
      && !['OUT', 'IR', 'INJURED_RESERVE', 'SUSPENDED', 'PUP'].includes((player.injury_status || '').toUpperCase().replaceAll(' ', '_'))),
    `An eligible bench option could fill ${label}`);
  }
  assert.deepEqual(accountedSlots, advice.scoring_rules.position_slot_counts);
  assert.equal(advice.recommended_starters.length + advice.bench.length, rosterIds.size);
  for (const player of [...advice.recommended_starters, ...advice.bench].filter(player => player.bye_week === advice.week)) {
    assert.ok(advice.bench.some(benched => benched.player_id === player.player_id));
  }
  assert.equal([...starters].filter(id => advice.bench.some(player => player.player_id === id)).length, 0);
  assert.ok(advice.model.includes('ESPN'));
  if (advice.lineup_changes.improvement_points > 0.05) {
    assert.ok(advice.lineup_changes.slot_changes.length > 0, 'A changed recommendation should identify the full lineup slot movements.');
    for (const change of advice.lineup_changes.slot_changes) {
      assert.ok(rosterIds.has(change.player_id));
      assert.notEqual(change.current_slot, change.recommended_slot);
    }
    assert.ok(advice.lineup_changes.decisions.filter(decision => ['medium', 'high'].includes(decision.confidence)).every(decision => advice.lineup_changes.start.some(player => player.player_id === decision.start.player_id)));
  }
  const futureWeek = league.fantasy_weeks.find(week => week > league.current_week);
  if (futureWeek !== undefined) {
    const futureAdvice = await get(`${frontend}/api/backend/start-sit?week=${futureWeek}`);
    assert.equal(futureAdvice.week, futureWeek);
    assert.ok(futureAdvice.recommended_starters.every(player => player.week === futureWeek));
  }
});

test('Waiver multi-position filters constrain every recommendation surface to ESPN free agents', async () => {
  const [league, roster, filtered, pool] = await Promise.all([
    get(`${frontend}/api/backend/league`), get(`${frontend}/api/backend/my-team`),
    get(`${frontend}/api/backend/waiver-advice?positions=RB&positions=WR&limit=40`),
    get(`${backend}/api/free-agents?limit=40`),
  ]);
  assert.deepEqual(filtered.selected_positions, ['RB', 'WR']);
  assert.ok(filtered.roster_needs.TE);
  const recommended = [...filtered.best_overall_adds, ...(filtered.upside_stashes || []), ...(filtered.streaming_options || [])];
  if (filtered.personalized_move) recommended.push(filtered.personalized_move.add);
  const rosterIds = new Set(roster.roster.map(player => player.player_id));
  const eligiblePool = new Set(pool.players.filter(player => ['RB', 'WR'].includes(player.position)).map(player => player.player_id));
  for (const player of recommended) {
    assert.ok(['RB', 'WR'].includes(player.position));
    assert.ok(!rosterIds.has(player.player_id));
    assert.ok(eligiblePool.has(player.player_id));
  }
  const all = await get(`${frontend}/api/backend/waiver-advice?limit=40`);
  assert.equal(all.selected_positions.length, 0);
  assert.ok(all.best_overall_adds.some(player => !['RB', 'WR'].includes(player.position)) || all.best_overall_adds.length === 0);
  assert.equal(filtered.week, league.current_week);
});

test('Waiver Assistant ranks only the real unrostered ESPN pool and validates optional add/drop advice', async () => {
  const [league, roster, advice, pool] = await Promise.all([
    get(`${frontend}/api/backend/league`), get(`${frontend}/api/backend/my-team`),
    get(`${frontend}/api/backend/waiver-advice?limit=20`), get(`${backend}/api/free-agents?limit=20`),
  ]);
  assert.equal(advice.team_id, roster.team_id);
  assert.equal(advice.week, league.current_week);
  assert.match(advice.ranking_model, /custom projection engine remains a primary input/i);
  assert.ok(advice.roster_needs && Object.keys(advice.roster_needs).length > 0);
  assert.ok(Object.values(advice.roster_needs).every(need => need.label && need.basis));
  const rosterIds = new Set(roster.roster.map(player => player.player_id));
  const poolIds = new Set(pool.players.map(player => player.player_id));
  const recommendations = [...advice.best_overall_adds, ...advice.best_qb_adds, ...advice.best_rb_adds, ...advice.best_wr_adds, ...advice.best_te_adds, ...(advice.best_k_adds || []), ...(advice.best_dst_adds || [])];
  assert.ok(advice.best_overall_adds.length > 0);
  for (const player of recommendations) {
    assert.ok(!rosterIds.has(player.player_id), `${player.name} is already rostered`);
    assert.ok(poolIds.has(player.player_id), `${player.name} is not in ESPN's real available pool`);
    assert.ok(['FREEAGENT', 'WAIVERS'].includes(player.availability_status));
    assert.ok(['high', 'medium', 'low'].includes(player.confidence));
  }
  if (advice.personalized_move) {
    const { add, drop, expected_score_advantage: advantage } = advice.personalized_move;
    assert.ok(!rosterIds.has(add.player_id));
    assert.ok(poolIds.has(add.player_id));
    const dropped = roster.roster.find(player => player.player_id === drop.player_id);
    assert.ok(dropped);
    assert.equal(dropped.lineup_status, 'bench');
    assert.ok(['ACTIVE', 'NORMAL'].includes(dropped.injury_status));
    assert.ok(advice.personalized_move.reason);
    assert.ok(advice.personalized_move.effect);
    assert.ok(advice.personalized_move.weekly_lineup_change >= advice.minimum_add_drop_advantage ||
      (add.needs_match && (advice.personalized_move.rest_of_season_change || 0) >= 8));
  } else assert.ok(advice.move_note);
});

test('projection consumers agree on one pinned canonical snapshot', async () => {
  const snapshot = await get(`${frontend}/api/backend/projections`);
  const query = new URLSearchParams({ week: String(snapshot.week), snapshot_id: snapshot.snapshot_id });
  const canonical = new Map(snapshot.players.map(row => [row.player_id, row.projection.recommendation_projection]));
  const roster = await get(`${frontend}/api/backend/my-team?${query}`);
  const advice = await get(`${frontend}/api/backend/start-sit?${query}`);
  for (const player of roster.roster) {
    assert.equal(player.custom_projection.recommendation_projection, canonical.get(player.player_id));
    assert.equal(player.projection_snapshot_id, snapshot.snapshot_id);
  }
  for (const player of [...advice.recommended_starters, ...advice.bench]) {
    assert.equal(player.recommendation_projection, canonical.get(player.player_id));
  }
  const player = roster.roster[0];
  const profile = await get(`${frontend}/api/backend/players/${player.player_id}?${query}`);
  assert.equal(profile.custom_projection.recommendation_projection, canonical.get(player.player_id));
  const matchups = await get(`${frontend}/api/backend/fantasy-matchups?${query}`);
  const partner = matchups.fantasy_matchups.flatMap(row => [row.home_team, row.away_team])
    .find(team => team && team.team_id !== roster.team_id && team.roster?.length);
  const analysis = await send(`${frontend}/api/backend/trades/analyze?${query}`, 'POST', {
    week: snapshot.week, team_id: partner.team_id,
    give_player_ids: [player.player_id], receive_player_ids: [partner.roster[0].player_id],
  });
  for (const asset of [...analysis.you_give, ...analysis.you_receive]) {
    assert.equal(asset.weekly_projection, canonical.get(asset.player_id));
    assert.equal(asset.projection_snapshot_id, snapshot.snapshot_id);
  }
  const again = await get(`${frontend}/api/backend/projections?${query}`);
  assert.deepEqual(again.players, snapshot.players);
  const discovery = await get(`${frontend}/api/backend/trades/discovery?${query}&positions=RB&positions=WR`);
  for (const deal of [...discovery.suggestions, ...discovery.possible_trades_to_explore]) {
    assert.equal(deal.asset_exchange.supported, true);
    assert.equal(deal.asset_exchange.material_overpay, false);
    assert.ok(!['NO', 'LEAN NO'].includes(deal.verdict.worth_it));
  }
});
