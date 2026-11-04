'use client';
import { PlayerProjection } from './player-projection';
import { FantasyTeamAvatar } from './fantasy-team-avatar';
import { canonicalProjection } from '@/lib/api';

import Link from 'next/link';
import { useRef, useState } from 'react';
import { nflTeamPalette } from '@/lib/nfl-team-colors';
import { ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { FantasyMatchup, FantasyPredictionSide, FantasyTeam, MatchupPrediction, Player, Snapshot, StartSitResponse, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton, usePlayerQuickView } from './player-quick-view';
import { PredictionBar, teamAccentColor } from './prediction-bar';
import { AnimatedPoints } from './player-board-cards';
import { motionAllowed, motionTiming } from '@/lib/motion';

gsap.registerPlugin(useGSAP);

type GameState = 'LIVE' | 'UPCOMING' | 'FINAL' | 'BYE' | 'SCHEDULE TBD';
function playerGameState(player: Player, liveTeamIds: number[] | null, week: number): GameState {
  if (player.bye_week === week) return 'BYE';
  if (player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id)) return 'LIVE';
  const time = player.nfl_game_time ? new Date(player.nfl_game_time).getTime() : NaN;
  if (!Number.isFinite(time)) return 'SCHEDULE TBD';
  return time > Date.now() ? 'UPCOMING' : liveTeamIds === null ? 'SCHEDULE TBD' : 'FINAL';
}
function matchupState(matchup: FantasyMatchup, snapshot: Snapshot, prediction?: MatchupPrediction): 'PREGAME' | 'LIVE' | 'FINAL' {
  const active = [matchup.home_team, matchup.away_team].flatMap(team => team?.roster?.filter(player => player.is_starter && !/OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/i.test(String(player.injury_status || ''))) || []);
  const states = active.map(player => playerGameState(player, snapshot.liveTeamIds, snapshot.league.current_week));
  if (states.includes('LIVE')) return 'LIVE';
  if (states.includes('UPCOMING')) return 'PREGAME';
  if (snapshot.liveTeamIds !== null && states.length > 0 && states.every(state => state === 'FINAL' || state === 'BYE')) return 'FINAL';
  const noModeledPlayers = prediction?.team_a?.modeled_players?.length === 0 && prediction.team_b?.modeled_players?.length === 0;
  const scored = (matchup.home_team?.current_fantasy_score || 0) > 0 && (matchup.away_team?.current_fantasy_score || 0) > 0;
  return snapshot.liveTeamIds !== null && prediction?.status !== 'unavailable' && noModeledPlayers && scored ? 'FINAL' : 'PREGAME';
}
function playerCount(team: FantasyTeam | null, side: FantasyPredictionSide | undefined, snapshot: Snapshot) {
  if (side?.modeled_players) return side.modeled_players.length;
  return team?.roster?.filter(player => player.is_starter && ['LIVE', 'UPCOMING'].includes(playerGameState(player, snapshot.liveTeamIds, snapshot.league.current_week))).length ?? null;
}

function FantasyWatermark({ team }: { team: FantasyTeam }) {
  return <FantasyTeamAvatar team={team} className="v9-fantasy-mark"/>;
}

function MatchupSurface({ snapshot, matchup, prediction, onDetails }: { snapshot: Snapshot; matchup?: FantasyMatchup; prediction?: MatchupPrediction; onDetails: () => void }) {
  if (!matchup) return <section className="v9-matchup-surface"><span>Week {snapshot.league.current_week}</span><strong>No fantasy matchup has been posted.</strong></section>;
  const home = matchup.home_team, away = matchup.away_team;
  const homeSide = prediction ? (prediction.team_a?.team_id === home?.team_id ? prediction.team_a : prediction.team_b) : undefined;
  const awaySide = prediction ? (prediction.team_a?.team_id === away?.team_id ? prediction.team_a : prediction.team_b) : undefined;
  const homeWin = prediction ? (prediction.team_a?.team_id === home?.team_id ? prediction.team_a_win_probability : prediction.team_b_win_probability) : undefined;
  const awayWin = prediction ? (prediction.team_a?.team_id === away?.team_id ? prediction.team_a_win_probability : prediction.team_b_win_probability) : undefined;
  const state = matchupState(matchup, snapshot, prediction);
  const score = (team: FantasyTeam | null, side: FantasyPredictionSide | undefined) => state === 'LIVE' || state === 'FINAL' ? team?.current_fantasy_score : side?.expected_final_score ?? side?.projected_final_score ?? team?.projected_fantasy_score;
  const leftCount = playerCount(home, homeSide, snapshot), rightCount = playerCount(away, awaySide, snapshot);
  const remapped = prediction ? { ...prediction, team_a: homeSide, team_b: awaySide, team_a_win_probability: homeWin, team_b_win_probability: awayWin } as MatchupPrediction : undefined;
  return <section className={`v9-matchup-surface state-${state.toLowerCase()}`} data-pointer-reactive aria-label="Current fantasy matchup" style={{ '--left-identity': teamAccentColor(home?.team_id, home?.primary_color), '--right-identity': teamAccentColor(away?.team_id, away?.primary_color) } as React.CSSProperties}>
    <div className="v9-matchup-heading"><span>Week {snapshot.league.current_week} · Your matchup</span><b className={`v9-state state-${state.toLowerCase()}`}>{state === 'LIVE' && <i/>}{state}</b><button type="button" onClick={onDetails}>Open matchup <ArrowUpRight size={14}/></button></div>
    <div className="v9-matchup-teams">
      {[{ team: home, side: homeSide, count: leftCount, isMine: home?.team_id === snapshot.team.team_id }, { team: away, side: awaySide, count: rightCount, isMine: away?.team_id === snapshot.team.team_id }].map(({ team, side, count, isMine }, index) => <div className={`v9-matchup-team ${index ? 'is-away' : ''}`} key={team?.team_id ?? index} style={{ '--team-identity': teamAccentColor(team?.team_id, team?.primary_color) } as React.CSSProperties}>
        {team?.team_logo_url ? <FantasyWatermark team={team}/> : null}
        <div className="v9-team-copy"><span>{isMine ? 'Your team' : 'Opponent'}{team?.record ? ` · ${team.record.wins}–${team.record.losses}–${team.record.ties}` : ''}</span><strong title={team?.team_name}>{team?.team_name || 'Team unavailable'}</strong></div>
        <div className="v9-team-score"><span>{state === 'FINAL' ? 'Final' : state === 'LIVE' ? 'Current' : 'Projected'}</span><AnimatedPoints value={score(team || null, side)}/></div>
        <small className="v9-players-left">{count == null ? 'Players left unavailable' : `${count} ${count === 1 ? 'player' : 'players'} left`}</small>
      </div>)}
      <span className="v9-matchup-divider" aria-hidden="true">{state === 'FINAL' ? 'FINAL' : 'VS'}</span>
    </div>
    {prediction && state !== 'FINAL' && typeof homeWin === 'number' && typeof awayWin === 'number' ? <div className="v9-matchup-probability"><div><span>Win chance</span><b>{Math.round(homeWin * 100)}% <i>—</i> {Math.round(awayWin * 100)}%</b></div><PredictionBar prediction={remapped} homeName={home?.team_name || 'Home'} awayName={away?.team_name || 'Away'} homeId={home?.team_id} awayId={away?.team_id} homeColor={home?.primary_color} awayColor={away?.primary_color}/></div> : <div className="v9-matchup-probability v9-probability-unavailable"><span>{state === 'FINAL' ? 'Final result' : 'Win chance unavailable'}</span>{state === 'FINAL' && <b>{points(home?.current_fantasy_score)} <i>—</i> {points(away?.current_fantasy_score)}</b>}</div>}
  </section>;
}

function slotKey(player: Player) {
  const raw = String(player.lineup_slot || '').trim().toUpperCase();
  if (['RB/WR/TE', 'RB/WR', 'WR/TE', 'FLEX', 'OP', 'UTIL'].includes(raw)) return 'FLEX';
  if (['DST', 'DEF', 'D/ST'].includes(raw)) return 'D/ST';
  if (['QB', 'RB', 'WR', 'TE', 'K'].includes(raw)) return raw;
  return player.position === 'DST' || player.position === 'DEF' ? 'D/ST' : player.position || 'OTHER';
}
function sortStarters(players: Player[]) {
  const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'D/ST'];
  const rows = players.map((player, index) => ({ player, index, key: slotKey(player) })).sort((a, b) => (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)) || a.index - b.index);
  return rows.map(({ player, key }, index) => ({ player, slot: ['RB', 'WR'].includes(key) ? `${key}${rows.slice(0, index).filter(row => row.key === key).length + 1}` : key }));
}
function StarterModule({ player, slot, snapshot, projection }: { player: Player; slot: string; snapshot: Snapshot; projection?: number | null }) {
  const state = playerGameState(player, snapshot.liveTeamIds, snapshot.league.current_week);
  const value = state === 'LIVE' || state === 'FINAL' ? player.fantasy_points : projection ?? canonicalProjection(player);
  const unavailable = /OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/i.test(String(player.injury_status || ''));
  const quickView = usePlayerQuickView();
  return <article className={`v9-starter-module ${state === 'LIVE' ? 'is-live' : ''} ${unavailable ? 'is-unavailable' : ''}`} data-pointer-reactive style={{ '--team-identity': nflTeamPalette(player.nfl_team, player.nfl_team_color, player.nfl_team_alternate_color)?.[0] || '#414d60' } as React.CSSProperties}>
    <div className="v9-starter-top"><span>{slot}</span><span className={`v9-mini-state state-${state.toLowerCase()}`}>{state === 'LIVE' && <i/>}{state}</span></div>
    <div className="v9-starter-main"><PlayerAvatar player={player} size="md"/><div className="v9-starter-copy"><button type="button" onClick={() => quickView?.open(player.player_id, player)}>{player.name}</button><span>{player.nfl_team || '—'} · {player.position || '—'}</span><small>{player.nfl_opponent ? `vs ${player.nfl_opponent}` : state === 'BYE' ? 'Bye week' : 'Opponent unavailable'}</small></div></div>
    <div className="v9-starter-bottom"><span>{state === 'LIVE' ? 'Current' : state === 'FINAL' ? 'Final' : 'Projection'}</span><b><PlayerProjection player={player} week={snapshot.league.current_week} value={value}><AnimatedPoints value={value}/></PlayerProjection></b><PlayerStatusButton player={player} compact/></div>
  </article>;
}

function StarterBoard({ snapshot, customProjections, onNavigate }: { snapshot: Snapshot; customProjections: Record<number, number | null>; onNavigate: (page: string) => void }) {
  const grid = useRef<HTMLDivElement>(null);
  const starters = sortStarters(snapshot.team.roster?.filter(player => player.is_starter) || []);
  const key = starters.map(({ player, slot }) => `${slot}:${player.player_id}`).join('|');
  useGSAP(() => {
    const modules = grid.current?.querySelectorAll<HTMLElement>('.v9-starter-module');
    if (!modules?.length || !motionAllowed()) return;
    gsap.fromTo(modules, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: motionTiming.cardEnter, stagger: 0.018, ease: 'power2.out', clearProps: 'opacity,visibility,transform' });
  }, { scope: grid, dependencies: [key], revertOnUpdate: true });
  return <section className="v9-starter-board" aria-labelledby="v9-starters-heading"><div className="v9-section-heading"><div><h2 id="v9-starters-heading">Your starters</h2></div><button type="button" onClick={() => onNavigate('My Team')}>Manage roster <ArrowRight size={15}/></button></div>
    {starters.length ? <div className="v9-starter-grid" ref={grid}>{starters.map(({ player, slot }) => <StarterModule key={player.player_id} player={player} slot={slot} snapshot={snapshot} projection={customProjections[player.player_id]}/>)}</div> : <p className="v9-empty-line">ESPN has not supplied your starters for this week.</p>}
  </section>;
}

function AttentionQueue({ snapshot }: { snapshot: Snapshot }) {
  const now = Date.now();
  const alerts = (snapshot.team.roster || []).filter(player => player.is_starter).map(player => {
    if (playerGameState(player, snapshot.liveTeamIds, snapshot.league.current_week) === 'FINAL') return null;
    const status = String(player.injury_status || '').toUpperCase().replaceAll('_', ' ');
    const severity = /OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/.test(status) ? 0 : /DOUBTFUL/.test(status) ? 1 : /QUESTIONABLE|DTD|DAY TO DAY|LIMITED/.test(status) ? 2 : 5;
    const kickoff = player.nfl_game_time ? new Date(player.nfl_game_time).getTime() : null;
    const soon = kickoff != null && kickoff > now && kickoff - now <= 2 * 60 * 60 * 1000;
    if (severity < 5) return { player, severity, title: status || 'Status update', note: severity <= 1 ? 'Plan a backup before kickoff.' : 'Check status before kickoff.' };
    if (soon && player.nfl_team_id != null && !snapshot.liveTeamIds?.includes(player.nfl_team_id)) return { player, severity: 3, title: `Game starts ${new Date(kickoff!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, note: 'Set your lineup before kickoff.' };
    return null;
  }).filter((item): item is NonNullable<typeof item> => item !== null).sort((a, b) => a.severity - b.severity).slice(0, 4);
  return <section className="v9-action-module" aria-labelledby="v9-attention-heading"><div className="v9-section-heading compact"><div><h2 id="v9-attention-heading">Needs attention</h2></div></div>
    {alerts.length ? <div className="v9-action-list">{alerts.map(({ player, title, note }) => <div className="v9-action-item" key={player.player_id}><PlayerAvatar player={player} size="sm"/><div><Link href={`/players/${player.player_id}`}>{player.name}</Link><span>{title} · {note}</span></div><PlayerStatusButton player={player} compact/></div>)}</div> : <div className="v9-all-clear"><Check size={15}/><span>All set. Your lineup needs no attention right now.</span></div>}
  </section>;
}

function NextDecision({ data, state, onNavigate }: { data: StartSitResponse | null; state: 'PREGAME' | 'LIVE' | 'FINAL'; onNavigate: (page: string) => void }) {
  if (state === 'FINAL') return <section className="v9-decision-module"><h2>Games are final</h2><p>Your matchup is in the books.</p><button type="button" onClick={() => onNavigate('League Matchups')}>View league results <ArrowRight size={14}/></button></section>;
  const decisions = data?.lineup_changes.decisions || [];
  const decision = decisions.find(item => item.confidence === 'high') || decisions.find(item => item.confidence === 'medium') || decisions[0];
  if (!decision) return null;
  return <section className="v9-decision-module"><h2>Lineup check</h2><div className="v9-decision-pair"><span><b>START</b><PlayerAvatar player={decision.start} size="sm"/><Link href={`/players/${decision.start.player_id}`}>{decision.start.name}</Link></span><i>→</i><span><b>BENCH</b><PlayerAvatar player={decision.bench} size="sm"/><Link href={`/players/${decision.bench.player_id}`}>{decision.bench.name}</Link></span></div><p>{decision.confidence === 'low' ? 'Close call — either choice is reasonable.' : `${points(decision.expected_advantage)} projected points of upside.`}</p><button type="button" onClick={() => onNavigate('Start/Sit')}>Review decision <ArrowRight size={14}/></button></section>;
}

function LeagueTicker({ snapshot, onDetails, onNavigate }: { snapshot: Snapshot; onDetails: (matchup: FantasyMatchup) => void; onNavigate: (page: string) => void }) {
  const matchups = snapshot.matchups.fantasy_matchups.filter(matchup => !matchup.involves_my_team && !matchup.is_bye);
  return <section className="v9-league-ticker" aria-labelledby="v9-league-heading"><div className="v9-section-heading"><div><h2 id="v9-league-heading">Around the league</h2></div><button type="button" onClick={() => onNavigate('League Matchups')}>All matchups <ArrowRight size={15}/></button></div>
    {matchups.length ? <div className="v9-ticker-list">{matchups.map(matchup => { const prediction = snapshot.predictions?.predictions.find(row => row.fantasy_matchup_id === matchup.fantasy_matchup_id); const state = matchupState(matchup, snapshot, prediction); return <button type="button" key={matchup.fantasy_matchup_id} className="v9-ticker-matchup" onClick={() => onDetails(matchup)}><span style={{ '--team-identity': teamAccentColor(matchup.home_team?.team_id, matchup.home_team?.primary_color) } as React.CSSProperties}>{matchup.home_team?.team_name || 'Team'} <b><AnimatedPoints value={matchup.home_team?.current_fantasy_score}/></b></span><i>—</i><span style={{ '--team-identity': teamAccentColor(matchup.away_team?.team_id, matchup.away_team?.primary_color) } as React.CSSProperties}>{matchup.away_team?.team_name || 'Team'} <b><AnimatedPoints value={matchup.away_team?.current_fantasy_score}/></b></span><small className={`state-${state.toLowerCase()}`}>{state}</small></button>; })}</div> : <p className="v9-empty-line">League matchups have not been posted.</p>}
  </section>;
}

export default function DashboardHome({ snapshot, startSit, onNavigate, onDetails, customProjections = {} }: { snapshot: Snapshot; startSit: StartSitResponse | null; onNavigate: (page: string) => void; onDetails: (matchup: FantasyMatchup) => void; customProjections?: Record<number, number | null> }) {
  const matchup = snapshot.matchups.fantasy_matchups.find(item => item.involves_my_team);
  const prediction = matchup ? snapshot.predictions?.predictions.find(item => item.fantasy_matchup_id === matchup.fantasy_matchup_id) : undefined;
  const state = matchup ? matchupState(matchup, snapshot, prediction) : 'PREGAME';
  return <div className="v9-dashboard-workspace">
    <div className="v9-dashboard-intro"><div><span className="v9-week-chip">Week {snapshot.league.current_week}</span><h1>Your fantasy week, at a glance.</h1><p>{snapshot.league.league_name} <i/> {snapshot.team.team_name} <i/> {snapshot.team.record.wins}–{snapshot.team.record.losses}–{snapshot.team.record.ties}</p></div><span className="v9-live-status">{state === 'LIVE' && <i/>}{state}</span></div>
    <MatchupSurface snapshot={snapshot} matchup={matchup} prediction={prediction} onDetails={() => matchup && onDetails(matchup)}/>
    <div className="v9-dashboard-main"><div className="v9-primary-column"><StarterBoard snapshot={snapshot} customProjections={customProjections} onNavigate={onNavigate}/><LeagueTicker snapshot={snapshot} onDetails={onDetails} onNavigate={onNavigate}/></div><aside className="v9-secondary-column"><AttentionQueue snapshot={snapshot}/><NextDecision data={startSit} state={state} onNavigate={onNavigate}/></aside></div>
  </div>;
}
