'use client';
import { PlayerProjection } from './player-projection';
import { canonicalProjection } from '@/lib/api';

import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { Player, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';
import { usePlayerQuickView } from './player-quick-view';
import { motionAllowed, motionTiming } from '@/lib/motion';
import { nflTeamPalette } from '@/lib/nfl-team-colors';

gsap.registerPlugin(useGSAP);

type GameState = { label: string; kind: 'live' | 'final' | 'upcoming' | 'bye' | 'unknown' };

function getGameState(player: Player, week: number, liveTeamIds: number[] | null): GameState {
  if (player.bye_week === week) return { label: 'BYE', kind: 'bye' };
  if (player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id)) return { label: 'LIVE', kind: 'live' };
  if (!player.nfl_game_time) return { label: 'Game time unavailable', kind: 'unknown' };
  const kickoff = new Date(player.nfl_game_time);
  if (!Number.isFinite(kickoff.getTime())) return { label: 'Game time unavailable', kind: 'unknown' };
  if (kickoff.getTime() <= Date.now()) return liveTeamIds === null ? { label: 'Game status unavailable', kind: 'unknown' } : { label: 'FINAL', kind: 'final' };
  return { label: kickoff.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }), kind: 'upcoming' };
}

function teamAccent(player: Player) {
  return nflTeamPalette(player.nfl_team, player.nfl_team_color, player.nfl_team_alternate_color)?.[0] || '#343b49';
}

function recentAverage(player: Player) {
  const games = player.last_3_games?.length ? player.last_3_games : player.game_log?.slice(-3);
  const pointsPlayed = games?.map(game => game.fantasy_points).filter((value): value is number => typeof value === 'number') || [];
  return pointsPlayed.length ? pointsPlayed.reduce((sum, value) => sum + value, 0) / pointsPlayed.length : null;
}

export function AnimatedPoints({ value, format = points }: { value?: number | null; format?: (value?: number | null) => React.ReactNode }) {
  const output = useRef<HTMLElement>(null);
  const previous = useRef(value);
  useGSAP(() => {
    if (Object.is(previous.current, value)) return;
    previous.current = value;
    if (!motionAllowed() || !output.current) return;
    gsap.fromTo(output.current, { autoAlpha: 0.72, y: 3 }, { autoAlpha: 1, y: 0, duration: motionTiming.value, ease: 'power1.out', clearProps: 'opacity,visibility,transform' });
  }, { scope: output, dependencies: [value] });
  return <strong ref={output}>{format(value)}</strong>;
}

function PlayerIdentityButton({ player, className = '' }: { player: Player; className?: string }) {
  const quickView = usePlayerQuickView();
  return <button type="button" className={className} onClick={() => quickView?.open(player.player_id, player)}>{player.name}</button>;
}

export function CompactPlayerCard({ player, week, liveTeamIds = null, projection }: { player: Player; week: number; liveTeamIds?: number[] | null; projection?: number | null }) {
  const card = useRef<HTMLElement>(null);
  const { contextSafe } = useGSAP({ scope: card });
  const hoverIn = contextSafe(() => {
    if (!motionAllowed() || !card.current) return;
    gsap.to(card.current, { y: -2, scale: 1.005, duration: motionTiming.cardHover, ease: 'power2.out', overwrite: true });
  });
  const hoverOut = contextSafe(() => {
    if (!motionAllowed() || !card.current) return;
    gsap.to(card.current, { y: 0, scale: 1, duration: motionTiming.cardHover, ease: 'power2.out', overwrite: true });
  });
  const state = getGameState(player, week, liveTeamIds);
  const current = state.kind === 'live' || state.kind === 'final' ? player.fantasy_points : null;
  const projectionValue = projection ?? canonicalProjection(player);
  const recent = recentAverage(player);
  const status = String(player.injury_status || '').toUpperCase();
  const unavailable = /OUT|INJURED RESERVE|\bIR\b|PUP|SUSPENDED/.test(status);
  return <article ref={card} onMouseEnter={hoverIn} onMouseLeave={hoverOut} className={`board-player-card game-${state.kind} ${unavailable ? 'is-unavailable' : ''}`} style={{ '--player-accent': teamAccent(player), '--player-secondary': player.nfl_team_alternate_color && /^[\da-f]{6}$/i.test(player.nfl_team_alternate_color) ? `#${player.nfl_team_alternate_color}` : teamAccent(player) } as React.CSSProperties}>
    {player.nfl_team_logo_url && <img className="board-player-watermark" src={player.nfl_team_logo_url} alt="" aria-hidden="true"/>}
    <div className="board-player-top"><div><PlayerIdentityButton player={player} className="board-player-name"/><span>{player.nfl_team || 'Team unavailable'} · {player.position || 'Position unavailable'}</span></div><PlayerStatusButton player={player} compact/></div>
    <div className="board-player-image"><PlayerAvatar player={player} size="lg"/></div>
    <div className="board-player-game"><strong className={`board-game-state ${state.kind === 'live' ? 'is-live' : ''}`}>{state.kind === 'live' && <i/>}{state.label}</strong><span>{player.nfl_opponent ? `vs ${player.nfl_opponent}` : state.kind === 'bye' ? 'Bye week' : 'Opponent unavailable'}</span></div>
    <div className="board-player-numbers"><span><small>{state.kind === 'live' ? 'Live points' : state.kind === 'final' ? 'Final points' : 'Projection'}</small><PlayerProjection player={player} week={week}><AnimatedPoints value={state.kind === 'live' || state.kind === 'final' ? current : projectionValue}/></PlayerProjection></span><span><small>{state.kind === 'live' || state.kind === 'final' ? 'Projection' : 'Recent avg.'}</small>{state.kind === 'live' || state.kind === 'final' ? <PlayerProjection player={player} week={week} value={projectionValue}/> : <AnimatedPoints value={recent}/>}</span></div>
  </article>;
}

export function RosterPlayerCard({ player, slot, week, liveTeamIds = null, projection }: { player: Player; slot: string; week: number; liveTeamIds?: number[] | null; projection?: number | null }) {
  const card = useRef<HTMLElement>(null);
  const { contextSafe } = useGSAP({ scope: card });
  const hoverIn = contextSafe(() => {
    if (!motionAllowed() || !card.current) return;
    gsap.to(card.current, { y: -2, scale: 1.005, duration: motionTiming.cardHover, ease: 'power2.out', overwrite: true });
  });
  const hoverOut = contextSafe(() => {
    if (!motionAllowed() || !card.current) return;
    gsap.to(card.current, { y: 0, scale: 1, duration: motionTiming.cardHover, ease: 'power2.out', overwrite: true });
  });
  const state = getGameState(player, week, liveTeamIds);
  const current = player.fantasy_points;
  const ourProjection = projection ?? canonicalProjection(player);
  const model = player.custom_projection;
  const factors = model?.adjustments || [];
  const matchupNote = factors.find(factor => /matchup|defen[cs]e|opponent/i.test(`${factor.label} ${factor.evidence}`));
  return <article ref={card} onMouseEnter={hoverIn} onMouseLeave={hoverOut} className="roster-player-card" data-slot={slot} style={{ '--player-accent': teamAccent(player), '--player-secondary': player.nfl_team_alternate_color && /^[\da-f]{6}$/i.test(player.nfl_team_alternate_color) ? `#${player.nfl_team_alternate_color}` : teamAccent(player) } as React.CSSProperties}>
    {player.nfl_team_logo_url && <img className="roster-player-watermark" src={player.nfl_team_logo_url} alt="" aria-hidden="true"/>}
    <div className="roster-player-card-head"><span className="roster-player-slot">{slot}</span><PlayerStatusButton player={player} compact/></div>
    <div className="roster-player-portrait"><PlayerAvatar player={player} size="lg"/></div>
    <div className="roster-player-copy"><PlayerIdentityButton player={player} className="roster-player-name"/><span>{player.nfl_team || 'Team unavailable'} · {player.position || 'Position unavailable'}</span><span>{player.nfl_opponent ? `vs ${player.nfl_opponent}` : state.kind === 'bye' ? 'Bye week' : 'Opponent unavailable'}</span></div>
    <div className="roster-player-score"><span>{state.kind === 'live' ? 'LIVE' : state.kind === 'final' ? 'FINAL' : 'Projection'}</span><PlayerProjection player={player} week={week}><AnimatedPoints value={state.kind === 'live' || state.kind === 'final' ? current : ourProjection}/></PlayerProjection>{state.kind === 'live' && <small>Projection <PlayerProjection player={player} week={week} value={ourProjection}/></small>}</div>
    <details className="roster-player-details"><summary>Details <ChevronDown size={13}/></summary><div><span>Projection <b><PlayerProjection player={player}/></b></span><span>ESPN <b><PlayerProjection player={player} value={player.projected_fantasy_points}/></b></span><span>Floor <b><PlayerProjection player={player} value={model?.floor}/></b></span><span>Likely <b><PlayerProjection player={player} value={model?.median}/></b></span><span>Ceiling <b><PlayerProjection player={player} value={model?.ceiling}/></b></span><span>Recent avg. <b>{points(model?.recent_3_game_average ?? recentAverage(player))}</b></span><span>Confidence <b>{model?.confidence?.toUpperCase() || 'Unavailable'}</b></span>{matchupNote && <p>{matchupNote.evidence}</p>}{factors.length > 0 && <details><summary>How this was calculated</summary><ul>{factors.map((factor, index) => <li key={`${factor.key}-${index}`}>{factor.label}: {factor.evidence}</li>)}</ul></details>}</div></details>
  </article>;
}

export function BenchPlayerTile({ player, week, liveTeamIds = null, projection }: { player: Player; week: number; liveTeamIds?: number[] | null; projection?: number | null }) {
  const state = getGameState(player, week, liveTeamIds);
  return <article className="bench-player-tile" style={{ '--player-accent': teamAccent(player) } as React.CSSProperties}>
    <PlayerAvatar player={player} size="md"/><div className="bench-player-copy"><PlayerIdentityButton player={player} className="bench-player-name"/><span>{player.position || 'Position unavailable'} · {player.nfl_team || 'Team unavailable'}{player.nfl_opponent ? ` · vs ${player.nfl_opponent}` : ''}</span></div><span className={`bench-player-state state-${state.kind}`}>{state.kind === 'live' && <i/>}<PlayerProjection player={player} week={week} value={state.kind === 'live' || state.kind === 'final' ? player.fantasy_points : projection ?? canonicalProjection(player)}/></span><PlayerStatusButton player={player} compact/>
  </article>;
}

export function TradeAssetCard({ player, selected = false, onClick }: { player: Player; selected?: boolean; onClick?: () => void }) {
  return <button type="button" className={`trade-asset-card ${selected ? 'is-selected' : ''}`} onClick={onClick} style={{ '--player-accent': teamAccent(player) } as React.CSSProperties}><PlayerAvatar player={player} size="md"/><span><strong>{player.name}</strong><small>{player.position || 'Position unavailable'} · {player.nfl_team || 'Team unavailable'}</small></span><b><PlayerProjection player={player}/></b></button>;
}

export function FeaturedPlayerCard({ player, week, liveTeamIds = null }: { player: Player; week: number; liveTeamIds?: number[] | null }) {
  return <div className="featured-player-card"><CompactPlayerCard player={player} week={week} liveTeamIds={liveTeamIds}/></div>;
}
