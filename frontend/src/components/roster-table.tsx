import Link from 'next/link';
import { Player, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';

function slotLabel(player: Player, counts: Map<string, number>) {
  const raw = String(player.lineup_slot || '').toUpperCase();
  const base = raw === 'OP' || raw === 'UTIL' ? player.position || raw : raw || player.position || '--';
  const normalized = base === 'DST' || base === 'DEF' ? 'D/ST' : base;
  const count = (counts.get(normalized) || 0) + 1;
  counts.set(normalized, count);
  return ['RB','WR'].includes(normalized) ? `${normalized}${count}` : normalized;
}

export function RosterTable({ players, opponent = false, compact = false, liveTeamIds = [], customProjections = {} }: { players: Player[] | null; opponent?: boolean; compact?: boolean; liveTeamIds?: number[]; customProjections?: Record<number, number | null> }) {
  if (players === null) return <div className="empty">Roster unavailable. ESPN did not supply a roster for this week.</div>;
  if (!players.length) return <div className="empty">No players in this group.</div>;
  const counts = new Map<string, number>();
  return <div className={`lineup-board ${compact ? 'compact' : ''}`}>
    {players.map(player => {
      const slot = slotLabel(player, counts);
      const isLive = player.nfl_team_id != null && liveTeamIds.includes(player.nfl_team_id);
      const accent = player.nfl_team_color && /^[\da-f]{6}$/i.test(player.nfl_team_color) ? `#${player.nfl_team_color}` : '#71859a';
      return <article className="lineup-row" key={player.player_id} style={{ '--player-team-accent': accent } as React.CSSProperties}>
        <div className="lineup-slot">{slot}</div>
        <div className="lineup-player"><PlayerAvatar player={player} size="md"/><div className="lineup-identity"><div className="lineup-name-line"><Link className="player-name player-link" href={`/players/${player.player_id}`}>{player.name}</Link><span className="lineup-player-team">{player.nfl_team && player.nfl_team !== 'None' ? player.nfl_team : '--'}{opponent && ` · vs ${player.nfl_opponent || '--'}`}{isLive && <span className="live-pill"><i/> LIVE</span>}</span></div><PlayerStatusButton player={player}/></div></div>
        <div className="lineup-stats"><span className="lineup-opponent">{opponent ? player.nfl_opponent || '--' : player.lineup_status === 'starter' ? 'Starter' : 'Bench'}</span><div className="lineup-stat primary"><span>{isLive ? 'LIVE' : 'Points'}</span><strong>{points(player.fantasy_points)}</strong></div><div className="lineup-stat"><span>Our proj</span><strong>{points(customProjections[player.player_id])}</strong></div><div className="lineup-stat"><span>ESPN</span><strong>{points(player.projected_fantasy_points)}</strong></div></div>
      </article>;
    })}
  </div>;
}
