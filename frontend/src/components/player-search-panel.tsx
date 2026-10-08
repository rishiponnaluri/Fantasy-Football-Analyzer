'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Bookmark, BookmarkCheck, Search } from 'lucide-react';
import { fetchBackend, requestBackend } from '@/lib/api';
import { Player, PlayerSearchResult, WatchlistItem, WatchlistLabel, WatchlistRecord, points } from '@/lib/types';
import { liveRefreshIntervalMs } from '@/lib/live-refresh.mjs';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';

const positions = ['QB','RB','WR','TE','K','D/ST'] as const;
const labels: WatchlistLabel[] = ['Trade Target','Waiver Target','Opponent Player','Friend Player','Other'];
const sorts = [['our_projection','Our projection'],['espn_projection','ESPN projection'],['season_points','Season fantasy points'],['points_per_game','Fantasy points per game'],['recent','Recent production']];
function playerSortValue(player: PlayerSearchResult, sort: string) {
  if (sort === 'our_projection') return player.custom_projection?.our_projection;
  if (sort === 'espn_projection') return player.projected_fantasy_points;
  if (sort === 'season_points') return player.season_fantasy_points;
  if (sort === 'points_per_game') return player.season_fantasy_average;
  const games = player.game_log || [];
  const values = games.slice(-3).map(game => game.fantasy_points).filter((value): value is number => typeof value === 'number');
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}
export default function PlayerSearchPanel({ liveTeamIds }: { liveTeamIds: number[] | null }) {
  const [query, setQuery] = useState('');
  const [team, setTeam] = useState('');
  const [position, setPosition] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState('our_projection');
  const [scope, setScope] = useState<'all' | 'saved'>('all');
  const [players, setPlayers] = useState<PlayerSearchResult[]>([]);
  const [saved, setSaved] = useState<WatchlistItem[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedUpdatedAt, setSavedUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const savedResults = useMemo(() => saved.map(item => item.player as PlayerSearchResult).filter(player =>
    (!query.trim() || player.name.toLowerCase().includes(query.trim().toLowerCase())) &&
    (!team || player.nfl_team?.toUpperCase().includes(team.toUpperCase())) &&
    (!position || player.position === position) &&
    (!status || player.roster_status === status))
    .sort((a,b) => (playerSortValue(b, sort) ?? -Infinity) - (playerSortValue(a, sort) ?? -Infinity)), [saved, query, team, position, status, sort]);

  const loadSaved = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchBackend<{ items: WatchlistItem[] }>('/watchlist', signal);
    if (!signal?.aborted) { setSaved(result.items); setSavedError(null); setSavedUpdatedAt(new Date()); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setSavedLoading(true);
    loadSaved(controller.signal).catch(reason => { if (!controller.signal.aborted) setSavedError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setSavedLoading(false); });
    return () => controller.abort();
  }, [loadSaved]);

  useEffect(() => {
    if (savedLoading) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try { await loadSaved(controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setSavedError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, liveRefreshIntervalMs(liveTeamIds === null ? 'unknown' : liveTeamIds.length ? 'live' : 'idle')); }
    };
    timer = setTimeout(poll, liveRefreshIntervalMs(liveTeamIds === null ? 'unknown' : liveTeamIds.length ? 'live' : 'idle'));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [savedLoading, loadSaved, liveTeamIds?.join(',')]);

  useEffect(() => {
    const changed = () => { void loadSaved().catch(reason => setSavedError(reason instanceof Error ? reason.message : String(reason))); };
    window.addEventListener('watchlist:changed', changed);
    return () => window.removeEventListener('watchlist:changed', changed);
  }, [loadSaved]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (scope === 'all' && !query.trim() && !team && !position && !status) { setError('Enter a name or choose at least one filter.'); return; }
    setLoading(true); setError(null); setSearched(true);
    try {
      if (scope === 'saved') {
        setPlayers(savedResults.slice(0,30));
      } else {
        const params = new URLSearchParams({ sort, limit: '30' });
        if (query.trim()) params.set('q', query.trim());
        if (team.trim()) params.set('team', team.trim().toUpperCase());
        if (position) params.set('position', position);
        if (status) params.set('status', status);
        const result = await fetchBackend<{ players: PlayerSearchResult[] }>(`/players/search?${params}`);
        setPlayers(result.players);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }
  async function toggleSaved(player: PlayerSearchResult | Player) {
    setBusy(player.player_id); setSavedError(null);
    try {
      const current = saved.find(item => item.player_id === player.player_id);
      if (current) {
        await requestBackend(`/watchlist/${player.player_id}`, 'DELETE');
        setSaved(rows => rows.filter(item => item.player_id !== player.player_id));
      } else {
        const record = await requestBackend<WatchlistRecord & { player: Player }>('/watchlist', 'POST', { player_id: player.player_id, label: null });
        setSaved(rows => [{ ...record, player: record.player }, ...rows.filter(item => item.player_id !== player.player_id)]);
      }
      window.dispatchEvent(new CustomEvent('watchlist:changed', { detail: { playerId: player.player_id, saved: !current } }));
    } catch (reason) { setSavedError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); }
  }
  function savedButton(player: PlayerSearchResult | Player) {
    const isSaved = saved.some(item => item.player_id === player.player_id);
    return <button className="icon-button saved-player-toggle" type="button" aria-label={`${isSaved ? 'Remove saved player' : 'Save player'} ${player.name}`} title={isSaved ? 'Remove saved player' : 'Save player'} disabled={busy === player.player_id} onClick={() => void toggleSaved(player)}>{isSaved ? <BookmarkCheck size={17}/> : <Bookmark size={17}/>}</button>;
  }
  async function changeSavedLabel(playerId: number, value: string) {
    setBusy(playerId); setSavedError(null);
    try { const changed = await requestBackend<WatchlistRecord>(`/watchlist/${playerId}`, 'PATCH', { label: value || null }); setSaved(rows => rows.map(item => item.player_id === playerId ? { ...item, ...changed } : item)); }
    catch (reason) { setSavedError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(null); }
  }
  function playerRow(player: PlayerSearchResult | Player, savedLabel?: WatchlistLabel | null, index?: number) {
    const id = player.player_id;
    const recent = player.last_3_games?.map(game => game.fantasy_points).filter((value): value is number => typeof value === 'number') || (player.game_log || []).slice(-3).map(game => game.fantasy_points).filter((value): value is number => typeof value === 'number');
    const recentAverage = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null;
    const accent = String(player.nfl_team_color || '').replace(/^#/, '');
    const style = /^[\da-f]{6}$/i.test(accent) ? { '--player-search-accent': `#${accent}` } as React.CSSProperties : undefined;
    const isSaved = saved.some(item => item.player_id === id);
    const ownership = player.roster_status === 'rostered' ? `Rostered by ${player.fantasy_team_name || 'a league team'}${player.fantasy_team_owner ? ` · ${player.fantasy_team_owner}` : ''}` : player.roster_status === 'available' ? 'Available in ESPN free agents' : 'Ownership unavailable';
    return <article className="player-discovery-row editorial-player-row" style={style} key={id}>
      <div className="player-discovery-rank">{index == null ? '' : String(index + 1).padStart(2, '0')}</div>
      <PlayerAvatar player={player} size="lg"/>
      <div className="player-discovery-identity"><div className="player-discovery-name-line"><span className={`position pos-${player.position}`}>{player.position || '--'}</span><Link className="player-discovery-name" href={`/players/${id}`}>{player.name}</Link></div><span className="player-discovery-team">{player.nfl_team_logo_url && <img src={player.nfl_team_logo_url} alt=""/>}{player.nfl_team_full_name || player.nfl_team || 'Team unavailable'}{player.nfl_team && player.nfl_team_full_name ? ` · ${player.nfl_team}` : ''}{player.nfl_opponent ? ` · vs ${player.nfl_opponent}` : ''}</span><span className={`player-discovery-ownership roster-${player.roster_status || 'unknown'}`}>{ownership}</span></div>
      <div className="player-discovery-numbers"><span><small>Projection</small><b>{points(player.custom_projection?.our_projection)}</b></span><span><small>Season avg</small><b>{points(player.season_fantasy_average)}</b></span><span><small>Recent avg</small><b>{points(recentAverage)}</b></span></div>
      <div className="player-discovery-status"><PlayerStatusButton player={player as Player} compact/><span className={`player-live-state ${player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id) ? 'is-live' : ''}`}>{player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id) ? 'LIVE' : ''}{player.nfl_team_id != null && liveTeamIds?.includes(player.nfl_team_id) && player.fantasy_points != null ? ` · ${points(player.fantasy_points)} pts` : ''}</span></div>
      <div className="player-discovery-actions">{savedButton(player)}</div>
      <details className="player-discovery-details"><summary>View details</summary><div className="player-details-content"><div className="player-detail-numbers"><span>Our projection <b>{points(player.custom_projection?.our_projection)}</b></span><span>ESPN projection <b>{points(player.projected_fantasy_points)}</b></span><span>Floor <b>{points(player.custom_projection?.floor)}</b></span><span>Likely <b>{points(player.custom_projection?.median)}</b></span><span>Ceiling <b>{points(player.custom_projection?.ceiling)}</b></span><span>Data confidence <b>{player.custom_projection?.confidence?.toUpperCase() || 'Unavailable'}</b></span></div>{player.nfl_opponent && <p>Next matchup: {player.nfl_team || '--'} vs {player.nfl_opponent}{player.nfl_game_time ? ` · ${new Date(player.nfl_game_time).toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' })}` : ''}</p>}{recent?.length ? <p>Recent games: {recent.map(value => points(value)).join(' · ')}</p> : <p>Recent game data unavailable.</p>}{savedLabel !== undefined && <label className="saved-player-label">Saved player label <select aria-label={`Saved player label for ${player.name}`} value={savedLabel || ''} disabled={busy === id} onChange={event=>void changeSavedLabel(id,event.target.value)}><option value="">No label</option>{labels.map(label=><option key={label} value={label}>{label}</option>)}</select></label>}{player.custom_projection?.adjustments?.length ? <details className="player-method-details"><summary>How this was calculated</summary><ul>{player.custom_projection.adjustments.map((adjustment, adjustmentIndex) => <li key={`${adjustment.key}-${adjustmentIndex}`}>{adjustment.label}: {adjustment.evidence}</li>)}</ul></details> : null}</div></details>
    </article>;
  }
  const visiblePlayers = scope === 'saved' ? savedResults.slice(0,30) : players;
  return <div className="player-discovery-page editorial-player-directory">
    <section className="player-discovery-hero editorial-search-header"><div className="editorial-search-intro"><h1>Players</h1><p>Find someone in your league or across the NFL.</p></div>
      <form className="player-discovery-search" onSubmit={search}><Search size={20}/><input aria-label="Search players by name" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search players by name…" maxLength={80}/><button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button></form>
      <div className="player-discovery-filters"><div className="player-position-filter" role="group" aria-label="Filter by position"><span>POSITION</span><button type="button" aria-pressed={!position} onClick={()=>setPosition('')}>All</button>{positions.map(item=><button type="button" aria-pressed={position===item} key={item} onClick={()=>setPosition(position===item?'':item)}>{item}</button>)}</div><label className="player-compact-filter"><span>NFL TEAM</span><input aria-label="Filter by NFL team" value={team} onChange={event=>setTeam(event.target.value)} placeholder="Any team" maxLength={20}/></label><label className="player-compact-filter"><span>ROSTER STATUS</span><select aria-label="Filter by roster status" value={status} onChange={event=>setStatus(event.target.value)}><option value="">All players</option><option value="rostered">Rostered</option><option value="available">Available</option></select></label><label className="player-compact-filter player-sort-filter"><span>SORT BY</span><select aria-label="Sort players" value={sort} onChange={event=>setSort(event.target.value)}>{sorts.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
      <div className="player-discovery-segments" role="group" aria-label="Player list"><button type="button" aria-pressed={scope==='all'} onClick={()=>setScope('all')}>All players</button><button type="button" aria-pressed={scope==='saved'} onClick={()=>setScope('saved')}>Saved <span>{saved.length}</span></button></div>
    </section>
    {error && <div className="player-discovery-error" role="alert"><strong>Search couldn’t load</strong><span>{error}</span><button type="button" onClick={()=>setError(null)}>Dismiss</button></div>}{savedError && <div className="player-discovery-error" role="status"><strong>Saved players unavailable</strong><span>{savedError}</span></div>}
    <section className="player-discovery-results editorial-results" aria-live="polite"><div className="player-results-heading"><div><h2>{scope==='saved'?'Saved players':searched?'Search results':'Explore players'}</h2></div><div className="player-results-count">{scope==='saved'?`${savedResults.length} saved`:searched?`${players.length} players`:savedLoading?'Loading saved list':`${saved.length} saved`}</div></div>
      {loading ? <div className="player-discovery-loading" role="status">Searching ESPN player data…</div> : scope==='saved' && savedLoading ? <div className="player-discovery-loading" role="status">Loading your saved players…</div> : visiblePlayers.length ? <div className="player-discovery-list">{visiblePlayers.map((player,index)=>playerRow(player,scope==='saved'?saved.find(item=>item.player_id===player.player_id)?.label:undefined,index))}</div> : scope==='saved' && saved.length > 0 ? <div className="player-discovery-empty"><Bookmark size={20}/><strong>No saved players match these filters</strong><span>Your saved players are still here. Clear the current filters to see them.</span><button type="button" onClick={()=>{setQuery('');setTeam('');setPosition('');setStatus('');}}>Clear filters</button></div> : scope==='saved' ? <div className="player-discovery-empty"><Bookmark size={20}/><strong>No saved players yet</strong><span>Bookmark a player to keep them here for quick access.</span><button type="button" onClick={()=>setScope('all')}>Browse all players</button></div> : searched && !error ? <div className="player-discovery-empty"><Search size={20}/><strong>No players found</strong><span>Try another name or clear a filter.</span></div> : <div className="player-discovery-empty"><Search size={20}/><strong>Start with a player or a position</strong><span>Search for anyone in your league or on waivers. Use a position, team, or status filter to narrow the list.</span>{saved.length>0&&<button type="button" onClick={()=>setScope('saved')}>View {saved.length} saved players</button>}</div>}
      {scope==='saved'&&savedUpdatedAt&&<p className="player-saved-updated">Saved players updated {savedUpdatedAt.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}</p>}
    </section>
  </div>;
}
