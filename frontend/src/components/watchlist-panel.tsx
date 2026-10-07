'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Bookmark, Clock3, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { fetchBackend, requestBackend } from '@/lib/api';
import { Player, PlayerSearchResult, WatchlistItem, WatchlistLabel, WatchlistRecord } from '@/lib/types';
import { points } from '@/lib/types';
import { liveRefreshIntervalMs } from '@/lib/live-refresh.mjs';
import { PlayerAvatar } from './player-quick-view';

const labels: WatchlistLabel[] = ['Trade Target', 'Waiver Target', 'Opponent Player', 'Friend Player', 'Other'];
const emptyLabel = 'No label';
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function kickoff(value: string | null | undefined) { return value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unavailable'; }
function injury(value: string | null) { return value && !['ACTIVE','NORMAL'].includes(value) ? value.replaceAll('_',' ') : value || 'Unavailable'; }

export default function WatchlistPanel({ liveTeamIds }: { liveTeamIds: number[] | null }) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<PlayerSearchResult[]>([]);
  const [newLabel, setNewLabel] = useState<WatchlistLabel | ''>('');
  const [busyPlayer, setBusyPlayer] = useState<number | null>(null);
  const liveMode = liveTeamIds === null ? 'unknown' : liveTeamIds.length ? 'live' : 'idle';

  const loadItems = useCallback(async (signal?: AbortSignal) => {
    const response = await fetchBackend<{ items: WatchlistRecord[] }>('/watchlist', signal);
    const details = await Promise.all(response.items.map(async record => ({
      ...record,
      player: await fetchBackend<Player>(`/players/${record.player_id}`, signal),
    })));
    return details;
  }, []);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const data = await loadItems(signal);
    if (!signal?.aborted) { setItems(data); setUpdatedAt(new Date()); setRefreshError(null); }
  }, [loadItems]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    reload(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(message(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (loading || error) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try { await reload(controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setRefreshError(message(reason)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, liveRefreshIntervalMs(liveMode)); }
    };
    timer = setTimeout(poll, liveRefreshIntervalMs(liveMode));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loading, error, reload, liveMode]);

  async function searchPlayers(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSearching(true); setSearchError(null); setResults([]);
    try {
      const data = await fetchBackend<{ players: PlayerSearchResult[] }>(`/players/search?q=${encodeURIComponent(query.trim())}&limit=12`);
      setResults(data.players);
    } catch (reason) { setSearchError(message(reason)); }
    finally { setSearching(false); }
  }

  async function addPlayer(player: PlayerSearchResult) {
    setBusyPlayer(player.player_id); setSearchError(null);
    try {
      const saved = await requestBackend<WatchlistRecord & { player: Player }>('/watchlist', 'POST', {
        player_id: player.player_id, label: newLabel || null,
      });
      setItems(previous => [saved, ...previous.filter(item => item.player_id !== saved.player_id)]);
      setUpdatedAt(new Date());
      setResults(previous => previous.filter(result => result.player_id !== player.player_id));
    } catch (reason) { setSearchError(message(reason)); }
    finally { setBusyPlayer(null); }
  }

  async function changeLabel(playerId: number, value: string) {
    setBusyPlayer(playerId); setRefreshError(null);
    try {
      const label = value || null;
      const saved = await requestBackend<WatchlistRecord>(`/watchlist/${playerId}`, 'PATCH', { label });
      setItems(previous => previous.map(item => item.player_id === playerId ? { ...item, ...saved } : item));
      setUpdatedAt(new Date());
    } catch (reason) { setRefreshError(message(reason)); }
    finally { setBusyPlayer(null); }
  }

  async function removePlayer(playerId: number) {
    setBusyPlayer(playerId); setRefreshError(null);
    try {
      await requestBackend(`/watchlist/${playerId}`, 'DELETE');
      setItems(previous => previous.filter(item => item.player_id !== playerId));
      setUpdatedAt(new Date());
    } catch (reason) { setRefreshError(message(reason)); }
    finally { setBusyPlayer(null); }
  }

  async function manualRefresh() {
    setRefreshing(true);
    try { await reload(); } catch (reason) { setRefreshError(message(reason)); }
    finally { setRefreshing(false); }
  }

  return <div className="feature-page watchlist-page">
    <div className="feature-toolbar"><div><span className="eyebrow">PERSONAL PLAYER TRACKER</span><p>Track any player from ESPN&apos;s NFL player pool. Watchlist data is stored locally on this server.</p></div><div className="feature-toolbar-actions"><span className="timestamp"><Clock3 size={13}/>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : 'Not updated yet'}</span><button className="button" onClick={manualRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/> Refresh</button></div></div>
    {refreshError && <div className="refresh-warning" role="status">Watchlist refresh failed: {refreshError} Showing the last successful player data.</div>}
    <section className="panel watchlist-search-panel"><div className="panel-title"><div><h2>Find an NFL player</h2><p>Search ESPN&apos;s real active NFL player pool by name.</p></div><Search size={18}/></div><form className="watchlist-search" onSubmit={searchPlayers}><label className="sr-only" htmlFor="watchlist-query">Player name</label><div className="search-input"><Search size={17}/><input id="watchlist-query" value={query} onChange={event => setQuery(event.target.value)} minLength={2} maxLength={80} placeholder="Search player names…" required/></div><label className="label-select-wrap"><span>Label</span><select value={newLabel} onChange={event => setNewLabel(event.target.value as WatchlistLabel | '')}><option value="">No label</option>{labels.map(label => <option key={label}>{label}</option>)}</select></label><button className="button primary-button" disabled={searching || query.trim().length < 2}><Search size={14}/>{searching ? 'Searching…' : 'Search'}</button></form>
      {searchError && <p className="inline-error" role="alert">{searchError}</p>}
      {results.length > 0 && <div className="search-results">{results.map(player => <article className="search-result" key={player.player_id}><div className="player-cell"><PlayerAvatar player={player} size="sm"/><span className={`position pos-${player.position}`}>{player.position || '--'}</span><div><Link className="player-name player-link" href={`/players/${player.player_id}`}>{player.name}</Link><span className="player-meta">{player.nfl_team || '--'} · {player.injury_status || 'Status unavailable'}</span></div></div><span className="search-player-stats">{player.nfl_team || '--'} <span className="meta-dot">·</span> {player.position || '--'}</span><button className="button add-player-button" disabled={busyPlayer === player.player_id} onClick={() => addPlayer(player)}><Plus size={14}/>{busyPlayer === player.player_id ? 'Adding…' : 'Add'}</button></article>)}</div>}
      {!searching && query.trim().length >= 2 && results.length === 0 && !searchError && <p className="player-unavailable">No matching active NFL players were returned by ESPN.</p>}
    </section>
    <div className="section-link"><h2>Watched players <span className="inline-count">{items.length}</span></h2><span className="muted text-sm">ESPN player data · {liveMode === 'live' ? 'refreshing every 30 seconds during live games' : 'periodic updates enabled'}</span></div>
    {loading ? <div className="watchlist-grid">{[0,1,2].map(item => <div className="skeleton h-64" key={item}/>)}</div> : error ? <div className="error-card" role="alert"><Bookmark size={25}/><h2>Watchlist could not be loaded</h2><p>{error}</p><button className="button" onClick={manualRefresh}><RefreshCw size={14}/> Retry</button></div> : items.length === 0 ? <section className="panel watchlist-empty"><Bookmark size={28}/><h2>Your watchlist is empty</h2><p>Search for an NFL player above, then add them to keep their ESPN stats here.</p></section> : <div className="watchlist-grid">{items.map(item => {
      const player = item.player;
      const recent = (player.game_log || []).slice(-3).map(game => `W${game.week} ${points(game.fantasy_points)}`).join(' · ') || 'Unavailable';
      const live = player.nfl_team_id != null && (liveTeamIds || []).includes(player.nfl_team_id);
      return <article className="watch-player-card" key={item.player_id}>
        <div className="watch-player-heading"><div className="player-cell"><PlayerAvatar player={player} size="md"/><span className={`position pos-${player.position}`}>{player.position || '--'}</span><div><Link className="player-name player-link" href={`/players/${player.player_id}`}>{player.name}</Link><span className="player-meta">{player.nfl_team || '--'} · {player.position || 'Position unavailable'}</span></div></div>{live && <span className="live-indicator"><i/> LIVE</span>}</div>
        <div className="watch-player-matchup"><div><span>Upcoming opponent</span><strong>{player.nfl_opponent || '--'}</strong></div><div><span>Game time</span><strong>{kickoff(player.nfl_game_time)}</strong></div></div>
        <div className="watch-player-stats"><div><span>Status</span><strong className={player.injury_status && !['ACTIVE','NORMAL'].includes(player.injury_status) ? 'injury' : ''}>{injury(player.injury_status)}</strong></div><div><span>Current fantasy points</span><strong>{points(player.fantasy_points)}</strong></div><div><span>ESPN projected</span><strong>{points(player.projected_fantasy_points)}</strong></div><div><span>Season average</span><strong>{points(player.season_fantasy_average)}</strong></div><div className="recent-production"><span>Recent fantasy production</span><strong>{recent}</strong></div></div>
        <div className="watch-player-footer"><label><span className="sr-only">Watchlist label for {player.name}</span><select aria-label={`Watchlist label for ${player.name}`} value={item.label || ''} onChange={event => changeLabel(item.player_id, event.target.value)} disabled={busyPlayer === item.player_id}><option value="">No label</option>{labels.map(label => <option key={label}>{label}</option>)}</select></label><span className="timestamp"><Clock3 size={12}/>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : 'Not updated yet'}</span><button className="icon-button remove-watch-button" aria-label={`Remove ${player.name} from watchlist`} onClick={() => removePlayer(item.player_id)} disabled={busyPlayer === item.player_id}><Trash2 size={15}/></button></div>
      </article>;
    })}</div>}
  </div>;
}
