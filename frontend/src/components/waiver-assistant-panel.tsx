'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, Bookmark, BookmarkCheck, ChevronDown, Clock3, RefreshCw } from 'lucide-react';
import { fetchBackend, requestBackend } from '@/lib/api';
import { League, WaiverPlayer, WaiverResponse, points } from '@/lib/types';
import { liveRefreshIntervalMs } from '@/lib/live-refresh.mjs';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'] as const;
type BrowseMode = 'overall' | 'upside' | 'streaming';

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function simpleNeed(label: string) {
  const normalized = label.toLowerCase();
  if (normalized.includes('depth')) return 'Needs depth';
  if (normalized.includes('weak')) return 'Needs help';
  if (normalized.includes('strong')) return 'Strong';
  return 'Solid';
}
function positionNeedReason(player: WaiverPlayer) {
  if (player.needs_match) return `Adds useful depth at ${player.position || 'this position'}.`;
  const improvement = player.weekly_lineup_improvement;
  if (typeof improvement === 'number' && improvement > 0) return `Could add about ${improvement.toFixed(1)} points to your best lineup this week.`;
  return 'A highly ranked available player, but not a clear roster upgrade right now.';
}
function matchupText(player: WaiverPlayer) {
  if (player.nfl_opponent) return `vs ${player.nfl_opponent}`;
  if (player.bye_week === player.week) return 'Bye week';
  return 'Opponent unavailable';
}
function recentAverage(player: WaiverPlayer) {
  const value = player.score_components.last_3_average ?? player.score_components.last_5_average;
  return typeof value === 'number' ? value : null;
}
function statusIsHealthy(player: WaiverPlayer) {
  return ['ACTIVE', 'NORMAL', 'HEALTHY'].includes(String(player.injury_status || '').toUpperCase());
}
function WaiverPlayerStatus({ player }: { player: WaiverPlayer }) {
  if (statusIsHealthy(player)) return <span className="waiver-healthy-status">Available</span>;
  if (player.injury_status) return <PlayerStatusButton player={player}/>;
  return <span className="waiver-unknown-status">Status unavailable</span>;
}

function RosterNeedStrip({ needs }: { needs: WaiverResponse['roster_needs'] }) {
  return <section className="waiver-market-needs" aria-labelledby="waiver-needs-title">
    <div className="waiver-market-section-head"><div><span className="waiver-market-kicker">YOUR ROSTER</span><h2 id="waiver-needs-title">Team needs</h2></div><details className="waiver-how"><summary>How needs are set <ChevronDown size={13}/></summary><p>We compare your starters and usable bench players with other teams in your league.</p></details></div>
    <div className="waiver-need-strip">{Object.entries(needs).map(([position, need]) => <div className={`waiver-need ${need.label.toLowerCase().replaceAll(' ', '-')}`} key={position}><span>{position}</span><strong>{simpleNeed(need.label)}</strong></div>)}</div>
  </section>;
}

function PositionFilter({ selected, onChange }: { selected: string[]; onChange: (positions: string[]) => void }) {
  return <section className="waiver-market-filter" aria-label="Positions to search">
    <div className="waiver-market-section-head"><div><span className="waiver-market-kicker">POSITIONS TO SEARCH</span><h2>What are you looking for?</h2></div><div className="waiver-filter-actions"><button type="button" onClick={() => onChange([...POSITIONS])}>Select all</button><button type="button" onClick={() => onChange([])}>Clear all</button></div></div>
    <div className="waiver-market-position-chips">{POSITIONS.map(position => <button key={position} type="button" aria-pressed={selected.includes(position)} className={selected.includes(position) ? 'selected' : ''} onClick={() => onChange(selected.includes(position) ? selected.filter(item => item !== position) : [...selected, position])}><i>{selected.includes(position) ? '✓' : ''}</i>{position}</button>)}</div>
    <p className="waiver-filter-selection" aria-live="polite">{selected.length === POSITIONS.length ? 'All positions' : selected.length ? `Looking at ${selected.join(' + ')}` : 'Choose at least one position to search.'}</p>
  </section>;
}

function SavePlayerButton({ player, saved, onToggle }: { player: WaiverPlayer; saved: boolean; onToggle: (player: WaiverPlayer) => void }) {
  return <button className={`waiver-save-player ${saved ? 'is-saved' : ''}`} type="button" aria-label={`${saved ? 'Remove' : 'Save'} ${player.name} ${saved ? 'from' : 'to'} saved players`} title={saved ? 'Saved player' : 'Save player'} onClick={() => onToggle(player)}>{saved ? <BookmarkCheck size={16}/> : <Bookmark size={16}/>}</button>;
}

function WaiverMove({ move }: { move: NonNullable<WaiverResponse['personalized_move']> }) {
  const improvement = move.weekly_lineup_change ?? move.expected_score_advantage;
  const reason = positionNeedReason(move.add);
  return <article className="waiver-move-sheet">
    <div className="waiver-move-heading"><span className="waiver-market-kicker">BEST MOVE FOR YOU</span><span className="waiver-move-rank">01</span></div>
    <div className="waiver-move-exchange">
      <div className="waiver-move-side add-side"><span className="waiver-move-label">YOU ADD</span><div className="waiver-move-player"><PlayerAvatar player={move.add} size="lg"/><div><Link href={`/players/${move.add.player_id}`}>{move.add.name}</Link><span>{move.add.position || '--'} · {move.add.nfl_team || 'Team unavailable'}{move.add.nfl_opponent ? ` · vs ${move.add.nfl_opponent}` : ''}</span><PlayerStatusButton player={move.add}/></div></div></div>
      <span className="waiver-move-arrow" aria-hidden="true"><ArrowDown size={18}/></span>
      <div className="waiver-move-side drop-side"><span className="waiver-move-label">YOU DROP</span><div className="waiver-move-player"><PlayerAvatar player={move.drop} size="lg"/><div><Link href={`/players/${move.drop.player_id}`}>{move.drop.name}</Link><span>{move.drop.position || '--'} · {move.drop.nfl_team || 'Team unavailable'}</span><PlayerStatusButton player={move.drop}/></div></div></div>
    </div>
    <div className="waiver-move-why"><div><span className="waiver-market-kicker">WHY THIS HELPS</span><p>{reason}</p></div><div className="waiver-move-impact"><span>Best lineup this week</span><strong>{improvement > 0 ? `+${points(improvement)}` : points(improvement)} <small>pts</small></strong></div><details className="waiver-how waiver-move-details"><summary>More details <ChevronDown size={13}/></summary><p>{move.reason}</p><p>Long-term outlook: {move.rest_of_season_change == null ? 'Unavailable' : move.rest_of_season_change > 0 ? `about ${points(move.rest_of_season_change)} points better` : move.rest_of_season_change < 0 ? `about ${points(Math.abs(move.rest_of_season_change))} points lower` : 'about the same'}.</p></details></div>
  </article>;
}

function WaiverPlayerRow({ player, rank, saved, onToggleSaved }: { player: WaiverPlayer; rank: number; saved: boolean; onToggleSaved: (player: WaiverPlayer) => void }) {
  const accent = player.nfl_team_color && /^[\da-f]{6}$/i.test(player.nfl_team_color) ? `#${player.nfl_team_color}` : '#777b6c';
  const recent = recentAverage(player);
  return <article className="waiver-market-row" data-testid="waiver-player-card" style={{ '--waiver-player-accent': accent } as React.CSSProperties}>
    <span className="waiver-market-rank">{String(rank).padStart(2, '0')}</span>
    <PlayerAvatar player={player} size="lg"/>
    <div className="waiver-market-player">
      <div className="waiver-market-name-line"><Link href={`/players/${player.player_id}`}>{player.name}</Link><span className={`waiver-position-tag pos-${(player.position || '').replace('/', '')}`}>{player.position || '--'}</span></div>
      <div className="waiver-market-teamline">{player.nfl_team || 'Team unavailable'} <span>·</span> {matchupText(player)} <PlayerStatusButton player={player}/></div>
      <details className="waiver-player-details"><summary>View details <ChevronDown size={13}/></summary><div className="waiver-detail-grid"><span>Our projection <b>{points(player.recommendation_projection ?? player.custom_projection?.our_projection)}</b></span><span>ESPN <b>{points(player.custom_projection?.espn_projection ?? player.projected_fantasy_points)}</b></span><span>Floor <b>{points(player.custom_projection?.floor)}</b></span><span>Likely <b>{points(player.custom_projection?.median)}</b></span><span>Ceiling <b>{points(player.custom_projection?.ceiling)}</b></span><span>How reliable <b>{player.recommendation_confidence || player.confidence}</b></span>{player.recent_usage && Object.entries(player.recent_usage).slice(0, 3).map(([key, value]) => <span key={key}>{key.replaceAll('_', ' ')} <b>{value}</b></span>)}{player.recommendation_reason && <p>{player.recommendation_reason}</p>}</div></details>
      <div className="waiver-market-mobile-values"><span>Proj <b>{points(player.recommendation_projection ?? player.recommendation_score)}</b></span><span>Recent <b>{points(recent)}</b></span></div>
    </div>
    <div className="waiver-market-stat"><span>PROJECTION</span><strong>{points(player.recommendation_projection ?? player.recommendation_score)}</strong></div>
    <div className="waiver-market-stat"><span>SEASON AVG.</span><strong>{points(player.season_fantasy_average)}</strong></div>
    <div className="waiver-market-stat"><span>RECENT AVG.</span><strong>{points(recent)}</strong></div>
    <div className="waiver-market-status"><WaiverPlayerStatus player={player}/></div>
    <SavePlayerButton player={player} saved={saved} onToggle={onToggleSaved}/>
  </article>;
}

export default function WaiverAssistantPanel({ league, liveTeamIds, selectedPositions, onPositionsChange }: { league: League; liveTeamIds: number[] | null; selectedPositions: string[]; onPositionsChange: (positions: string[]) => void }) {
  const [week, setWeek] = useState(league.current_week);
  const [data, setData] = useState<WaiverResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [browseMode, setBrowseMode] = useState<BrowseMode>('overall');
  const [savedIds, setSavedIds] = useState<Set<number>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const liveMode = liveTeamIds === null ? 'unknown' : liveTeamIds.length ? 'live' : 'idle';
  const positionKey = selectedPositions.join(',');
  const dataMatchesPositions = !!data && (data.selected_positions || []).length === selectedPositions.length && selectedPositions.every(position => (data.selected_positions || []).includes(position));
  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ week: String(week) });
    selectedPositions.forEach(position => query.append('positions', position));
    const result = await fetchBackend<WaiverResponse>(`/waiver-advice?${query.toString()}`, signal);
    if (!signal?.aborted) { setData(result); setError(null); setRefreshError(null); }
  }, [week, positionKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetchBackend<{ items: { player_id: number }[] }>('/watchlist', controller.signal).then(result => { if (!controller.signal.aborted) setSavedIds(new Set(result.items.map(item => item.player_id))); }).catch(() => {});
    const onSavedChange = (event: Event) => {
      const detail = (event as CustomEvent<{ playerId: number; saved: boolean }>).detail;
      if (!detail) return;
      setSavedIds(current => { const next = new Set(current); detail.saved ? next.add(detail.playerId) : next.delete(detail.playerId); return next; });
    };
    window.addEventListener('watchlist:changed', onSavedChange);
    return () => { controller.abort(); window.removeEventListener('watchlist:changed', onSavedChange); };
  }, []);

  useEffect(() => {
    if (!selectedPositions.length) { setLoading(false); setError(null); setRefreshError(null); return; }
    const controller = new AbortController();
    setLoading(!data || data.week !== week || !dataMatchesPositions);
    if (!data || data.week !== week || !dataMatchesPositions) setError(null);
    load(controller.signal).catch(reason => {
      if (controller.signal.aborted) return;
      if (data?.week === week && dataMatchesPositions) setRefreshError(errorText(reason)); else setError(errorText(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, revision]);

  useEffect(() => {
    if (!data || data.week !== week || !selectedPositions.length) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try { await load(controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setRefreshError(errorText(reason)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, liveRefreshIntervalMs(liveMode)); }
    };
    timer = setTimeout(poll, liveRefreshIntervalMs(liveMode));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [data?.week, week, load, liveMode, selectedPositions.length]);

  async function refresh() {
    if (!selectedPositions.length) return;
    setRefreshing(true);
    try { await load(); } catch (reason) { if (data?.week === week && dataMatchesPositions) setRefreshError(errorText(reason)); else setError(errorText(reason)); }
    finally { setRefreshing(false); }
  }
  async function toggleSaved(player: WaiverPlayer) {
    const saved = savedIds.has(player.player_id);
    setSaveError(null);
    try {
      if (saved) await requestBackend(`/watchlist/${player.player_id}`, 'DELETE');
      else await requestBackend('/watchlist', 'POST', { player_id: player.player_id, label: null });
      setSavedIds(current => { const next = new Set(current); saved ? next.delete(player.player_id) : next.add(player.player_id); return next; });
      window.dispatchEvent(new CustomEvent('watchlist:changed', { detail: { playerId: player.player_id, saved: !saved } }));
    } catch (reason) { setSaveError(errorText(reason)); }
  }

  const move = data?.personalized_move && selectedPositions.includes(data.personalized_move.add.position || '') ? data.personalized_move : null;
  const filtered = (players: WaiverPlayer[]) => players.filter(player => selectedPositions.includes(player.position || ''));
  const overall = filtered(data?.best_overall_adds || []);
  const upside = filtered(data?.upside_stashes || []);
  const streaming = filtered(data?.streaming_options || []);
  const modes = useMemo(() => ([
    { key: 'overall' as const, label: 'Best overall', players: overall },
    ...(upside.length ? [{ key: 'upside' as const, label: 'More upside', players: upside }] : []),
    ...(streaming.length ? [{ key: 'streaming' as const, label: 'This week', players: streaming }] : []),
  ]), [overall, upside, streaming]);
  useEffect(() => { if (!modes.some(mode => mode.key === browseMode)) setBrowseMode('overall'); }, [modes, browseMode]);
  const activeMode = modes.find(mode => mode.key === browseMode) || modes[0];

  return <div className="waiver-market-page">
    <header className="waiver-market-top">
      <div><span className="waiver-market-kicker">WEEK {week} · FREE AGENTS</span><h1>Waiver board</h1><p>Find a player who makes your roster better.</p></div>
      <div className="waiver-market-tools"><span className="waiver-market-updated"><Clock3 size={13}/>{data ? `Updated ${new Date(data.last_updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not updated yet'}</span><select aria-label="Fantasy week" value={week} onChange={event => setWeek(Number(event.target.value))}>{league.fantasy_weeks.map(item => <option key={item} value={item}>Week {item}{item === league.current_week ? ' · Current' : ''}</option>)}</select><button className="waiver-refresh" type="button" onClick={refresh} disabled={refreshing || !selectedPositions.length} aria-label="Refresh waiver data"><RefreshCw size={15} className={refreshing ? 'spin' : ''}/><span>Refresh</span></button></div>
    </header>

    {refreshError && <div className="waiver-market-warning" role="status">Refresh failed. Showing the last successful results. {refreshError}</div>}
    {data && <RosterNeedStrip needs={data.roster_needs || {}}/>}
    <PositionFilter selected={selectedPositions} onChange={onPositionsChange}/>

    {!selectedPositions.length ? <div className="waiver-market-empty" role="status"><strong>Choose at least one position to search.</strong><p>Turn on a position above to see available players and roster-fit recommendations.</p></div> : loading && (!data || data.week !== week || !dataMatchesPositions) ? <div className="waiver-market-loading" role="status"><span>Checking available players for your team…</span>{[0,1,2,3].map(index => <div key={index}/>)}</div> : error && (!data || data.week !== week || !dataMatchesPositions) ? <div className="waiver-market-error" role="alert"><AlertTriangle size={20}/><div><strong>Waiver data unavailable</strong><p>{error}</p></div><button className="waiver-refresh" onClick={() => setRevision(value => value + 1)}>Retry</button></div> : data && data.week === week && dataMatchesPositions && <>
      <section className="waiver-moves-section" aria-labelledby="waiver-moves-title">
        <div className="waiver-market-section-head"><div><span className="waiver-market-kicker">PERSONALIZED FOR YOUR ROSTER</span><h2 id="waiver-moves-title">Best moves for you</h2></div><span className="waiver-market-caption">{data.eligible_free_agent_count} ESPN free agents match</span></div>
        {move ? <WaiverMove move={move}/> : <div className="waiver-no-move"><span className="waiver-no-move-mark">—</span><div><span className="waiver-market-kicker">NO MOVE NEEDED RIGHT NOW</span><p>None of the available players clearly improve your roster right now.</p><small>You can still browse available players below.</small><details className="waiver-how"><summary>How this was calculated <ChevronDown size={13}/></summary><p>{data.move_note || 'Available players were compared with your starters, bench, selected positions, and rest-of-season outlook.'}</p></details></div></div>}
      </section>

      <section className="waiver-marketplace" aria-labelledby="available-players-title">
        <div className="waiver-marketplace-heading"><div><span className="waiver-market-kicker">REAL ESPN FREE-AGENT POOL</span><h2 id="available-players-title">Available players</h2><p>Sorted by fit and projected value for your team.</p></div><div className="waiver-market-count"><strong>{data.eligible_free_agent_count}</strong><span>matching players</span></div></div>
        {modes.length > 1 && <div className="waiver-market-tabs" role="tablist" aria-label="Available player groups">{modes.map(mode => <button key={mode.key} role="tab" aria-selected={browseMode === mode.key} className={browseMode === mode.key ? 'active' : ''} onClick={() => setBrowseMode(mode.key)}>{mode.label}<span>{mode.players.length}</span></button>)}</div>}
        {browseMode === 'upside' && <p className="waiver-mode-help">Players who could become more useful if their role grows.</p>}
        {browseMode === 'streaming' && <p className="waiver-mode-help">Short-term options with a favorable matchup this week.</p>}
        {saveError && <p className="waiver-market-save-error" role="alert">Could not update saved players: {saveError}</p>}
        {activeMode?.players.length ? <div className="waiver-market-list" role="list" aria-label={activeMode.label}>{activeMode.players.map((player, index) => <WaiverPlayerRow key={player.player_id} player={player} rank={index + 1} saved={savedIds.has(player.player_id)} onToggleSaved={toggleSaved}/>)}</div> : <div className="waiver-market-empty waiver-market-list-empty">No players in this group match the positions you selected.</div>}
      </section>
      <details className="waiver-methodology"><summary>How recommendations are chosen <ChevronDown size={14}/></summary><p>{data.ranking_model} This is advice only; the app does not make roster moves.</p></details>
    </>}
  </div>;
}
