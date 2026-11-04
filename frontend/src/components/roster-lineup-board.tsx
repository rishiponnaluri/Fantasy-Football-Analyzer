'use client';
import { canonicalProjection } from '@/lib/api';

import Link from 'next/link';
import { useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { FantasyTeam, Player, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';
import { BenchPlayerTile, RosterPlayerCard } from './player-board-cards';
import { motionAllowed, motionTiming } from '@/lib/motion';

gsap.registerPlugin(useGSAP);

type GameState = { label: string; kind: 'live' | 'final' | 'upcoming' | 'bye' | 'unknown' };

function gameState(player: Player, liveTeamIds: number[] | null, week: number): GameState {
  if (player.bye_week === week) return { label: 'BYE', kind: 'bye' };
  if (player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id)) return { label: 'LIVE', kind: 'live' };
  if (!player.nfl_game_time) return { label: 'Game time unavailable', kind: 'unknown' };
  const kickoff = new Date(player.nfl_game_time);
  if (Number.isNaN(kickoff.getTime())) return { label: 'Game time unavailable', kind: 'unknown' };
  if (kickoff.getTime() <= Date.now()) return liveTeamIds === null ? { label: 'Game status unavailable', kind: 'unknown' } : { label: 'FINAL', kind: 'final' };
  return {
    label: kickoff.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    kind: 'upcoming',
  };
}

function slotKey(player: Player) {
  const raw = String(player.lineup_slot || '').trim().toUpperCase();
  if (['RB/WR/TE', 'RB/WR', 'WR/TE', 'FLEX', 'OP', 'UTIL'].includes(raw)) return 'FLEX';
  if (['DST', 'DEF', 'D/ST'].includes(raw)) return 'D/ST';
  if (['QB', 'RB', 'WR', 'TE', 'K'].includes(raw)) return raw;
  const position = String(player.position || '').toUpperCase();
  return ['DST', 'DEF', 'D/ST'].includes(position) ? 'D/ST' : position || 'OTHER';
}

function sortStarters(players: Player[]) {
  const order = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'D/ST'];
  return players.map((player, index) => ({ player, index, key: slotKey(player) }))
    .sort((a, b) => (order.indexOf(a.key) < 0 ? 99 : order.indexOf(a.key)) - (order.indexOf(b.key) < 0 ? 99 : order.indexOf(b.key)) || a.index - b.index)
    .map(({ player, key }, index, sorted) => {
      const sameBefore = sorted.slice(0, index).filter(row => row.key === key).length;
      const count = sorted.filter(row => row.key === key).length;
      const label = count > 1 && ['RB', 'WR'].includes(key) ? `${key}${sameBefore + 1}` : key;
      return { player, label };
    });
}

export default function RosterLineupBoard({ team, week, liveTeamIds = [], customProjections = {} }: {
  team: FantasyTeam;
  week: number;
  liveTeamIds?: number[] | null;
  customProjections?: Record<number, number | null>;
}) {
  const lineup = useRef<HTMLDivElement>(null);
  const roster = team.roster;
  const starters = sortStarters(roster?.filter(player => player.is_starter) || []);
  const starterKey = starters.map(({ player, label }) => `${label}:${player.player_id}`).join(',');
  const bench = roster?.filter(player => !player.is_starter && player.lineup_status.toLowerCase() === 'bench') || [];
  const ir = roster?.filter(player => !player.is_starter && (player.lineup_status.toLowerCase() === 'reserve' || /^(IR|IR\/R|PUP|SUSP)$/i.test(String(player.lineup_slot || '')))) || [];
  const starterGames = starters.map(({ player }) => gameState(player, liveTeamIds, week));
  const playing = starterGames.filter(game => game.kind === 'live' || game.kind === 'upcoming').length;
  const injuryPlayers = (roster || []).filter(player => {
    const value = String(player.injury_status || '').toUpperCase();
    return value && !['ACTIVE', 'NORMAL', 'HEALTHY'].includes(value);
  });
  const projectedValues = starters.map(({ player }) => customProjections[player.player_id] ?? canonicalProjection(player)).filter((value): value is number => typeof value === 'number');
  const projectedTotal = projectedValues.length ? projectedValues.reduce((total, value) => total + value, 0) : team.projected_fantasy_score;
  const currentValues = starters.map(({ player }) => player.fantasy_points).filter((value): value is number => typeof value === 'number');
  const currentTotal = typeof team.current_fantasy_score === 'number' ? team.current_fantasy_score : currentValues.length ? currentValues.reduce((total, value) => total + value, 0) : null;
  useGSAP(() => {
    const cards = lineup.current?.querySelectorAll<HTMLElement>('.roster-player-card');
    if (!cards?.length || !motionAllowed()) return;
    gsap.fromTo(cards, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: motionTiming.cardEnter, stagger: 0.025, ease: 'power2.out', clearProps: 'opacity,visibility,transform' });
  }, { scope: lineup, dependencies: [starterKey], revertOnUpdate: true });

  if (roster === null) return <div className="roster-unavailable">ESPN roster data is unavailable right now.</div>;

  return <div className="my-team-page">
    <header className="roster-page-heading board-roster-heading">
      <div className="roster-heading-copy"><span className="roster-kicker">Week {week} · My Team</span><h1>{team.team_name}</h1><p>{team.record.wins}–{team.record.losses}–{team.record.ties} record</p></div>
      <div className="roster-record-mark"><span>Roster</span><strong>{roster.length}</strong><small>players</small></div>
    </header>

    <section className="roster-summary-strip board-roster-summary" aria-label="Team summary">
      <div><span>Projected total</span><strong>{points(projectedTotal)}</strong></div>
      <div><span>Current</span><strong>{points(currentTotal)}</strong></div>
      <div><span>Playing</span><strong>{playing}</strong></div>
      <div><span>Status</span><strong>{injuryPlayers.length ? `${injuryPlayers.length} to check` : 'All clear'}</strong></div>
    </section>

    {injuryPlayers.length > 0 && <section className="roster-attention" aria-label="Roster health">
      <div><span className="roster-attention-mark">!</span><div><strong>Needs attention</strong><p>{injuryPlayers.length} {injuryPlayers.length === 1 ? 'player has' : 'players have'} a listed status.</p></div></div>
      <div className="roster-attention-players">{injuryPlayers.slice(0, 4).map(player => <span key={player.player_id}><Link href={`/players/${player.player_id}`}>{player.name}</Link><PlayerStatusButton player={player}/></span>)}</div>
    </section>}

    <section className="roster-sheet-section board-starters-section" aria-labelledby="starting-lineup-title">
      <div className="roster-section-heading"><div><h2 id="starting-lineup-title">Your lineup</h2></div><span>{starters.length} starters</span></div>
      {starters.length ? <div className="roster-card-grid premium-lineup-grid" ref={lineup}>{starters.map(({ player, label }) => <RosterPlayerCard key={player.player_id} player={player} slot={label} week={week} liveTeamIds={liveTeamIds} projection={customProjections[player.player_id]}/>)}</div> : <div className="roster-unavailable">No starting players were supplied for Week {week}.</div>}
    </section>

    <section className="roster-secondary-section" aria-labelledby="bench-title">
      <div className="roster-section-heading"><div><h2 id="bench-title">Bench</h2></div><span>{bench.length} players</span></div>
      {bench.length ? <div className="bench-player-list">{bench.map(player => <BenchPlayerTile key={player.player_id} player={player} week={week} liveTeamIds={liveTeamIds} projection={customProjections[player.player_id]}/>)}</div> : <div className="roster-unavailable">No bench players were supplied for this week.</div>}
    </section>

    {ir.length > 0 && <section className="roster-secondary-section roster-ir-section" aria-labelledby="ir-title">
      <div className="roster-section-heading"><div><h2 id="ir-title">Injured reserve</h2></div><span>{ir.length} players</span></div>
      <div className="bench-player-list">{ir.map(player => <BenchPlayerTile key={player.player_id} player={player} week={week} liveTeamIds={liveTeamIds} projection={customProjections[player.player_id]}/>)}</div>
    </section>}
  </div>;
}
