'use client';

import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { FantasyTeam, Player, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';

type GameState = { label: string; kind: 'live' | 'final' | 'upcoming' | 'unknown' };

function gameState(player: Player, liveTeamIds: number[] | null): GameState {
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

function RosterSlotRow({ player, slot, bench, liveTeamIds, customProjection }: {
  player: Player;
  slot: string;
  bench?: boolean;
  liveTeamIds: number[] | null;
  customProjection: number | null | undefined;
}) {
  const state = gameState(player, liveTeamIds);
  const accent = player.nfl_team_color && /^[\da-f]{6}$/i.test(player.nfl_team_color) ? `#${player.nfl_team_color}` : '#6d7460';
  const raw = player.custom_projection;
  const ourProjection = customProjection ?? raw?.our_projection;
  const factors = raw?.adjustments || [];
  const matchupNote = factors.find(factor => /matchup|defen[cs]e|opponent/i.test(`${factor.label} ${factor.evidence}`));
  const status = String(player.injury_status || '').toUpperCase();
  return <article className={`roster-slot-row ${bench ? 'is-bench' : 'is-starter'}`} style={{ '--roster-team-accent': accent } as React.CSSProperties}>
    <div className="roster-slot-label">{slot}</div>
    <PlayerAvatar player={player} size="lg"/>
    <div className="roster-slot-identity">
      <Link className="roster-slot-name" href={`/players/${player.player_id}`}>{player.name}</Link>
      <div className="roster-slot-meta"><span>{player.nfl_team || 'Team unavailable'}</span><span aria-hidden="true">·</span><span>{player.nfl_opponent ? `vs ${player.nfl_opponent}` : 'Opponent unavailable'}</span></div>
      <div className="roster-slot-state-line">
        <span className={`roster-game-state state-${state.kind}`}>{state.kind === 'live' && <i/>}{state.label}</span>
        <PlayerStatusButton player={player}/>
      </div>
    </div>
    <div className="roster-slot-points">
      <span className={state.kind === 'live' ? 'roster-live-label' : ''}>{state.kind === 'live' ? 'LIVE POINTS' : 'CURRENT'}</span>
      <strong className={state.kind === 'live' ? 'is-live-score' : ''}>{points(player.fantasy_points)}</strong>
    </div>
    <div className="roster-slot-projection"><span>PROJECTED</span><strong>{points(ourProjection)}</strong></div>
    <details className="roster-slot-details">
      <summary><span>View details</span><ChevronDown size={15}/></summary>
      <div className="roster-detail-content">
        <div className="roster-detail-values">
          <span>Our model <b>{points(raw?.our_projection ?? customProjection)}</b></span>
          <span>ESPN <b>{points(player.projected_fantasy_points)}</b></span>
          <span>Floor <b>{points(raw?.floor)}</b></span>
          <span>Likely <b>{points(raw?.median)}</b></span>
          <span>Ceiling <b>{points(raw?.ceiling)}</b></span>
          <span>Recent avg. <b>{points(raw?.recent_3_game_average)}</b></span>
          <span>Data confidence <b>{raw?.confidence ? raw.confidence.toUpperCase() : 'Unavailable'}</b></span>
        </div>
        {matchupNote && <p className="roster-matchup-note"><strong>Matchup:</strong> {matchupNote.evidence}</p>}
        {status && !['ACTIVE', 'NORMAL', 'HEALTHY'].includes(status) && <p className="roster-matchup-note"><strong>Status:</strong> Check the status details above before kickoff.</p>}
        {factors.length > 0 && <details className="roster-advanced-details"><summary>How this was calculated</summary><ul>{factors.map((factor, index) => <li key={`${factor.key}-${index}`}>{factor.label}: {factor.evidence}</li>)}</ul></details>}
      </div>
    </details>
  </article>;
}

export default function RosterLineupBoard({ team, week, liveTeamIds = [], customProjections = {} }: {
  team: FantasyTeam;
  week: number;
  liveTeamIds?: number[] | null;
  customProjections?: Record<number, number | null>;
}) {
  if (team.roster === null) return <div className="roster-unavailable">ESPN roster data is unavailable right now.</div>;
  const starters = sortStarters(team.roster.filter(player => player.is_starter));
  const bench = team.roster.filter(player => !player.is_starter && player.lineup_status.toLowerCase() === 'bench');
  const ir = team.roster.filter(player => !player.is_starter && (player.lineup_status.toLowerCase() === 'reserve' || /^(IR|IR\/R|PUP|SUSP)$/i.test(String(player.lineup_slot || ''))));
  const starterGames = starters.map(({ player }) => gameState(player, liveTeamIds));
  const playing = starterGames.filter(game => game.kind === 'live' || game.kind === 'upcoming').length;
  const injuryPlayers = team.roster.filter(player => {
    const value = String(player.injury_status || '').toUpperCase();
    return value && !['ACTIVE', 'NORMAL', 'HEALTHY'].includes(value);
  });
  const projectedValues = starters.map(({ player }) => customProjections[player.player_id] ?? player.custom_projection?.our_projection).filter((value): value is number => typeof value === 'number');
  const projectedTotal = projectedValues.length ? projectedValues.reduce((total, value) => total + value, 0) : team.projected_fantasy_score;
  const currentValues = starters.map(({ player }) => player.fantasy_points).filter((value): value is number => typeof value === 'number');
  const currentTotal = typeof team.current_fantasy_score === 'number' ? team.current_fantasy_score : currentValues.length ? currentValues.reduce((total, value) => total + value, 0) : null;

  return <div className="my-team-page">
    <header className="roster-page-heading">
      <div className="roster-heading-copy"><span className="roster-kicker">MY TEAM · WEEK {week}</span><h1>{team.team_name}</h1><p>{team.record.wins}–{team.record.losses}–{team.record.ties} record</p></div>
      <div className="roster-record-mark"><span>FANTASY ROSTER</span><strong>{team.roster.length}</strong><small>players</small></div>
    </header>

    <section className="roster-summary-strip" aria-label="Team summary">
      <div><span>PROJECTED TOTAL</span><strong>{points(projectedTotal)}</strong></div>
      <div><span>CURRENT SCORE</span><strong>{points(currentTotal)}</strong></div>
      <div><span>PLAYERS LEFT</span><strong>{playing}</strong></div>
      <div><span>INJURY STATUS</span><strong>{injuryPlayers.length ? `${injuryPlayers.length} to check` : 'All clear'}</strong></div>
    </section>

    {injuryPlayers.length > 0 && <section className="roster-attention" aria-label="Roster health">
      <div><span className="roster-attention-mark">!</span><div><strong>Needs attention</strong><p>{injuryPlayers.length} {injuryPlayers.length === 1 ? 'player has' : 'players have'} a listed status.</p></div></div>
      <div className="roster-attention-players">{injuryPlayers.slice(0, 4).map(player => <span key={player.player_id}><Link href={`/players/${player.player_id}`}>{player.name}</Link><PlayerStatusButton player={player}/></span>)}</div>
    </section>}

    <section className="roster-sheet-section" aria-labelledby="starting-lineup-title">
      <div className="roster-section-heading"><div><span className="roster-kicker">ON THE FIELD</span><h2 id="starting-lineup-title">Starting lineup</h2></div><span>{starters.length} starters</span></div>
      {starters.length ? <div className="roster-sheet-list">{starters.map(({ player, label }) => <RosterSlotRow key={player.player_id} player={player} slot={label} liveTeamIds={liveTeamIds} customProjection={customProjections[player.player_id]}/>)}</div> : <div className="roster-unavailable">No starting players were supplied for Week {week}.</div>}
    </section>

    <section className="roster-secondary-section" aria-labelledby="bench-title">
      <div className="roster-section-heading"><div><span className="roster-kicker">AVAILABLE DEPTH</span><h2 id="bench-title">Bench</h2></div><span>{bench.length} players</span></div>
      {bench.length ? <div className="roster-sheet-list">{bench.map(player => <RosterSlotRow key={player.player_id} player={player} slot={player.position || 'BENCH'} bench liveTeamIds={liveTeamIds} customProjection={customProjections[player.player_id]}/>)}</div> : <div className="roster-unavailable">No bench players were supplied for this week.</div>}
    </section>

    {ir.length > 0 && <section className="roster-secondary-section roster-ir-section" aria-labelledby="ir-title">
      <div className="roster-section-heading"><div><span className="roster-kicker">RESERVE</span><h2 id="ir-title">Injured reserve</h2></div><span>{ir.length} players</span></div>
      <div className="roster-sheet-list">{ir.map(player => <RosterSlotRow key={player.player_id} player={player} slot="IR" bench liveTeamIds={liveTeamIds} customProjection={customProjections[player.player_id]}/>)}</div>
    </section>}
  </div>;
}
