/** Presentation adapters only: preserve provider/model values and team IDs. */
/** @param {import('./types').FantasyMatchup} matchup @param {import('./types').MatchupPrediction | undefined} prediction */
export function predictionSides(matchup, prediction) {
  const side = id => prediction?.team_a?.team_id === id ? prediction.team_a : prediction?.team_b?.team_id === id ? prediction.team_b : undefined;
  const chance = id => prediction?.team_a?.team_id === id ? prediction.team_a_win_probability : prediction?.team_b?.team_id === id ? prediction.team_b_win_probability : undefined;
  return { home: side(matchup.home_team?.team_id), away: side(matchup.away_team?.team_id), homeWin: chance(matchup.home_team?.team_id), awayWin: chance(matchup.away_team?.team_id) };
}
/** @param {import('./types').FantasyMatchup} matchup @param {number} myTeamId */
export function opponentFirst(matchup, myTeamId) {
  return matchup.home_team?.team_id === myTeamId ? { ...matchup, home_team: matchup.away_team, away_team: matchup.home_team } : matchup;
}
/** @param {number} week @param {number} currentWeek @param {number[] | null} ids */
export function liveIdsForWeek(week, currentWeek, ids) { return week === currentWeek ? ids : week < currentWeek ? [] : null; }
/** @param {import('./types').Player} player @param {number[] | null} ids @param {number} week @returns {'BYE'|'LIVE'|'UPCOMING'|'FINAL'|'UNKNOWN'} */
export function playerState(player, ids, week) {
  if (player.bye_week === week) return 'BYE';
  if (player.nfl_team_id != null && ids?.includes(player.nfl_team_id)) return 'LIVE';
  const kickoff = player.nfl_game_time ? new Date(player.nfl_game_time) : null;
  if (kickoff && Number.isFinite(kickoff.getTime())) return kickoff.getTime() > Date.now() ? 'UPCOMING' : ids == null ? 'UNKNOWN' : 'FINAL';
  return 'UNKNOWN';
}
/** @param {import('./types').FantasyMatchup} matchup @param {number[] | null} ids @param {number} week @param {number} currentWeek @param {import('./types').MatchupPrediction | undefined} prediction @returns {'LIVE'|'FINAL'|'UPCOMING'} */
export function fantasyState(matchup, ids, week, currentWeek, prediction) {
  if (week < currentWeek) return 'FINAL';
  if (week > currentWeek) return 'UPCOMING';
  const starters = [matchup.home_team, matchup.away_team].flatMap(team => team?.roster?.filter(player => player.is_starter && !/OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/i.test(String(player.injury_status || ''))) || []);
  const states = starters.map(player => playerState(player, ids, week));
  if (states.includes('LIVE')) return 'LIVE';
  if (states.includes('UPCOMING')) return 'UPCOMING';
  if (ids !== null && states.length && states.every(state => state === 'FINAL' || state === 'BYE')) return 'FINAL';
  if (ids !== null && prediction?.status !== 'unavailable' && prediction?.team_a?.modeled_players.length === 0 && prediction?.team_b?.modeled_players.length === 0 && (matchup.home_team?.current_fantasy_score || 0) + (matchup.away_team?.current_fantasy_score || 0) > 0) return 'FINAL';
  return 'UPCOMING';
}
/** @param {import('./types').FantasyTeam} team @param {'LIVE'|'FINAL'|'UPCOMING'} state @param {import('./types').FantasyPredictionSide | undefined} result */
export function fantasyScore(team, state, result) {
  return state === 'FINAL' ? { value: team.current_fantasy_score, label: 'Final score' } : state === 'LIVE' ? { value: team.current_fantasy_score, label: 'Current score' } : { value: result?.expected_final_score ?? result?.projected_final_score ?? team.projected_fantasy_score, label: 'Projected finish' };
}
/** @param {import('./types').NFLGame} game */
export function visibleMarket(game) { return game.status.state === 'post' ? null : game.market_probability || null; }
/** @param {import('./types').NFLGame} game */
export function nflWinner(game) {
  const away = game.away_team.score, home = game.home_team.score;
  if (game.status.state !== 'post' || typeof away !== 'number' || typeof home !== 'number' || !Number.isFinite(away) || !Number.isFinite(home)) return null;
  return away === home ? 'tie' : away > home ? 'away' : 'home';
}
