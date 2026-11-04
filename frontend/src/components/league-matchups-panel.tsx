'use client';
import { PlayerProjection } from './player-projection';
import { FantasyTeamAvatar } from './fantasy-team-avatar';
import { canonicalProjection } from '@/lib/api';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, ChevronDown, ChevronUp, Clock3, Flag, Users } from 'lucide-react';
import { FantasyMatchup, FantasyMatchups, FantasyPredictions, FantasyTeam, FantasyPredictionSide, MatchupPrediction, Player, SwingPlayer, ownerNames, points } from '@/lib/types';
import { PredictionBar, teamAccentColor } from './prediction-bar';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';
import { PlayerOpen, ResultSequence, playerField } from './living-future-ui';
import { AnimatedPoints } from './player-board-cards';
import { ScoreWeekControl, SmoothScoreReveal } from './score-space-ui';
import { predictionSides, opponentFirst, fantasyState, fantasyScore, liveIdsForWeek as weekLiveIds, playerState } from '@/lib/score-display.mjs';

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
function TeamIdentity({ team, featured = false }: { team: FantasyTeam; featured?: boolean }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const owner = ownerNames(team);
  const readableOwner = owner && !/^ESPNFAN\d+$/i.test(owner) ? owner : '';
  return <div className={`lm-team-identity ${featured ? 'featured' : ''}`} style={{ '--team-accent': teamAccentColor(team.team_id, team.primary_color), '--team-secondary': team.secondary_color || 'transparent' } as React.CSSProperties}>
    <FantasyTeamAvatar team={team} className="lm-team-logo"/>
    <div className="lm-team-copy"><strong title={team.team_name}>{team.team_name}</strong>{readableOwner && <small>{readableOwner}</small>}</div>
  </div>;
}


export function FantasyIdentity({ team, sideLabel }: { team: FantasyTeam; sideLabel?: string }) {
  return <div className="sf-fantasy-identity"><FantasyTeamAvatar team={team}/><div>{sideLabel && <small>{sideLabel}</small>}<strong>{team.team_name}</strong></div></div>;
}

export function FantasyProbability({ matchup, prediction, compact = false }: { matchup: FantasyMatchup; prediction?: MatchupPrediction; compact?: boolean }) {
  const sides = predictionSides(matchup, prediction);
  const mapped = prediction ? { ...prediction, team_a: sides.home, team_b: sides.away, team_a_win_probability: sides.homeWin, team_b_win_probability: sides.awayWin } : undefined;
  return <div className={`sf-probability ${compact ? 'sf-probability-compact' : ''}`}><span className="sf-probability-caption">Win chance</span><PredictionBar prediction={mapped} homeName={matchup.home_team?.team_name || 'Team unavailable'} awayName={matchup.away_team?.team_name || 'Team unavailable'} homeId={matchup.home_team?.team_id} awayId={matchup.away_team?.team_id} homeColor={matchup.home_team?.primary_color} awayColor={matchup.away_team?.primary_color}/></div>;
}

export function FantasyScoreFocus({ matchup, prediction, myTeamId, week, currentWeek, liveTeamIds, expanded, onExpand }: { matchup: FantasyMatchup; prediction?: MatchupPrediction; myTeamId: number; week: number; currentWeek: number; liveTeamIds: number[] | null; expanded: boolean; onExpand: () => void }) {
  const view = opponentFirst(matchup, myTeamId);
  const sides = predictionSides(view, prediction);
  const state = fantasyState(view, liveTeamIds, week, currentWeek, prediction);
  const teams = [{ team: view.home_team, result: sides.home }, { team: view.away_team, result: sides.away }];
  const high = Math.max(...teams.map(({team}) => team?.current_fantasy_score ?? -Infinity));
  return <article className={`sf-score-focus sf-split-surface sf-state-${state.toLowerCase()}`} data-pointer-reactive data-testid="featured-fantasy-matchup" style={{ '--sf-left': teamAccentColor(view.home_team?.team_id, view.home_team?.primary_color), '--sf-right': teamAccentColor(view.away_team?.team_id, view.away_team?.primary_color) } as React.CSSProperties}>
    <header className="sf-focus-top"><span>Your matchup · Week {week}</span><span className={`sf-game-state ${state.toLowerCase()}`}>{state === 'LIVE' && <i/>}{state}</span></header>
    <div className="sf-focus-teams">{teams.map(({team,result},index) => {
      if (!team) return <div key={index}>Team unavailable</div>;
      const main = fantasyScore(team, state, result);
      const winner = state === 'FINAL' && typeof team.current_fantasy_score === 'number' && team.current_fantasy_score === high && view.home_team?.current_fantasy_score !== view.away_team?.current_fantasy_score;
      return <section className={`sf-focus-side ${index ? 'is-right' : 'is-left'} ${winner ? 'is-winner' : ''}`} key={team.team_id} style={{ '--sf-team': teamAccentColor(team.team_id, team.primary_color) } as React.CSSProperties}><FantasyIdentity team={team} sideLabel={team.team_id === myTeamId ? 'Your team' : 'Opponent'}/><div className="sf-score-reading"><span>{main.label}</span><AnimatedPoints value={main.value}/></div><div className="sf-score-context">{state === 'LIVE' && result && <span>Projected finish <b>{points(result.expected_final_score)}</b></span>}{state === 'UPCOMING' && typeof team.current_fantasy_score === 'number' && team.current_fantasy_score > 0 && <span>Current <b>{points(team.current_fantasy_score)}</b></span>}{state !== 'FINAL' && <span><Users size={12}/>{result ? result.modeled_players.length : '--'} remaining</span>}{winner && <span className="sf-winner-label">Winner</span>}</div></section>;
    })}<span className="sf-versus" aria-hidden="true">vs</span></div>
    {state !== 'FINAL' && <FantasyProbability matchup={view} prediction={prediction}/>}
    <footer className="sf-focus-footer">{prediction?.model_confidence && state !== 'FINAL' ? <span>Matchup confidence <b>{prediction.model_confidence}</b></span> : <span>{state === 'FINAL' ? 'Actual fantasy scores' : 'Fantasy league matchup'}</span>}<button type="button" aria-expanded={expanded} aria-controls={`sf-matchup-${matchup.fantasy_matchup_id}`} onClick={onExpand}>{expanded ? 'Close details' : 'Explore matchup'}{expanded ? <ChevronUp size={14}/> : <ArrowUpRight size={14}/>}</button></footer>
  </article>;
}

function FantasyScoreLane({ matchup, prediction, week, currentWeek, liveTeamIds, expanded, onExpand }: { matchup: FantasyMatchup; prediction?: MatchupPrediction; week: number; currentWeek: number; liveTeamIds: number[] | null; expanded: boolean; onExpand: () => void }) {
  const state = fantasyState(matchup, liveTeamIds, week, currentWeek, prediction);
  const sides = predictionSides(matchup, prediction);
  const high = Math.max(matchup.home_team?.current_fantasy_score ?? -Infinity, matchup.away_team?.current_fantasy_score ?? -Infinity);
  return <article className={`sf-score-lane sf-split-surface sf-state-${state.toLowerCase()}`} data-pointer-reactive data-lf-reveal data-testid="league-scoreboard-row" style={{ '--sf-left': teamAccentColor(matchup.home_team?.team_id, matchup.home_team?.primary_color), '--sf-right': teamAccentColor(matchup.away_team?.team_id, matchup.away_team?.primary_color) } as React.CSSProperties}>
    {[{team:matchup.home_team,result:sides.home},{team:matchup.away_team,result:sides.away}].map(({team,result},index) => <div className={`sf-lane-side ${index ? 'is-right' : ''} ${state === 'FINAL' && team?.current_fantasy_score === high && matchup.home_team?.current_fantasy_score !== matchup.away_team?.current_fantasy_score ? 'is-winner' : ''}`} key={team?.team_id ?? index}>{team && <FantasyIdentity team={team}/>}<div><AnimatedPoints value={team ? fantasyScore(team,state,result).value : null}/><small>{state === 'UPCOMING' ? 'Projected' : state === 'FINAL' ? 'Final' : 'Current'}</small></div></div>)}
    <div className="sf-lane-center"><span className={`sf-game-state ${state.toLowerCase()}`}>{state === 'LIVE' && <i/>}{state}</span>{state !== 'FINAL' && <FantasyProbability matchup={matchup} prediction={prediction} compact/>}<button type="button" aria-expanded={expanded} aria-controls={`sf-matchup-${matchup.fantasy_matchup_id}`} onClick={onExpand}>{expanded ? 'Close' : 'Open matchup'}{expanded ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}</button></div>
  </article>;
}

export function SwingPlayerAssets({ prediction, matchup, week }: { prediction?: MatchupPrediction; matchup: FantasyMatchup; week: number }) {
  const swing = prediction?.biggest_remaining_swing_players || [];
  const rosters = [matchup.home_team,matchup.away_team].flatMap(team => team?.roster || []);
  return <section className="sf-swing-section"><div className="sf-section-heading"><h3>Swing players</h3><span>From the matchup simulations</span></div>{swing.length ? <div className="sf-swing-assets">{swing.map(player => {
    const known = rosters.find(row => row.player_id === player.player_id);
    const initial = known || { player_id: player.player_id, name: player.name, nfl_team: player.nfl_team, position: player.position, injury_status: player.injury_status ?? null, headshot_url: player.headshot_url, nfl_team_logo_url: player.nfl_team_logo_url, nfl_team_id: player.nfl_team_id, week };
    return <article className="sf-swing-asset lf-surface" data-pointer-reactive style={playerField(initial)} key={player.player_id}><PlayerAvatar player={initial} size="md"/><div><PlayerOpen player={initial}/><span>{player.position || '--'} · {player.nfl_team || '--'}</span><small>{player.fantasy_team_name}</small></div><strong>{(player.win_probability_swing * 100).toFixed(1)}<small>pp swing</small></strong><details><summary>Why this player?</summary><p>In the model's low / high outcome scenarios, {player.fantasy_team_name}'s win chance moves from {(player.low_outcome_win_probability * 100).toFixed(1)}% to {(player.high_outcome_win_probability * 100).toFixed(1)}%. Other simulated player outcomes stay fixed.</p></details></article>;
  })}</div> : <p className="sf-muted">No remaining swing players are available.</p>}</section>;
}

export function FantasyMatchupDetails({ matchup, prediction, week, currentWeek, liveTeamIds, showSwing = true }: { matchup: FantasyMatchup; prediction?: MatchupPrediction; week: number; currentWeek: number; liveTeamIds: number[] | null; showSwing?: boolean }) {
  const sides = predictionSides(matchup,prediction);
  const state = fantasyState(matchup,liveTeamIds,week,currentWeek,prediction);
  const roster = (team: FantasyTeam, result?: FantasyPredictionSide) => (team.roster || []).filter(player => player.is_starter).map(player => {
    const fixed = result?.fixed_players.find(row => row.player_id === player.player_id);
    const modeled = result?.modeled_players.find(row => row.player_id === player.player_id);
    const status = player.bye_week === week ? 'BYE' : state === 'FINAL' || fixed ? 'FINAL' : week > currentWeek ? player.bye_week === week ? 'BYE' : 'UPCOMING' : modeled ? modeled.status === 'in' ? 'LIVE' : 'UPCOMING' : playerState(player,liveTeamIds,week);
    const value = fixed?.fantasy_points ?? (status === 'FINAL' ? player.fantasy_points : status === 'LIVE' ? modeled?.current_points ?? player.fantasy_points : status === 'UPCOMING' ? canonicalProjection(player,week) : null);
    return <div className="sf-roster-player" key={player.player_id}><PlayerAvatar player={player} size="md"/><div><PlayerOpen player={player}/><span>{player.lineup_slot || player.position || '--'} · {player.nfl_team || '--'}{player.nfl_opponent ? ` · vs ${player.nfl_opponent}` : ''}</span></div><PlayerStatusButton player={player} compact/><div className="sf-player-outcome"><b><PlayerProjection player={player} week={week} value={value}/></b><small>{status === 'UPCOMING' ? 'Projection' : status}</small></div></div>;
  });
  return <div className="sf-matchup-detail"><div className="sf-section-heading"><h3>Matchup details</h3><span>Week {week} · {state}</span></div>
    <div className="sf-expanded-layout"><div className="sf-team-rosters">{[{team:matchup.home_team,result:sides.home},{team:matchup.away_team,result:sides.away}].map(({team,result}) => team && <section key={team.team_id}><FantasyIdentity team={team}/>{roster(team,result)}</section>)}</div>
    <aside className="sf-expanded-context">{state !== 'FINAL' && <FantasyProbability matchup={matchup} prediction={prediction}/>}<div className="sf-expanded-summary">{prediction?.model_confidence && <span>Matchup confidence <b>{prediction.model_confidence}</b></span>}{[{team:matchup.home_team,result:sides.home},{team:matchup.away_team,result:sides.away}].map(({team,result})=>team&&result&&<span key={team.team_id}>{team.team_name}<b>{state==='FINAL'?'Final':`${result.modeled_players.length} remaining`}</b></span>)}</div>
    {showSwing && state !== 'FINAL' && <SwingPlayerAssets prediction={prediction} matchup={matchup} week={week}/>}
    <details className="sf-method"><summary>Simulation details</summary><p>{prediction?.simulation_count ? `${prediction.simulation_count.toLocaleString()} simulations. ` : ''}Completed players retain their actual scores. Remaining outcomes use the existing player model.</p>{prediction?.model_confidence_reasons?.map((reason,index)=><p key={index}>{reason}</p>)}</details></aside></div>
  </div>;
}

export function LeagueMatchupsPanel({ matchups, predictions, myTeamId, week, currentWeek, liveTeamIds, weeks = [], onWeekChange }: { matchups: FantasyMatchups; predictions?: FantasyPredictions | null; myTeamId: number; week: number; currentWeek: number; liveTeamIds: number[] | null; weeks?: number[]; onWeekChange?: (week: number | null) => void; onDetails: (matchup: FantasyMatchup) => void; mode?: 'league' | 'predictions' }) {
  const [expanded,setExpanded] = useState<number | null>(null);
  useEffect(()=>setExpanded(null),[week]);
  const live = weekLiveIds(week,currentWeek,liveTeamIds);
  const byId = useMemo(()=>new Map((predictions?.predictions || []).map(row=>[row.fantasy_matchup_id,row])),[predictions]);
  const own = matchups.fantasy_matchups.find(row=>row.involves_my_team && !row.is_bye);
  const others = matchups.fantasy_matchups.filter(row=>row!==own && !row.is_bye).sort((a,b)=>{
    const rank=(row:FantasyMatchup)=> { const p=byId.get(row.fantasy_matchup_id), state=fantasyState(row,live,week,currentWeek,p), sides=predictionSides(row,p); const gap=typeof sides.homeWin==='number'&&typeof sides.awayWin==='number'?Math.abs(sides.homeWin-sides.awayWin):2; return state==='FINAL'?4:state==='LIVE'?gap<.2?0:1:gap<.2?2:3; }; return rank(a)-rank(b);
  });
  const toggle=(id:number)=>setExpanded(current=>current===id?null:id);
  const detail=(row:FantasyMatchup)=><SmoothScoreReveal open={expanded===row.fantasy_matchup_id} id={`sf-matchup-${row.fantasy_matchup_id}`} label="Fantasy matchup details"><FantasyMatchupDetails matchup={row} prediction={byId.get(row.fantasy_matchup_id)} week={week} currentWeek={currentWeek} liveTeamIds={live}/></SmoothScoreReveal>;
  return <div className="sf-page sf-league"><header className="sf-page-heading"><div><h1>League matchups</h1><p>Your fantasy league, in play.</p></div>{onWeekChange && <ScoreWeekControl week={week} currentWeek={currentWeek} weeks={weeks} onChange={onWeekChange}/>}</header>
    {own && <><FantasyScoreFocus matchup={own} prediction={byId.get(own.fantasy_matchup_id)} myTeamId={myTeamId} week={week} currentWeek={currentWeek} liveTeamIds={live} expanded={expanded===own.fantasy_matchup_id} onExpand={()=>toggle(own.fantasy_matchup_id)}/>{detail(own)}</>}
    <section className="sf-league-board"><div className="sf-section-heading"><h2>League scores</h2><span>{others.length} matchups · Week {week}</span></div><ResultSequence identity={`${week}:${others.map(row=>row.fantasy_matchup_id).join(',')}`} className="sf-score-lanes">{others.map(row=><div key={row.fantasy_matchup_id}><FantasyScoreLane matchup={row} prediction={byId.get(row.fantasy_matchup_id)} week={week} currentWeek={currentWeek} liveTeamIds={live} expanded={expanded===row.fantasy_matchup_id} onExpand={()=>toggle(row.fantasy_matchup_id)}/>{detail(row)}</div>)}</ResultSequence>{!others.length&&<p className="sf-muted">No other matchups are published for this week.</p>}</section>
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
  useEffect(() => { const opener=document.activeElement as HTMLElement|null;dialog.current?.showModal();return()=>opener?.focus({preventScroll:true}); }, []);
  const state = fantasyState(matchup,liveTeamIds,week,currentWeek,prediction);
  const sides = predictionSides(matchup,prediction);
  return <dialog ref={dialog} className="details-dialog lm-detail-dialog" aria-labelledby="matchup-detail-title" onCancel={close} onClick={event=>{if(event.target===event.currentTarget)close();}}>
    <div className="dialog-inner"><header className="dialog-top"><div><span>Week {week} · {state}</span><h2 id="matchup-detail-title">Matchup details</h2></div><button type="button" className="icon-button" aria-label="Close matchup details" onClick={close}>×</button></header>
    <div className="sf-dialog-scores">{[{team:matchup.home_team,result:sides.home},{team:matchup.away_team,result:sides.away}].map(({team,result})=>team&&<div key={team.team_id}><FantasyIdentity team={team}/><AnimatedPoints value={fantasyScore(team,state,result).value}/><small>{state==='FINAL'?'Final':state==='LIVE'?'Current':'Projected'}</small></div>)}</div>
    <FantasyMatchupDetails matchup={matchup} prediction={prediction} week={week} currentWeek={currentWeek} liveTeamIds={liveTeamIds}/></div>
  </dialog>;
}
