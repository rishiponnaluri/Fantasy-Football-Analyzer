'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowRight, BarChart3, CalendarDays, Check, CircleHelp, Clock3, GitCompareArrows, LayoutDashboard, Menu, RefreshCw, Search, Shield, Sparkles, Trophy, Users, Zap } from 'lucide-react';
import { fetchBackend } from '@/lib/api';
import { FantasyMatchup, FantasyMatchups, FantasyPredictions, FantasyTeam, League, LeagueProjections, NFLLiveStatus, Snapshot, StartSitResponse, points } from '@/lib/types';
import { liveRefreshIntervalMs } from '@/lib/live-refresh.mjs';
import { RosterTable } from './roster-table';
import NFLSchedulePanel from './nfl-schedule-panel';
import StartSitPanel from './start-sit-panel';
import WaiverAssistantPanel from './waiver-assistant-panel';
import PredictionsPanel from './predictions-panel';
import PlayerSearchPanel from './player-search-panel';
import TradeAnalyzerPanel from './trade-analyzer-panel';
import AnalysisPanel from './analysis-panel';
import RosterLineupBoard from './roster-lineup-board';
import DashboardHome from './dashboard-home';
import { LeagueMatchupsPanel, MatchupDetailDialog } from './league-matchups-panel';

const primaryNavigation = [
  { name: 'Dashboard', icon: LayoutDashboard },
  { name: 'My Team', icon: Shield },
  { name: 'Players', icon: Search },
  { name: 'Waivers', icon: Zap },
  { name: 'Start/Sit', icon: GitCompareArrows },
  { name: 'Trades', icon: Users },
  { name: 'League Matchups', icon: Trophy },
];
const secondaryNavigation = [
  { name: 'Predictions', icon: Sparkles },
  { name: 'NFL Schedule', icon: CalendarDays },
];
const ALL_WAIVER_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'];
function useRemoteWeek(path: string | null, revision: number) {
  const [state, setState] = useState<{ path: string | null; data: FantasyMatchups | null; loading: boolean; error: string | null; updatedAt: Date | null }>({ path: null, data: null, loading: false, error: null, updatedAt: null });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ path, data: null, loading: true, error: null, updatedAt: null });
    fetchBackend<FantasyMatchups>(path, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ path, data, loading: false, error: null, updatedAt: new Date() });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ path, data: null, loading: false, error: error.message, updatedAt: null });
    });
    return () => controller.abort();
  }, [path, revision]);
  // Never render a previous week's data during the render before an effect runs.
  const requestedWeek = path ? Number(path.split('/').at(-1)) : null;
  if (path && (state.path !== path || (state.data && state.data.week !== requestedWeek))) return { ...state, data: null, error: null, updatedAt: null, loading: true };
  return state;
}
function useRemotePredictions(path: string | null, revision: number) {
  const [state, setState] = useState<{ path: string | null; data: FantasyPredictions | null; loading: boolean; error: string | null }>({ path: null, data: null, loading: false, error: null });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ path, data: null, loading: true, error: null });
    fetchBackend<FantasyPredictions>(path, controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ path, data, loading: false, error: null });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ path, data: null, loading: false, error: error.message });
    });
    return () => controller.abort();
  }, [path, revision]);
  const requestedWeek = path ? Number(new URLSearchParams(path.split('?')[1]).get('week')) : null;
  if (path && (state.path !== path || (state.data && state.data.week !== requestedWeek))) return { ...state, data: null, error: null, loading: true };
  return state;
}
function LoadingState() {
  return <div role="status" aria-label="Loading real ESPN league" className="skeleton-page"><div className="skeleton-scoreboard"><div><span className="skeleton h-4 w-20"/><span className="skeleton h-10 w-32"/><span className="skeleton h-4 w-24"/></div><b>VS</b><div><span className="skeleton h-4 w-20"/><span className="skeleton h-10 w-32"/><span className="skeleton h-4 w-24"/></div></div><div className="skeleton-player-rows">{[0,1,2,3,4].map(i=><div className="skeleton-player-row" key={i}><span className="skeleton h-10 w-10 rounded-full"/><span className="skeleton h-4 w-48 max-w-full"/><span className="skeleton h-4 w-12"/></div>)}</div><span className="loading-caption">Connecting to your real ESPN league…</span><span className="sr-only">Loading real ESPN league</span></div>;
}
function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return <div className="error-card" role="alert"><Activity size={28}/><h2>League data could not be loaded</h2><p>{error}</p><button className="button" onClick={retry}><RefreshCw size={15}/> Retry connection</button></div>;
}
function Stamp({ date }: { date: Date | null }) {
  return <span className="timestamp"><Clock3 size={13}/>{date ? `Updated ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Not updated yet'}</span>;
}
function RosterSection({ team, startersOnly = false, liveTeamIds = [], customProjections = {} }: { team: FantasyTeam; startersOnly?: boolean; liveTeamIds?: number[]; customProjections?: Record<number, number | null> }) {
  const roster = team.roster;
  if (startersOnly) { const ordered = roster === null ? null : [...roster.filter(p => p.is_starter)].sort((a, b) => { const order = ['QB','RB','WR','TE','FLEX','RB/WR','RB/WR/TE','WR/TE','K','D/ST','DST','DEF']; const rank = (p: { lineup_slot: string | null; position: string | null }) => { const slot = order.indexOf(String(p.lineup_slot || '').toUpperCase()); return slot < 0 ? order.indexOf(p.position || '') : slot; }; return rank(a) - rank(b); }); return <section className="panel"><div className="lineup-group-title"><div><h2>My starters</h2><p>Live points and this week’s projections</p></div><span className="count-badge">{roster ? roster.filter(p => p.is_starter).length : '--'} players</span></div><RosterTable players={ordered} liveTeamIds={liveTeamIds} customProjections={customProjections}/></section>; }
  if (roster === null) return <section className="panel"><div className="empty">Your roster is unavailable from ESPN for this week.</div></section>;
  const slotOrder = ['QB','RB','WR','TE','FLEX','RB/WR','RB/WR/TE','WR/TE','K','D/ST','DST','DEF'];
  const orderedStarters = roster.filter(p => p.is_starter).map((player, index) => ({ player, index })).sort((a, b) => {
    const rank = (p: { lineup_slot: string | null; position: string | null }) => { const raw = String(p.lineup_slot || '').toUpperCase(); const found = slotOrder.indexOf(raw); return found < 0 ? slotOrder.indexOf(p.position || '') : found; };
    return rank(a.player) - rank(b.player) || a.index - b.index;
  }).map(row => row.player);
  const groups = [
    { title: 'Starting lineup', description: 'QB · RB · RB · WR · WR · TE · FLEX · K · D/ST', players: orderedStarters },
    { title: 'Bench', description: 'Your available depth', players: roster.filter(p => p.lineup_status === 'bench') },
    { title: 'IR / Reserve', description: 'Players in reserve slots', players: roster.filter(p => p.lineup_status === 'reserve') },
    { title: 'Other roster spots', description: 'Additional ESPN roster slots', players: roster.filter(p => !p.is_starter && !['bench','reserve'].includes(p.lineup_status)) },
  ];
  return <div className="roster-groups">{groups.filter(g => g.players.length > 0 || ['Starting lineup','Bench'].includes(g.title)).map(group => <section className="lineup-group" key={group.title}><div className="lineup-group-title"><div><h2>{group.title}</h2><p>{group.description}</p></div><span className="count-badge">{group.players.length}</span></div><RosterTable players={group.players} liveTeamIds={liveTeamIds} customProjections={customProjections}/></section>)}</div>;
}
export default function FantasyApp() {
  const [tab, setTab] = useState('Dashboard');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [rosterModels, setRosterModels] = useState<LeagueProjections | null>(null);
  const [dashboardStartSit, setDashboardStartSit] = useState<StartSitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [predictionError, setPredictionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [details, setDetails] = useState<FantasyMatchup | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [waiverPositions, setWaiverPositions] = useState<string[]>(ALL_WAIVER_POSITIONS);
  const refresh = useCallback(() => { setDetails(null); setRevision(n => n + 1); }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Keep a successfully loaded league visible while a manual refresh runs.
    // Only the first load needs to replace the page with its skeleton.
    setLoading(!snapshot); setRefreshing(!!snapshot); setError(null);
    Promise.all([fetchBackend<League>('/league', controller.signal), fetchBackend<FantasyTeam>('/my-team', controller.signal), fetchBackend<FantasyMatchups>('/fantasy-matchups', controller.signal), fetchBackend<NFLLiveStatus>('/nfl/live-status', controller.signal).catch(reason => { if (!controller.signal.aborted) setRefreshError(`NFL live status unavailable: ${reason.message}`); return null; }), fetchBackend<FantasyPredictions>('/fantasy-predictions', controller.signal).then(data => { setPredictionError(null); return data; }).catch(reason => { if (!controller.signal.aborted) setPredictionError(`Prediction refresh failed: ${reason.message}`); return null; })])
      .then(([league, team, matchups, liveStatus, predictions]) => {
        if (controller.signal.aborted) return;
        if (matchups.my_team_id !== team.team_id || matchups.week !== league.current_week || team.week !== league.current_week) throw new Error('ESPN changed scoring weeks during the request. Refresh to load a consistent fantasy week.');
        setSnapshot({ league, team, matchups, predictions, liveTeamIds: liveStatus?.in_progress_team_ids ?? null, updatedAt: new Date() }); setRefreshError(null); setLoading(false); setRefreshing(false);
      }).catch(error => { if (!controller.signal.aborted) {
        if (snapshot) setRefreshError(`League refresh failed: ${error.message}`);
        else setError(error.message);
        setLoading(false); setRefreshing(false);
      } });
    return () => controller.abort();
  }, [revision]);
  const liveMode = !snapshot || snapshot.liveTeamIds == null ? 'unknown' : snapshot.liveTeamIds.length ? 'live' : 'idle';
  useEffect(() => {
    if (!snapshot || loading || error) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const [league, team, matchups, predictions] = await Promise.all([
          fetchBackend<League>('/league', controller.signal),
          fetchBackend<FantasyTeam>('/my-team', controller.signal),
          fetchBackend<FantasyMatchups>('/fantasy-matchups', controller.signal),
          fetchBackend<FantasyPredictions>('/fantasy-predictions', controller.signal).catch(cause => { if (!controller.signal.aborted) setPredictionError(`Prediction refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; }),
        ]);
        if (controller.signal.aborted) return;
        if (matchups.my_team_id !== team.team_id || matchups.week !== league.current_week || team.week !== league.current_week) throw new Error('ESPN changed scoring weeks during the refresh.');
        if (controller.signal.aborted) return;
        if (predictions) setPredictionError(null);
        setSnapshot(previous => previous ? { league, team, matchups, predictions: predictions ?? previous.predictions, liveTeamIds: previous.liveTeamIds, updatedAt: new Date() } : previous);
        setRefreshError(previous => previous?.startsWith('Background refresh failed:') || previous?.startsWith('League refresh failed:') ? null : previous);
        setDetails(previous => previous ? matchups.fantasy_matchups.find(item => item.fantasy_matchup_id === previous.fantasy_matchup_id) ?? previous : null);
      } catch (cause) {
        if (!controller.signal.aborted) setRefreshError(cause instanceof Error ? `Background refresh failed: ${cause.message}` : `Background refresh failed: ${String(cause)}`);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, liveRefreshIntervalMs(liveMode));
      }
    };
    timer = setTimeout(poll, liveRefreshIntervalMs(liveMode));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [snapshot !== null, loading, error, liveMode]);
  useEffect(() => {
    if (!snapshot || loading || error) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const pollStatus = async () => {
      try {
        const status = await fetchBackend<NFLLiveStatus>('/nfl/live-status', controller.signal);
        if (!controller.signal.aborted) {
          setSnapshot(previous => previous ? { ...previous, liveTeamIds: status.in_progress_team_ids } : previous);
          setRefreshError(previous => previous?.startsWith('NFL live status unavailable:') ? null : previous);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setRefreshError(`NFL live status unavailable: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(pollStatus, 60_000);
      }
    };
    timer = setTimeout(pollStatus, 60_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [snapshot !== null, loading, error]);
  const week = selectedWeek ?? snapshot?.league.current_week;
  const remotePath = ['League Matchups', 'Predictions'].includes(tab) && snapshot && week !== snapshot.league.current_week ? `/fantasy-matchups/${week}` : null;
  const remote = useRemoteWeek(remotePath, revision);
  const remotePredictionPath = snapshot && week !== snapshot.league.current_week && (tab === 'League Matchups' || tab === 'Predictions') ? `/fantasy-predictions?week=${week}` : null;
  const remotePrediction = useRemotePredictions(remotePredictionPath, revision);
  const displayedMatchups = remotePath ? remote.data : snapshot?.matchups;
  const predictionData = remotePredictionPath ? remotePrediction.data : snapshot?.predictions;
  const predictionsById = new Map((predictionData?.predictions ?? []).map(item => [item.fantasy_matchup_id, item]));
  const navigate = (name: string) => { setTab(name); setDetails(null); setMenuOpen(false); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const changeWeek = (value: number | null) => { setDetails(null); setSelectedWeek(value); };
  const weeks = snapshot?.league.fantasy_weeks || [];
  const weekIndex = weeks.indexOf(week ?? -1);
  const hasRootRefresh = ['Dashboard', 'My Team', 'League Matchups', 'Predictions'].includes(tab);
  const isWeekLoading = !!remotePath && (remote.loading || (!remote.data && !remote.error));
  const rosterProjectionById = Object.fromEntries((snapshot && rosterModels?.week === snapshot.league.current_week ? rosterModels.players : []).map(row => [row.player_id, row.projection.our_projection]));
  useEffect(() => {
    if (!snapshot || !['Dashboard', 'My Team'].includes(tab)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try { const result = await fetchBackend<LeagueProjections>(`/projections?week=${snapshot.league.current_week}`, controller.signal); if (!controller.signal.aborted) setRosterModels(result); }
      catch { /* preserve the last successful model; missing projections stay unavailable */ }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, liveRefreshIntervalMs(liveMode)); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [snapshot?.league.current_week, tab, liveMode]);
  useEffect(() => {
    if (!snapshot || tab !== 'Dashboard') return;
    const controller = new AbortController();
    fetchBackend<StartSitResponse>(`/start-sit?week=${snapshot.league.current_week}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDashboardStartSit(result); })
      .catch(() => { /* Start/Sit remains available on its own page if the summary cannot load. */ });
    return () => controller.abort();
  }, [snapshot?.league.current_week, tab, revision]);
  return <div className={`sports-app ${menuOpen ? 'more-menu-open' : ''}`}>
    <header className="sports-masthead">
      <a className="sports-wordmark" href="/" aria-label="Fantasy Football Analyzer home"><span className="sports-mark"><span/><span/><span/></span><span className="wordmark-copy"><strong>FANTASY</strong><small>FOOTBALL ANALYZER</small></span></a>
      <nav className="sports-primary-nav" aria-label="Fantasy navigation">{primaryNavigation.map(({ name, icon: Icon }) => <button key={name} aria-label={name} aria-current={tab === name ? 'page' : undefined} className={tab === name ? 'active' : ''} onClick={() => navigate(name)}><Icon size={15}/><span>{name === 'League Matchups' ? 'League' : name}</span></button>)}</nav>
      <div className="sports-context-tools"><span className="sports-league-mark"><Trophy size={14}/><b>{snapshot?.league.league_name || 'ESPN League'}</b></span><span className="sports-week-mark">WK <strong>{snapshot?.league.current_week ?? '--'}</strong></span>{liveMode === 'live' && <span className="sports-live"><i/>LIVE</span>}<button className="sports-tool-button" title="Open Analyzer" aria-label="Open Analyzer" onClick={() => window.dispatchEvent(new CustomEvent('analyzer:open'))}><BarChart3 size={16}/></button>{hasRootRefresh && <button className="sports-tool-button" title="Refresh league data" aria-label="Refresh league data" onClick={refresh} disabled={loading || refreshing || isWeekLoading || (!!remotePredictionPath && remotePrediction.loading)}><RefreshCw size={16} className={loading || refreshing ? 'spin' : ''}/></button>}</div>
    </header>
    <div className="sports-subnav"><span className="subnav-season">{snapshot ? `${snapshot.league.year} SEASON` : 'FANTASY FOOTBALL'}</span><nav aria-label="More sports views">{secondaryNavigation.map(({ name, icon: Icon }) => <button key={name} aria-current={tab === name ? 'page' : undefined} className={tab === name ? 'active' : ''} onClick={() => navigate(name)}><Icon size={14}/>{name}</button>)}</nav><div className="connection-status"><i/> ESPN CONNECTED <span><Stamp date={snapshot?.updatedAt ?? null}/></span></div></div>
    {menuOpen && <><button className="sports-more-backdrop" aria-label="Close more navigation" onClick={() => setMenuOpen(false)}/><nav className="sports-more-menu" aria-label="More fantasy destinations">{[...primaryNavigation.slice(3, 6), { name: 'League Matchups', icon: Trophy }, ...secondaryNavigation].map(({ name, icon: Icon }) => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => navigate(name)}><Icon size={17}/>{name}<ArrowRight size={14}/></button>)}</nav></>}
    <div className="sports-main-shell"><header className="legacy-topbar"><button className="mobile-menu-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20}/></button><div className="breadcrumb"><span>{tab}</span></div><div className="global-header-data"><span className="league-header"><Trophy size={14}/>{snapshot?.league.league_name || 'ESPN Fantasy League'}</span><span className="global-week">Week {snapshot?.league.current_week ?? '--'}</span>{liveMode === 'live' && <span className="live-indicator"><i/>LIVE</span>}<Stamp date={snapshot?.updatedAt ?? null}/><button className="icon-button insights-trigger" title="Open Analyzer" aria-label="Open Analyzer" onClick={() => window.dispatchEvent(new CustomEvent('analyzer:open'))}><BarChart3 size={15}/></button>{hasRootRefresh && <button className="icon-button global-refresh" title="Refresh league data" aria-label="Refresh league data" onClick={refresh} disabled={loading || refreshing || isWeekLoading || (!!remotePredictionPath && remotePrediction.loading)}><RefreshCw size={15} className={loading || refreshing ? 'spin' : ''}/></button>}</div></header>
    <main>{tab === 'Dashboard' ? null : ['League Matchups', 'Predictions'].includes(tab) ? null : <div className="page-heading"><div><span className="eyebrow">{tab === 'NFL Schedule' ? 'NFL · real games' : `Fantasy football · ${snapshot?.league.year ?? ''}`}</span><h1>{tab}</h1><p>{tab === 'My Team' ? 'Your roster, organized by starting slot.' : tab === 'Players' ? 'Search, compare, and save real NFL players.' : tab === 'Trades' ? 'Find a useful deal and see what it means for both teams.' : tab === 'Waivers' ? 'Free agents ranked for your team’s needs.' : tab === 'Start/Sit' ? 'Choose the strongest legal lineup for your league.' : tab === 'NFL Schedule' ? 'Real NFL games, separate from fantasy matchups.' : 'Simulated outcomes for every fantasy matchup.'}</p></div><button className="button research-ask-button" type="button" onClick={() => window.dispatchEvent(new CustomEvent('analyzer:open'))}><BarChart3 size={15}/> Insights</button></div>}
    {loading ? <LoadingState/> : error ? <ErrorState error={error} retry={refresh}/> : snapshot && <>
    {(refreshError || (['Dashboard', 'League Matchups'].includes(tab) && predictionError)) && <div className="refresh-warning" role="status"><CircleHelp size={14}/><span>{predictionError && ['Dashboard', 'League Matchups'].includes(tab) ? predictionError : refreshError} Showing the last successful ESPN data.</span></div>}
    {tab === 'Dashboard' && <DashboardHome snapshot={snapshot} startSit={dashboardStartSit?.week === snapshot.league.current_week ? dashboardStartSit : null} onNavigate={navigate} onDetails={setDetails}/>}
    {tab === 'My Team' && <RosterLineupBoard team={snapshot.team} week={snapshot.league.current_week} liveTeamIds={snapshot.liveTeamIds} customProjections={rosterProjectionById}/>}
    {tab === 'Players' && <PlayerSearchPanel liveTeamIds={snapshot.liveTeamIds}/>}
    {tab === 'Trades' && <TradeAnalyzerPanel data={snapshot.matchups} myTeamId={snapshot.team.team_id} week={snapshot.league.current_week}/>}
    
    {tab === 'NFL Schedule' && <NFLSchedulePanel/>}
    {tab === 'Start/Sit' && <StartSitPanel league={snapshot.league} liveTeamIds={snapshot.liveTeamIds}/>}
    {tab === 'Waivers' && <WaiverAssistantPanel league={snapshot.league} liveTeamIds={snapshot.liveTeamIds} selectedPositions={waiverPositions} onPositionsChange={setWaiverPositions}/>}
    {tab === 'Predictions' && <PredictionsPanel league={snapshot.league} week={week ?? snapshot.league.current_week} matchups={displayedMatchups ?? null} predictions={predictionData ?? null} liveTeamIds={snapshot.liveTeamIds} loading={isWeekLoading || (!!remotePredictionPath && (remotePrediction.loading || (!remotePrediction.data && !remotePrediction.error)))} error={(remotePath ? remote.error : null) || remotePrediction.error || (week === snapshot.league.current_week ? predictionError : null)} onWeekChange={changeWeek} onRetry={refresh}/>}
    {tab === 'League Matchups' && (isWeekLoading ? <LoadingState/> : remotePath && remote.error ? <ErrorState error={remote.error} retry={refresh}/> : displayedMatchups && <LeagueMatchupsPanel matchups={displayedMatchups} predictions={predictionData} myTeamId={snapshot.team.team_id} week={week ?? snapshot.league.current_week} currentWeek={snapshot.league.current_week} liveTeamIds={snapshot.liveTeamIds} weeks={weeks} onWeekChange={changeWeek} onDetails={setDetails}/>)}
    <footer className="page-footer"><span>{remotePath && remote.error ? <><CircleHelp size={13}/> Selected fantasy week unavailable</> : <><Check size={13}/> ESPN league connected</>}</span><span>-- = Unavailable <span className="meta-dot">·</span> No estimated replacements</span></footer>
    </>}
    </main></div><nav className="sports-mobile-nav" aria-label="Quick navigation">{[{name:'Dashboard',label:'Home',icon:LayoutDashboard},{name:'My Team',label:'Team',icon:Shield},{name:'Players',label:'Players',icon:Search},{name:'Waivers',label:'Moves',icon:Zap}].map(({name,label,icon:Icon})=><button type="button" key={name} className={tab===name?'active':''} aria-current={tab===name?'page':undefined} onClick={() => navigate(name)}><Icon size={19}/><span>{label}</span></button>)}<button type="button" className={menuOpen?'active':''} aria-expanded={menuOpen} onClick={()=>setMenuOpen(value=>!value)}><Menu size={19}/><span>More</span></button></nav>{details && snapshot && <MatchupDetailDialog matchup={details} prediction={predictionsById.get(details.fantasy_matchup_id)} close={() => setDetails(null)} week={week ?? snapshot.league.current_week} currentWeek={snapshot.league.current_week} liveTeamIds={snapshot.liveTeamIds}/>}
    <AnalysisPanel page={tab} week={week ?? snapshot?.league.current_week ?? null} positions={waiverPositions}/>
  </div>;
}
