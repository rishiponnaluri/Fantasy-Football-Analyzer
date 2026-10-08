'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import { FantasyMatchup, FantasyPredictionSide, FantasyTeam, MatchupPrediction, Player, Snapshot, StartSitResponse, ownerNames, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';
import { PredictionBar, teamAccentColor } from './prediction-bar';

type GameState = 'LIVE' | 'UPCOMING' | 'FINAL' | 'BYE' | 'SCHEDULE TBD';
const teamColorFallbacks: Record<string, [string, string]> = {
  SEA: ['#002244', '#69BE28'], PHI: ['#004C54', '#A5ACAF'], BAL: ['#241773', '#9E7C0C'],
  TB: ['#D50A0A', '#34302B'], BUF: ['#00338D', '#C60C30'], SF: ['#AA0000', '#B3995D'],
  PIT: ['#FFB612', '#101820'], IND: ['#002C5F', '#A2AAAD'], LAR: ['#003594', '#FFA300'],
  JAX: ['#006778', '#D7A22A'], ATL: ['#A71930', '#000000'], DAL: ['#003594', '#869397'],
};

function playerGameState(player: Player, liveTeamIds: number[] | null, week: number): GameState {
  if (player.bye_week === week) return 'BYE';
  if (player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id)) return 'LIVE';
  const kickoff = player.nfl_game_time ? new Date(player.nfl_game_time) : null;
  if (kickoff && Number.isFinite(kickoff.getTime())) {
    if (kickoff.getTime() > Date.now()) return 'UPCOMING';
    return liveTeamIds === null ? 'SCHEDULE TBD' : 'FINAL';
  }
  return 'SCHEDULE TBD';
}

function matchupState(matchup: FantasyMatchup, liveTeamIds: number[] | null, week: number, prediction?: MatchupPrediction): 'PREGAME' | 'LIVE' | 'FINAL' {
  const starters = [matchup.home_team, matchup.away_team].flatMap(team => team?.roster?.filter(player => player.is_starter && !/OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/i.test(String(player.injury_status || ''))) || []);
  const states = starters.map(player => playerGameState(player, liveTeamIds, week));
  if (states.includes('LIVE')) return 'LIVE';
  if (states.includes('UPCOMING')) return 'PREGAME';
  if (liveTeamIds !== null && states.length > 0 && states.every(state => ['FINAL', 'BYE'].includes(state))) return 'FINAL';
  const noPlayersRemain = prediction?.team_a?.modeled_players?.length === 0 && prediction.team_b?.modeled_players?.length === 0;
  const bothTeamsScored = (matchup.home_team?.current_fantasy_score || 0) > 0 && (matchup.away_team?.current_fantasy_score || 0) > 0;
  if (liveTeamIds !== null && prediction?.status !== 'unavailable' && noPlayersRemain && bothTeamsScored) return 'FINAL';
  return 'PREGAME';
}

function playerLeft(team: FantasyTeam | null, side: FantasyPredictionSide | undefined, liveTeamIds: number[] | null, week: number) {
  if (side?.modeled_players) return side.modeled_players.length;
  return team?.roster?.filter(player => player.is_starter && ['LIVE', 'UPCOMING'].includes(playerGameState(player, liveTeamIds, week))).length ?? null;
}

function teamScore(team: FantasyTeam | null, isMine: boolean, side: FantasyPredictionSide | undefined, state: 'PREGAME' | 'LIVE' | 'FINAL') {
  if (!team) return null;
  const current = team.current_fantasy_score;
  const projection = side?.expected_final_score ?? side?.projected_final_score ?? team.projected_fantasy_score;
  const value = state === 'FINAL' ? current : state === 'LIVE' ? current : projection;
  const label = state === 'FINAL' ? 'FINAL SCORE' : state === 'LIVE' ? 'CURRENT' : 'PROJECTED';
  return { team, isMine, value, label, current, projection, color: teamAccentColor(team.team_id, team.primary_color) };
}

function DashboardTeamScore({ team, isMine, side, state }: { team: FantasyTeam | null; isMine: boolean; side?: FantasyPredictionSide; state: 'PREGAME' | 'LIVE' | 'FINAL' }) {
  const [logoFailed, setLogoFailed] = useState(false);
  if (!team) return <div className="broadcast-team-side editorial-score-team empty"><span>Fantasy team</span><strong>Bye week</strong><small>No opponent this week</small></div>;
  const score = teamScore(team, isMine, side, state)!;
  return <div className={`broadcast-team-side editorial-score-team ${isMine ? 'is-mine' : ''}`} style={{ '--fantasy-accent': score.color } as React.CSSProperties}>
    <div className="home-team-identity">
      <span className="home-team-logo">{team.team_logo_url && !logoFailed ? <img src={team.team_logo_url} alt="" onError={() => setLogoFailed(true)}/> : (team.abbreviation || team.team_name.slice(0, 2))}</span>
      <div><span>{isMine ? 'YOUR TEAM' : 'OPPONENT'}</span><strong title={team.team_name}>{team.team_name}</strong><small>{ownerNames(team) || 'Owner unavailable'}{isMine && team.record ? ` · ${team.record.wins}–${team.record.losses}–${team.record.ties}` : ''}</small></div>
    </div>
    <div className="home-score-reading"><small>{score.label}</small><strong>{points(score.value)}</strong><span>{state === 'FINAL' ? 'Final' : `Projected ${points(score.projection)}`}</span></div>
    {state === 'LIVE' && <div className="home-team-current"><span>Current</span><b>{points(score.current)}</b></div>}
  </div>;
}

function MatchupHero({ snapshot, matchup, prediction, onDetails }: { snapshot: Snapshot; matchup: FantasyMatchup | undefined; prediction?: MatchupPrediction; onDetails: () => void }) {
  if (!matchup) return <section className="broadcast-matchup-stage editorial-score-stage home-matchup-empty"><span className="home-kicker">Week {snapshot.league.current_week}</span><h2>No fantasy matchup scheduled</h2><p>ESPN has not published a matchup for your team this week.</p></section>;
  const state = matchupState(matchup, snapshot.liveTeamIds, snapshot.league.current_week, prediction);
  const home = matchup.home_team;
  const away = matchup.away_team;
  const homeSide = prediction ? prediction.team_a?.team_id === home?.team_id ? prediction.team_a : prediction.team_b : undefined;
  const awaySide = prediction ? prediction.team_a?.team_id === away?.team_id ? prediction.team_a : prediction.team_b : undefined;
  const homeWin = prediction ? prediction.team_a?.team_id === home?.team_id ? prediction.team_a_win_probability : prediction.team_b_win_probability : undefined;
  const awayWin = prediction ? prediction.team_a?.team_id === away?.team_id ? prediction.team_a_win_probability : prediction.team_b_win_probability : undefined;
  const mySide = home?.team_id === snapshot.team.team_id ? homeSide : awaySide;
  const opponentSide = home?.team_id === snapshot.team.team_id ? awaySide : homeSide;
  const myLeft = playerLeft(snapshot.team, mySide, snapshot.liveTeamIds, snapshot.league.current_week);
  const opponent = home?.team_id === snapshot.team.team_id ? away : home;
  const opponentLeft = playerLeft(opponent || null, opponentSide, snapshot.liveTeamIds, snapshot.league.current_week);
  const finalWinner = home?.current_fantasy_score != null && away?.current_fantasy_score != null
    ? home.current_fantasy_score === away.current_fantasy_score ? 'TIE' : home.current_fantasy_score > away.current_fantasy_score ? home.team_id === snapshot.team.team_id ? 'YOU WON' : 'OPPONENT WON' : away?.team_id === snapshot.team.team_id ? 'YOU WON' : 'OPPONENT WON'
    : 'FINAL';
  return <section className={`broadcast-matchup-stage editorial-score-stage state-${state.toLowerCase()}`} style={{ '--home-opponent-color': teamAccentColor(home?.team_id, home?.primary_color), '--home-my-color': teamAccentColor(away?.team_id, away?.primary_color) } as React.CSSProperties} aria-label="Current fantasy matchup">
    <div className="home-matchup-topline editorial-score-caption"><span>Week {snapshot.league.current_week} <i>·</i> Your matchup</span><span className={`home-matchup-state ${state.toLowerCase()}`}>{state === 'LIVE' && <i/>}{state === 'FINAL' ? finalWinner : state}</span></div>
    <div className="broadcast-scoreboard editorial-scoreboard">
      <DashboardTeamScore team={home} isMine={home?.team_id === snapshot.team.team_id} side={homeSide} state={state}/>
      <div className="broadcast-versus editorial-versus"><span>{state === 'FINAL' ? 'FINAL' : 'VS'}</span></div>
      <DashboardTeamScore team={away} isMine={away?.team_id === snapshot.team.team_id} side={awaySide} state={state}/>
    </div>
    {state !== 'FINAL' && <div className="broadcast-odds">
      {typeof homeWin === 'number' && typeof awayWin === 'number' ? <>
        <div className="home-win-labels"><span style={{ color: teamAccentColor(home?.team_id, home?.primary_color) }}>{home?.team_name || 'Home'} <b>{Math.round(homeWin * 100)}%</b></span><span style={{ color: teamAccentColor(away?.team_id, away?.primary_color) }}>{away?.team_name || 'Away'} <b>{Math.round(awayWin * 100)}%</b></span></div>
        <PredictionBar prediction={prediction ? { ...prediction, team_a: homeSide, team_b: awaySide, team_a_win_probability: homeWin, team_b_win_probability: awayWin } : undefined} homeName={home?.team_name || 'Home'} awayName={away?.team_name || 'Away'} homeId={home?.team_id} awayId={away?.team_id} homeColor={home?.primary_color} awayColor={away?.primary_color}/>
      </> : <div className="home-odds-unavailable">Win chance unavailable</div>}
    </div>}
    <div className="broadcast-matchup-foot editorial-score-foot"><span>{myLeft == null ? '--' : myLeft} players left for you</span><span>{opponentLeft == null ? '--' : opponentLeft} for {opponent?.team_name || 'opponent'}</span><button type="button" onClick={onDetails}>Open matchup <ArrowUpRight size={14}/></button></div>
  </section>;
}

function GameDayPlayer({ player, state }: { player: Player; state: GameState }) {
  const isOut = /OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/i.test(String(player.injury_status || ''));
  const fallbackColors = teamColorFallbacks[String(player.nfl_team || '').toUpperCase()];
  const accent = player.nfl_team_color && /^[\da-f]{6}$/i.test(player.nfl_team_color) ? `#${player.nfl_team_color}` : fallbackColors?.[0] || '#777a6c';
  const secondaryAccent = player.nfl_team_alternate_color && /^[\da-f]{6}$/i.test(player.nfl_team_alternate_color) ? `#${player.nfl_team_alternate_color}` : fallbackColors?.[1] || accent;
  const currentLabel = state === 'LIVE' ? 'Live' : state === 'FINAL' ? 'Final' : 'Points';
  return <article className={`game-day-tile editorial-day-player state-${state.toLowerCase().replaceAll(' ', '-')} ${isOut ? 'is-out' : ''}`} style={{ '--player-accent': accent, '--player-accent-secondary': secondaryAccent } as React.CSSProperties}>
    {player.nfl_team_logo_url && <img className="game-day-watermark" src={player.nfl_team_logo_url} alt="" aria-hidden="true"/>}
    <div className="game-day-topline editorial-day-topline"><span className={`game-day-state ${state.toLowerCase().replaceAll(' ', '-')}`}>{state === 'LIVE' && <i/>}{state === 'UPCOMING' && player.nfl_game_time ? new Date(player.nfl_game_time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : state}</span>{isOut ? <span className="game-day-out">OUT</span> : <PlayerStatusButton player={player}/>}</div>
    <div className="game-day-portrait editorial-day-portrait"><PlayerAvatar player={player} size="lg"/></div>
    <div className="game-day-copy editorial-day-copy"><Link href={`/players/${player.player_id}`}>{player.name}</Link><span>{player.position || '--'} · {player.nfl_team || '--'}</span><span className="editorial-day-opponent">{player.nfl_opponent ? `vs ${player.nfl_opponent}` : state === 'BYE' ? 'Bye week' : 'Opponent unavailable'}</span></div>
    <div className="game-day-points editorial-day-points"><span className="editorial-day-current"><small>{currentLabel}</small><b>{points(player.fantasy_points)}</b></span><span className="editorial-day-projection"><small>Proj.</small><b>{points(player.custom_projection?.our_projection ?? player.projected_fantasy_points)}</b></span></div>
  </article>;
}

function GameDayRail({ snapshot, onNavigate }: { snapshot: Snapshot; onNavigate: (page: string) => void }) {
  const starters = snapshot.team.roster?.filter(player => player.is_starter) || [];
  const stateOrder: Record<GameState, number> = { LIVE: 0, UPCOMING: 1, FINAL: 2, 'SCHEDULE TBD': 3, BYE: 4 };
  const players = starters.map(player => ({ player, state: playerGameState(player, snapshot.liveTeamIds, snapshot.league.current_week) }))
    .sort((a, b) => stateOrder[a.state] - stateOrder[b.state]);
  return <section className="game-day-section editorial-today" aria-labelledby="game-day-heading">
    <div className="home-section-heading"><div><h2 id="game-day-heading">Today</h2><span className="editorial-section-note">Your players on the field this week</span></div><button type="button" onClick={() => onNavigate('My Team')}>View lineup <ArrowRight size={14}/></button></div>
    {players.length ? <div className="game-day-rail">{players.map(({ player, state }) => <GameDayPlayer key={player.player_id} player={player} state={state}/>)}</div> : <p className="home-empty-line">No starting players are listed for this week.</p>}
  </section>;
}

function AttentionQueue({ snapshot }: { snapshot: Snapshot }) {
  const now = Date.now();
  const starters = snapshot.team.roster?.filter(player => player.is_starter) || [];
  const alerts = starters.map(player => {
    if (playerGameState(player, snapshot.liveTeamIds, snapshot.league.current_week) === 'FINAL') return null;
    const status = String(player.injury_status || '').toUpperCase().replaceAll('_', ' ');
    const severity = /OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/.test(status) ? 0 : /DOUBTFUL/.test(status) ? 1 : /QUESTIONABLE|DTD|DAY TO DAY|LIMITED/.test(status) ? 2 : 5;
    const kickoff = player.nfl_game_time ? new Date(player.nfl_game_time).getTime() : null;
    const soon = kickoff != null && kickoff > now && kickoff - now <= 2 * 60 * 60 * 1000;
    if (severity < 5) return { player, severity, title: status || 'Status update', note: severity <= 1 ? 'Plan a backup before kickoff.' : 'Check his status before kickoff.' };
    if (soon && player.nfl_team_id != null && !snapshot.liveTeamIds?.includes(player.nfl_team_id)) return { player, severity: 3, title: `Game starts ${new Date(kickoff!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, note: 'Make your lineup choice before kickoff.' };
    return null;
  }).filter((item): item is NonNullable<typeof item> => item !== null).sort((a,b) => a.severity - b.severity).slice(0, 4);
  return <section className="home-side-module attention-queue" aria-labelledby="attention-heading"><div className="home-section-heading compact"><div><span className="home-kicker">ACTION QUEUE</span><h2 id="attention-heading">Needs attention</h2></div></div>
    {alerts.length ? <div className="attention-queue-list">{alerts.map(({ player, title, note }) => <div className="attention-queue-item" key={player.player_id}>
      <PlayerAvatar player={player} size="md"/><div className="attention-copy"><Link href={`/players/${player.player_id}`}>{player.name}</Link><small>{title} · {note}</small></div><PlayerStatusButton player={player}/>
    </div>)}</div> : <div className="home-all-set"><span><Check size={15}/></span><div><strong>All set</strong><small>Your starters have no urgent status updates.</small></div></div>}
  </section>;
}

function NextDecision({ data, state, onNavigate }: { data: StartSitResponse | null; state: 'PREGAME' | 'LIVE' | 'FINAL'; onNavigate: (page: string) => void }) {
  if (state === 'FINAL') return <section className="home-side-module next-decision week-complete"><div className="home-section-heading compact"><div><span className="home-kicker">WEEK COMPLETE</span><h2>Games are final</h2></div><span className="week-complete-mark"><Check size={15}/></span></div><p>Your matchup is in the books. Check the scores around Grindset.</p><button className="home-inline-link" type="button" onClick={() => onNavigate('League Matchups')}>View league results <ArrowRight size={14}/></button></section>;
  const decisions = data?.lineup_changes.decisions || [];
  const decision = decisions.find(item => item.confidence === 'high') || decisions.find(item => item.confidence === 'medium') || decisions[0];
  if (!decision) return null;
  return <section className="home-side-module next-decision" aria-labelledby="next-decision-heading"><div className="home-section-heading compact"><div><span className="home-kicker">LINEUP MOVE</span><h2 id="next-decision-heading">Next decision</h2></div><span className={`home-decision-confidence ${decision.confidence}`}>{decision.confidence.toUpperCase()}</span></div>
    <div className="next-decision-pair"><div><span>START</span><PlayerAvatar player={decision.start} size="md"/><Link href={`/players/${decision.start.player_id}`}>{decision.start.name}</Link><small>{decision.start.position} · {decision.start.nfl_team}</small></div><ArrowRight size={16}/><div><span>BENCH</span><PlayerAvatar player={decision.bench} size="md"/><Link href={`/players/${decision.bench.player_id}`}>{decision.bench.name}</Link><small>{decision.bench.position} · {decision.bench.nfl_team}</small></div></div>
    <p className="next-decision-edge">{decision.confidence === 'low' ? 'Close call — keeping your current starter is reasonable.' : `About ${points(decision.expected_advantage)} projected points better.`}</p><button className="home-inline-link" type="button" onClick={() => onNavigate('Start/Sit')}>Review decision <ArrowRight size={14}/></button>
  </section>;
}

function LeaguePulse({ snapshot, onDetails }: { snapshot: Snapshot; onDetails: (matchup: FantasyMatchup) => void }) {
  const matchups = snapshot.matchups.fantasy_matchups.filter(matchup => !matchup.involves_my_team && !matchup.is_bye);
  const predictionFor = (matchup: FantasyMatchup) => snapshot.predictions?.predictions.find(prediction => prediction.fantasy_matchup_id === matchup.fantasy_matchup_id);
  const live = matchups.find(matchup => matchupState(matchup, snapshot.liveTeamIds, snapshot.league.current_week, predictionFor(matchup)) === 'LIVE');
  const item = live || matchups.find(matchup => (matchup.home_team?.current_fantasy_score || 0) > 0 || (matchup.away_team?.current_fantasy_score || 0) > 0);
  if (!item) return null;
  const state = matchupState(item, snapshot.liveTeamIds, snapshot.league.current_week, predictionFor(item));
  const home = item.home_team; const away = item.away_team;
  return <section className="home-side-module league-pulse" aria-label="League pulse"><div className="home-section-heading compact"><div><span className="home-kicker">{state === 'LIVE' ? 'AROUND THE LEAGUE · LIVE' : 'LEAGUE PULSE'}</span><h2>{state === 'LIVE' ? 'Game in progress' : 'Another matchup'}</h2></div></div>
    <button className="pulse-scoreline" type="button" onClick={() => onDetails(item)}>
      <span className="pulse-team" style={{ '--fantasy-accent': teamAccentColor(home?.team_id, home?.primary_color) } as React.CSSProperties}><b>{home?.team_name || 'Team'}</b><strong>{points(home?.current_fantasy_score)}</strong></span>
      <span className={`pulse-status ${state.toLowerCase()}`}>{state === 'LIVE' && <i/>}{state}</span>
      <span className="pulse-team" style={{ '--fantasy-accent': teamAccentColor(away?.team_id, away?.primary_color) } as React.CSSProperties}><b>{away?.team_name || 'Team'}</b><strong>{points(away?.current_fantasy_score)}</strong></span>
    </button>
  </section>;
}

function AroundTheLeague({ snapshot, onDetails, onNavigate }: { snapshot: Snapshot; onDetails: (matchup: FantasyMatchup) => void; onNavigate: (page: string) => void }) {
  const matchups = snapshot.matchups.fantasy_matchups.filter(matchup => !matchup.involves_my_team && !matchup.is_bye).slice(0, 5);
  return <section className="around-league-home" aria-labelledby="around-league-home-heading"><div className="home-section-heading"><div><span className="home-kicker">SCORES AROUND GRINDSET</span><h2 id="around-league-home-heading">Around the league</h2></div><button type="button" onClick={() => onNavigate('League Matchups')}>All matchups <ArrowRight size={14}/></button></div>
    {matchups.length ? <div className="league-matchup-rail">{matchups.map(matchup => <button key={matchup.fantasy_matchup_id} className="league-matchup-strip" type="button" onClick={() => onDetails(matchup)}>
      <span className="league-strip-team" style={{ '--fantasy-accent': teamAccentColor(matchup.home_team?.team_id, matchup.home_team?.primary_color) } as React.CSSProperties}><b>{matchup.home_team?.team_name || 'Team'}</b><strong>{points(matchup.home_team?.current_fantasy_score)}</strong></span><span className="league-strip-divider">—</span><span className="league-strip-team away" style={{ '--fantasy-accent': teamAccentColor(matchup.away_team?.team_id, matchup.away_team?.primary_color) } as React.CSSProperties}><b>{matchup.away_team?.team_name || 'Team'}</b><strong>{points(matchup.away_team?.current_fantasy_score)}</strong></span><small>{matchupState(matchup, snapshot.liveTeamIds, snapshot.league.current_week, snapshot.predictions?.predictions.find(prediction => prediction.fantasy_matchup_id === matchup.fantasy_matchup_id))}</small>
    </button>)}</div> : <p className="home-empty-line">League matchups have not been posted.</p>}
  </section>;
}

function LineupPreview({ snapshot, data, onNavigate }: { snapshot: Snapshot; data: StartSitResponse | null; onNavigate: (page: string) => void }) {
  const starters = data?.recommended_starters?.length ? data.recommended_starters : snapshot.team.roster?.filter(player => player.is_starter) || [];
  return <section className="lineup-preview-home" aria-labelledby="lineup-preview-heading"><div className="home-section-heading"><div><span className="home-kicker">THIS WEEK</span><h2 id="lineup-preview-heading">Your lineup</h2></div><button type="button" onClick={() => onNavigate('My Team')}>View My Team <ArrowRight size={14}/></button></div>
    {starters.length ? <div className="lineup-preview-list">{starters.slice(0, 10).map((player, index) => {
      const recommended = player as Player & Partial<StartSitResponse['recommended_starters'][number]>;
      const slot = recommended.recommended_slot_label || recommended.recommended_slot || player.lineup_slot;
      const projection = recommended.recommendation_projection ?? player.custom_projection?.our_projection ?? player.projected_fantasy_points;
      const status = String(player.injury_status || '').toUpperCase();
      return <div className="lineup-preview-row" key={player.player_id}><span>{slot || player.position || `P${index + 1}`}</span><Link href={`/players/${player.player_id}`}>{player.name}</Link><strong>{points(projection)}</strong>{status && !['ACTIVE','NORMAL','HEALTHY'].includes(status) && <i aria-label={status}>!</i>}</div>;
    })}</div> : <p className="home-empty-line">ESPN has not supplied your starters.</p>}
  </section>;
}

export default function DashboardHome({ snapshot, startSit, onNavigate, onDetails }: { snapshot: Snapshot; startSit: StartSitResponse | null; onNavigate: (page: string) => void; onDetails: (matchup: FantasyMatchup) => void }) {
  const matchup = snapshot.matchups.fantasy_matchups.find(item => item.involves_my_team);
  const prediction = matchup ? snapshot.predictions?.predictions.find(item => item.fantasy_matchup_id === matchup.fantasy_matchup_id) : undefined;
  const currentState = matchup ? matchupState(matchup, snapshot.liveTeamIds, snapshot.league.current_week, prediction) : 'PREGAME';
  return <div className="dashboard-home broadcast-home editorial-dashboard">
    <div className="broadcast-deckline editorial-deckline"><div><span>Week {snapshot.league.current_week}</span><b>{snapshot.league.league_name || 'Fantasy League'}</b></div><p>{snapshot.team.team_name}{snapshot.team.record ? ` · ${snapshot.team.record.wins}–${snapshot.team.record.losses}–${snapshot.team.record.ties}` : ''}<small>{snapshot.league.fantasy_team_count} teams</small></p></div>
    <div className="editorial-score-story"><MatchupHero snapshot={snapshot} matchup={matchup} prediction={prediction} onDetails={() => matchup && onDetails(matchup)}/></div>
    <GameDayRail snapshot={snapshot} onNavigate={onNavigate}/>
    <div className="dashboard-editorial-grid editorial-home-columns">
      <AttentionQueue snapshot={snapshot}/><NextDecision data={startSit} state={currentState} onNavigate={onNavigate}/><LeaguePulse snapshot={snapshot} onDetails={onDetails}/>
    </div>
    <div className="dashboard-lower-grid editorial-home-lower"><AroundTheLeague snapshot={snapshot} onDetails={onDetails} onNavigate={onNavigate}/><LineupPreview snapshot={snapshot} data={startSit} onNavigate={onNavigate}/></div>
  </div>;
}
