/** Real selected-week NFL schedule takes precedence over cached player metadata. */
export function isByeWeek(player, week, schedule) {
  if (!week) return false;
  if (schedule?.week === week && (player.nfl_team_id || player.nfl_team || player.nfl_team_full_name)) {
    return schedule.teams_on_bye.some(team =>
      (player.nfl_team_id != null && String(team.team_id) === String(player.nfl_team_id)) ||
      (player.nfl_team && team.abbreviation === player.nfl_team) ||
      (team.name && (team.name === player.nfl_team_full_name || team.name === player.nfl_team)));
  }
  return player.bye_week === week;
}
export function fantasyImageCandidates(team) {
  return [...new Set([team.custom_team_logo_url, team.default_team_logo_url, team.team_logo_url]
    .filter(url => typeof url === 'string' && (/^https:\/\//.test(url) || /^\/api\/backend\/teams\/\d+\/image$/.test(url))))];
}
export function autocompleteMatches(players, query, limit = 8) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  const score = name => name === term ? 0 : name.startsWith(term) ? 1 : name.split(/[\s'-]+/).some(part => part.startsWith(term)) ? 2 : name.includes(term) ? 3 : 4;
  return players.map(player => ({player, rank:score(player.name.toLocaleLowerCase())}))
    .filter(row => row.rank < 4).sort((a,b) => a.rank-b.rank || Number(!a.player.nfl_team || a.player.nfl_team === 'None')-Number(!b.player.nfl_team || b.player.nfl_team === 'None') || a.player.name.localeCompare(b.player.name) || a.player.player_id-b.player.player_id)
    .slice(0,limit).map(row=>row.player);
}
export function autocompleteIndex(current, key, length) {
  if (!length || key === 'Escape') return -1;
  if (key === 'ArrowDown') return (current+1)%length;
  if (key === 'ArrowUp') return current<0 ? length-1 : (current-1+length)%length;
  return current;
}
