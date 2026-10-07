'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Clock3, Flag, Users } from 'lucide-react';
import { FantasyMatchup, FantasyMatchups, FantasyPredictions, FantasyTeam, MatchupPrediction, Player, Snapshot, ownerNames, points } from '@/lib/types';
import { PredictionBar, teamAccentColor } from './prediction-bar';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';

type MatchState = 'LIVE' | 'UPCOMING' | 'FINAL';
function liveIdsForWeek(week: number, currentWeek: number, liveTeamIds: number[] | null) {
  return week === currentWeek ? liveTeamIds : week < currentWeek ? [] : null;
}
const outStatus = (player: Player) => /OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/i.test(String(player.injury_status || ''));
function stateForPlayer(player: Player, liveTeamIds: number[] | null, week: number): MatchState | 'BYE' | 'UNKNOWN' {
  if (player.bye_week === week) return 'BYE';
  if (player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id)) return 'LIVE';
  const kickoff = player.nfl_game_time ? new Date(player.nfl_game_time) : null;
  if (kickoff && Number.isFinite(kickoff.getTime())) return kickoff.getTime() > Date.now() ? 'UPCOMING' : liveTeamIds == null ? 'UNKNOWN' : 'FINAL';
  return 'UNKNOWN';
}
function stateForMatchup(matchup: FantasyMatchup, liveTeamIds: number[] | null, week: number, currentWeek: number, prediction?: MatchupPrediction): MatchState {
  if (week < currentWeek) return 'FINAL';
  const starters = [matchup.home_team, matchup.away_team].flatMap(team => team?.roster?.filter(player => player.is_starter && !outStatus(player)) || []);
  const states = starters.map(player => stateForPlayer(player, liveTeamIds, week));
  if (states.includes('LIVE')) return 'LIVE';
  if (states.includes('UPCOMING')) return 'UPCOMING';
  if (liveTeamIds !== null && states.length && states.every(state => state === 'FINAL' || state === 'BYE')) return 'FINAL';
  if (liveTeamIds !== null && prediction?.status !== 'unavailable' && prediction?.team_a?.modeled_players.length === 0 && prediction?.team_b?.modeled_players.length === 0 && (matchup.home_team?.current_fantasy_score || 0) + (matchup.away_team?.current_fantasy_score || 0) > 0) return 'FINAL';
  return 'UPCOMING';
}
function orderedSides(matchup: FantasyMatchup, prediction?: MatchupPrediction) {
  const home = matchup.home_team, away = matchup.away_team;
  if (!prediction || !home || !away) return { home: undefined, away: undefined, homeWin: undefined, awayWin: undefined };
  const homeIsA = prediction.team_a?.team_id === home.team_id;
  const awayIsA = prediction.team_a?.team_id === away.team_id;
  return {
    home: homeIsA ? prediction.team_a : awayIsA ? prediction.team_b : undefined,
    away: awayIsA ? prediction.team_a : homeIsA ? prediction.team_b : undefined,
    homeWin: homeIsA ? prediction.team_a_win_probability : awayIsA ? prediction.team_b_win_probability : undefined,
    awayWin: awayIsA ? prediction.team_a_win_probability : homeIsA ? prediction.team_b_win_probability : undefined,
  };
}
function normalizedForBar(matchup: FantasyMatchup, prediction?: MatchupPrediction) {
  const ordered = orderedSides(matchup, prediction);
  if (!prediction || !matchup.home_team || !matchup.away_team) return prediction;
  return { ...prediction, team_a: ordered.home, team_b: ordered.away, team_a_win_probability: ordered.homeWin, team_b_win_probability: ordered.awayWin };
}
function teamScore(team: FantasyTeam, state: MatchState, result?: { expected_final_score: number; projected_final_score: number }) {
  const current = team.current_fantasy_score;
  if (state === 'FINAL') return { value: current, label: 'FINAL SCORE' };
  if (state === 'LIVE') return { value: current, label: 'CURRENT SCORE' };
  return { value: result?.expected_final_score ?? result?.projected_final_score ?? team.projected_fantasy_score, label: 'PROJECTED FINAL' };
}

function TeamIdentity({ team, featured = false }: { team: FantasyTeam; featured?: boolean }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const owner = ownerNames(team);
  const readableOwner = owner && !/^ESPNFAN\d+$/i.test(owner) ? owner : '';
  return <div className={`lm-team-identity ${featured ? 'featured' : ''}`} style={{ '--team-accent': teamAccentColor(team.team_id, team.primary_color), '--team-secondary': team.secondary_color || 'transparent' } as React.CSSProperties}>
    {team.team_logo_url && !logoFailed ? <img className="lm-team-logo" src={team.team_logo_url} alt="" onError={() => setLogoFailed(true)}/> : <span className="lm-team-mark">{team.abbreviation || team.team_name.slice(0, 2)}</span>}
    <div className="lm-team-copy"><strong title={team.team_name}>{team.team_name}</strong>{readableOwner && <small>{readableOwner}</small>}</div>
  </div>;
}

function MatchupScoreboard({ matchup, prediction, myTeamId, week, currentWeek, liveTeamIds, featured, onDetails }: {
  matchup: FantasyMatchup; prediction?: MatchupPrediction; myTeamId: number; week: number; currentWeek: number; liveTeamIds: number[] | null; featured?: boolean; onDetails: () => void;
}) {
  const home = matchup.home_team, away = matchup.away_team;
  if (!home || !away) return <div className="lm-scoreboard-empty">ESPN has not provided both fantasy teams for this matchup.</div>;
  const state = stateForMatchup(matchup, liveTeamIds, week, currentWeek, prediction);
  const { home: homeSide, away: awaySide, homeWin, awayWin } = orderedSides(matchup, prediction);
  const homeScore = teamScore(home, state, homeSide), awayScore = teamScore(away, state, awaySide);
  const close = state !== 'FINAL' && typeof homeWin === 'number' && typeof awayWin === 'number' && homeWin >= .4 && homeWin <= .6 && awayWin >= .4 && awayWin <= .6;
  const left = homeSide?.modeled_players.length ?? null, right = awaySide?.modeled_players.length ?? null;
  return <article className={`lm-scoreboard ${featured ? 'lm-featured' : 'lm-compact'} state-${state.toLowerCase()}`} data-testid={featured ? 'featured-fantasy-matchup' : 'league-scoreboard-row'}>
    <div className="lm-scoreboard-heading"><span>{featured ? 'YOUR MATCHUP' : 'FANTASY MATCHUP'}</span><div className={`lm-state ${state.toLowerCase()}`}>{state === 'LIVE' && <i/>}{state}{close && <b>CLOSE GAME</b>}</div></div>
    <div className="lm-score-line">
      <section className="lm-score-side home" style={{ '--team-accent': teamAccentColor(home.team_id, home.primary_color) } as React.CSSProperties}>
        <TeamIdentity team={home} featured={featured}/><div className="lm-score-value"><small>{homeScore.label}</small><strong>{points(homeScore.value)}</strong></div>
        {state === 'LIVE' && homeSide && <small className="lm-projected-finish">Projected finish {points(homeSide.expected_final_score)}</small>}
        <span className="lm-players-left"><Users size={13}/>{left == null ? '--' : left} left{home.team_id === myTeamId ? ' for you' : ''}</span>
      </section>
      <div className="lm-versus">{state === 'FINAL' ? <span>FINAL</span> : <span>VS</span>}</div>
      <section className="lm-score-side away" style={{ '--team-accent': teamAccentColor(away.team_id, away.primary_color) } as React.CSSProperties}>
        <TeamIdentity team={away} featured={featured}/><div className="lm-score-value"><small>{awayScore.label}</small><strong>{points(awayScore.value)}</strong></div>
        {state === 'LIVE' && awaySide && <small className="lm-projected-finish">Projected finish {points(awaySide.expected_final_score)}</small>}
        <span className="lm-players-left"><Users size={13}/>{right == null ? '--' : right} left{away.team_id === myTeamId ? ' for you' : ''}</span>
      </section>
    </div>
    {state !== 'FINAL' && <div className="lm-probability">
      {typeof homeWin === 'number' && typeof awayWin === 'number' ? <>
        <div className="lm-probability-labels"><span style={{ color: teamAccentColor(home.team_id, home.primary_color) }}>{home.team_name}<b>{Math.round(homeWin * 100)}%</b></span><span style={{ color: teamAccentColor(away.team_id, away.primary_color) }}>{away.team_name}<b>{Math.round(awayWin * 100)}%</b></span></div>
        <PredictionBar prediction={normalizedForBar(matchup, prediction)} homeName={home.team_name} awayName={away.team_name} homeId={home.team_id} awayId={away.team_id} homeColor={home.primary_color} awayColor={away.primary_color}/>
      </> : <span className="lm-prob-unavailable">Win chance unavailable</span>}
      {prediction?.model_confidence && <details className="lm-confidence"><summary>How certain is this estimate? <b>{prediction.model_confidence.toUpperCase()}</b></summary><p>Based on how much football is left and how reliable the remaining player projections are.</p></details>}
    </div>}
    <button className="lm-detail-link" type="button" onClick={onDetails}>Open matchup <ArrowUpRight size={15}/></button>
  </article>;
}

export function LeagueMatchupsPanel({ matchups, predictions, myTeamId, week, currentWeek, liveTeamIds, weeks, onWeekChange, onDetails, mode = 'league' }: {
  matchups: FantasyMatchups; predictions?: FantasyPredictions | null; myTeamId: number; week: number; currentWeek: number; liveTeamIds: number[] | null; weeks?: number[]; onWeekChange?: (week: number | null) => void; onDetails: (matchup: FantasyMatchup) => void; mode?: 'league' | 'predictions';
}) {
  const weekLiveIds = liveIdsForWeek(week, currentWeek, liveTeamIds);
  const byId = useMemo(() => new Map((predictions?.predictions || []).map(item => [item.fantasy_matchup_id, item])), [predictions]);
  const own = matchups.fantasy_matchups.find(item => item.involves_my_team && !item.is_bye);
  const others = matchups.fantasy_matchups.filter(item => item !== own && !item.is_bye).sort((a, b) => {
    const pa = byId.get(a.fantasy_matchup_id), pb = byId.get(b.fantasy_matchup_id);
    const sa = stateForMatchup(a, weekLiveIds, week, currentWeek, pa), sb = stateForMatchup(b, weekLiveIds, week, currentWeek, pb);
    const rank = (m: FantasyMatchup, state: MatchState, p?: MatchupPrediction) => {
      if (state === 'FINAL') return 4;
      const odds = orderedSides(m, p);
      const gap = typeof odds.homeWin === 'number' && typeof odds.awayWin === 'number' ? Math.abs(odds.homeWin - odds.awayWin) : 2;
      return state === 'LIVE' ? gap < .2 ? 0 : 1 : gap < .2 ? 2 : 3;
    };
    return rank(a, sa, pa) - rank(b, sb, pb);
  });
  const leagueState = own ? stateForMatchup(own, weekLiveIds, week, currentWeek, byId.get(own.fantasy_matchup_id)) : others.some(m => stateForMatchup(m, weekLiveIds, week, currentWeek, byId.get(m.fantasy_matchup_id)) === 'LIVE') ? 'LIVE' : 'UPCOMING';
  const weekIndex = weeks?.indexOf(week) ?? -1;
  return <div className={`league-matchups-experience ${mode === 'predictions' ? 'predictions-experience' : ''}`}>
    <header className="lm-page-head"><div><span className="lm-kicker">{mode === 'predictions' ? 'FANTASY FORECASTS' : 'FANTASY SCOREBOARD'}</span><h2>{mode === 'predictions' ? 'Predictions' : 'League Matchups'}</h2></div><div className="lm-week-control">
      {onWeekChange && <><button aria-label="Previous week" title="Previous week" disabled={weekIndex <= 0} onClick={() => onWeekChange(weeks?.[weekIndex - 1] ?? null)}><ChevronLeft size={17}/></button><label><span>WEEK</span><select aria-label="Select fantasy week" value={week} onChange={event => onWeekChange(Number(event.target.value))}>{weeks?.map(item => <option key={item} value={item}>{item}</option>)}</select></label><button aria-label="Next week" title="Next week" disabled={!weeks || weekIndex < 0 || weekIndex >= weeks.length - 1} onClick={() => onWeekChange(weeks?.[weekIndex + 1] ?? null)}><ChevronRight size={17}/></button></>}
      <span className={`lm-league-state ${leagueState.toLowerCase()}`}>{leagueState === 'LIVE' && <i/>}{leagueState}</span>
    </div></header>
    {mode === 'predictions' && <div className="lm-predictions-intro">Win chance comes from the existing matchup simulations. It is not an NFL game prediction.</div>}
    {own && <MatchupScoreboard matchup={own} prediction={byId.get(own.fantasy_matchup_id)} myTeamId={myTeamId} week={week} currentWeek={currentWeek} liveTeamIds={weekLiveIds} featured onDetails={() => onDetails(own)}/>}
    <section className="lm-around" aria-labelledby="lm-around-title"><div className="lm-section-head"><div><span className="lm-kicker">{others.some(item => stateForMatchup(item, weekLiveIds, week, currentWeek, byId.get(item.fantasy_matchup_id)) === 'LIVE') ? 'LIVE SCORES FIRST' : 'SCORES AROUND THE LEAGUE'}</span><h3 id="lm-around-title">Around the league</h3></div><span>{others.length} matchups</span></div>
      {others.length ? <div className="lm-scoreboard-list">{others.map(matchup => <MatchupScoreboard key={matchup.fantasy_matchup_id} matchup={matchup} prediction={byId.get(matchup.fantasy_matchup_id)} myTeamId={myTeamId} week={week} currentWeek={currentWeek} liveTeamIds={weekLiveIds} onDetails={() => onDetails(matchup)}/>)}</div> : <p className="lm-empty">No other league matchups are available for Week {week}.</p>}
    </section>
  </div>;
}

function PlayerStatusLine({ player, status, pointsText }: { player: Player; status: string; pointsText: string }) {
  return <div className="lm-player-line"><PlayerAvatar player={player} size="md"/><div className="lm-player-copy"><Link href={`/players/${player.player_id}`}>{player.name}</Link><small>{player.position || '--'} · {player.nfl_team || '--'}{player.nfl_opponent ? ` vs ${player.nfl_opponent}` : ''}</small></div><PlayerStatusButton player={player}/><span className={`lm-player-state ${status.toLowerCase()}`}>{status} · {pointsText}</span></div>;
}

function kickoffLabel(player: Player) {
  if (!player.nfl_game_time) return '';
  const kickoff = new Date(player.nfl_game_time);
  return Number.isFinite(kickoff.getTime()) ? kickoff.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
}

export function MatchupDetailDialog({ matchup, prediction, close, week, currentWeek, liveTeamIds }: { matchup: FantasyMatchup; prediction?: MatchupPrediction; close: () => void; week: number; currentWeek: number; liveTeamIds: number[] | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }, []);
  const weekLiveIds = liveIdsForWeek(week, currentWeek, liveTeamIds);
  const state = stateForMatchup(matchup, weekLiveIds, week, currentWeek, prediction);
  const sides = orderedSides(matchup, prediction);
  const teams = [
    { team: matchup.home_team, result: sides.home, probability: sides.homeWin },
    { team: matchup.away_team, result: sides.away, probability: sides.awayWin },
  ].filter((value): value is { team: FantasyTeam; result: NonNullable<typeof value.result>; probability: number | undefined } => !!value.team);
  const swing = prediction?.biggest_remaining_swing_players ?? [];
  const rosterPlayers = (team: FantasyTeam, result?: typeof sides.home) => {
    const roster = team.roster?.filter(player => player.is_starter) ?? [];
    const byPlayer = new Map<number, { status: string; score: number; projected: boolean; finish?: number }>();
    for (const player of result?.fixed_players || []) byPlayer.set(player.player_id, { status: 'FINAL', score: player.fantasy_points, projected: false });
    for (const player of result?.modeled_players || []) byPlayer.set(player.player_id, { status: player.status === 'in' ? 'LIVE' : 'UPCOMING', score: player.status === 'in' ? player.current_points : player.expected_final_score, projected: player.status === 'pre', finish: player.expected_final_score });
    return roster.map(player => {
      const model = byPlayer.get(player.player_id);
      const status = model?.status || stateForPlayer(player, weekLiveIds, week);
      const val = model?.score ?? player.fantasy_points;
      const scoreText = typeof val === 'number'
        ? status === 'UPCOMING' ? `Proj ${val.toFixed(1)} pts${kickoffLabel(player) ? ` · ${kickoffLabel(player)}` : ''}`
          : status === 'LIVE' ? `${val.toFixed(1)} pts${model?.finish != null ? ` · finish ${model.finish.toFixed(1)}` : ''}`
            : `${val.toFixed(1)} pts`
        : status === 'UPCOMING' ? `Proj --${kickoffLabel(player) ? ` · ${kickoffLabel(player)}` : ''}` : '--';
      return { player, status, scoreText };
    });
  };
  return <dialog ref={dialog} className="details-dialog lm-detail-dialog" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-inner"><div className="dialog-top"><div><span className="lm-kicker">WEEK {week} · {state}</span><h2>Matchup details</h2></div><button className="icon-button" aria-label="Close matchup details" onClick={close}>×</button></div>
      <div className="lm-detail-scoreboard">{teams.map(({ team, result }) => <div key={team.team_id} style={{ '--team-accent': teamAccentColor(team.team_id, team.primary_color) } as React.CSSProperties}><TeamIdentity team={team}/><strong>{points(state === 'FINAL' ? team.current_fantasy_score : state === 'LIVE' ? team.current_fantasy_score : result?.expected_final_score ?? team.projected_fantasy_score)}</strong><small>{state === 'FINAL' ? 'FINAL SCORE' : state === 'LIVE' ? 'CURRENT SCORE' : 'PROJECTED FINAL'}</small></div>)}</div>
      {state !== 'FINAL' && <><div className="lm-detail-odds">{typeof sides.homeWin === 'number' && typeof sides.awayWin === 'number' ? <PredictionBar prediction={normalizedForBar(matchup, prediction)} homeName={matchup.home_team?.team_name || 'Home'} awayName={matchup.away_team?.team_name || 'Away'} homeId={matchup.home_team?.team_id} awayId={matchup.away_team?.team_id} homeColor={matchup.home_team?.primary_color} awayColor={matchup.away_team?.primary_color}/> : <p>Win chance is unavailable for this matchup.</p>}{prediction?.model_confidence && <span>How certain is this estimate? <b>{prediction.model_confidence.toUpperCase()}</b></span>}</div>
        <section className="lm-detail-section"><h3>Key players</h3><div className="lm-key-players">{teams.flatMap(({ team, result }) => rosterPlayers(team, result).sort((a,b) => (b.player.fantasy_points ?? 0) - (a.player.fantasy_points ?? 0)).slice(0, 2).map(item => <PlayerStatusLine key={item.player.player_id} player={item.player} status={item.status} pointsText={item.scoreText}/>))}</div></section>
        <section className="lm-detail-section"><h3>Swing players</h3>{swing.length ? <div className="lm-swing-list">{swing.slice(0, 4).map(player => <article key={player.player_id}><PlayerAvatar player={player} size="md"/><div><Link href={`/players/${player.player_id}`}>{player.name}</Link><small>{player.position || '--'} · {player.nfl_team || '--'} · {player.fantasy_team_name}</small><p>Their remaining score can change the direction of this matchup.</p><details><summary>Why this matters</summary><small>This player was identified by the existing matchup simulations based on how different outcomes affect win chance.</small></details></div><PlayerStatusButton player={{player_id:player.player_id,name:player.name,position:player.position,nfl_team:player.nfl_team,injury_status:player.injury_status ?? null,headshot_url:player.headshot_url,nfl_team_id:player.nfl_team_id,nfl_team_logo_url:player.nfl_team_logo_url}}/></article>)}</div> : <p>No swing players are available for this matchup.</p>}</section></>}
      <section className="lm-detail-section lm-remaining"><h3>{state === 'FINAL' ? 'Final players' : 'Players by team'}</h3><div className="lm-remaining-columns">{teams.map(({ team, result }) => <section key={team.team_id}><TeamIdentity team={team}/>{rosterPlayers(team, result).map(item => <PlayerStatusLine key={item.player.player_id} player={item.player} status={item.status} pointsText={item.scoreText}/>)}</section>)}</div></section>
      {prediction?.simulation_count ? <details className="lm-advanced"><summary>How this was calculated</summary><p>This matchup used {prediction.simulation_count.toLocaleString()} simulations. Completed players use their actual fantasy points; remaining players use the existing projection and scoring model.</p></details> : null}
    </div>
  </dialog>;
}
