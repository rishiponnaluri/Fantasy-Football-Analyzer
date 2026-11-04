'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, BarChart3, CalendarDays, Check, CircleHelp, Clock3, GitCompareArrows, LayoutDashboard, Menu, RefreshCw, Search, Shield, Sparkles, Trophy, Users, Zap } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { canonicalProjection, PROJECTION_CHANGED, refreshProjectionSnapshot, fetchBackend } from '@/lib/api';
import { FantasyMatchup, FantasyMatchups, FantasyPredictions, FantasyTeam, League, LeagueProjections, NFLLiveStatus, Snapshot, StartSitResponse, points } from '@/lib/types';
import { liveInputSignature } from '@/lib/adaptive-polling.mjs';
import { useAdaptivePoll } from '@/lib/use-adaptive-poll';
import NFLSchedulePanel from './nfl-schedule-panel';
import StartSitPanel from './start-sit-panel';
import WaiverAssistantPanel from './waiver-assistant-panel';
import PredictionsPanel from './predictions-panel';
import PlayerSearchPanel from './player-search-panel';
import TradeAnalyzerPanel from './trade-analyzer-panel';
import AnalysisPanel from './analysis-panel';
import RosterLineupBoard from './roster-lineup-board';
import DashboardHome from './dashboard-home';
import { ScoreSkeleton } from './score-space-ui';
import { LeagueMatchupsPanel, MatchupDetailDialog } from './league-matchups-panel';
import { motionAllowed } from '@/lib/motion';

gsap.registerPlugin(useGSAP);

const primaryNavigation = [
  { name: 'Dashboard', icon: LayoutDashboard },
  { name: 'My Team', icon: Shield },
  { name: 'Players', icon: Search },
  { name: 'Waivers', icon: Zap },
  { name: 'Start/Sit', icon: GitCompareArrows },
  { name: 'Trades', icon: Users },
  { name: 'League Matchups', icon: Trophy },
  { name: 'Predictions', icon: Sparkles },
  { name: 'NFL Schedule', icon: CalendarDays },
];
const mobileMoreNavigation = primaryNavigation.filter(({ name }) => ['Start/Sit', 'Trades', 'League Matchups', 'Predictions', 'NFL Schedule'].includes(name));
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
  return <div role="status" aria-label="Loading real ESPN league" className="v9-loading-home"><div className="skeleton v9-loading-title"/><div className="v9-loading-matchup">{[0,1].map(i=><div key={i}><span className="skeleton"/><strong className="skeleton"/><i className="skeleton"/></div>)}<div className="skeleton v9-loading-probability"/></div><div className="v9-loading-starters">{Array.from({length:9},(_,i)=><div key={i}><span className="skeleton"/><div><i className="skeleton"/><b className="skeleton"/></div><strong className="skeleton"/></div>)}</div><span className="loading-caption">Connecting to your league…</span></div>;
}
function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return <div className="error-card" role="alert"><Activity size={28}/><h2>League data could not be loaded</h2><p>Your league could not be loaded right now. Check the connection and try again.</p><button className="button" onClick={retry}><RefreshCw size={15}/> Retry connection</button></div>;
}
function Stamp({ date }: { date: Date | null }) {
  return <span className="timestamp"><Clock3 size={13}/>{date ? `Updated ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Not updated yet'}</span>;
}
export default function FantasyApp() {
  const [tab, setTab] = useState('Dashboard');
  const navRef = useRef<HTMLElement>(null);
  const navIndicatorRef = useRef<HTMLElement>(null);
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
  useGSAP(() => {
    const nav = navRef.current;
    const indicator = navIndicatorRef.current;
    if (!nav || !indicator) return;
    const position = () => {
      const active = nav.querySelector<HTMLElement>('.sports-nav-destination.active');
      if (!active) return;
      const navBounds = nav.getBoundingClientRect();
      const activeBounds = active.getBoundingClientRect();
      const x = activeBounds.left - navBounds.left + (activeBounds.width - 22) / 2;
      if (!motionAllowed()) { gsap.set(indicator, { x, autoAlpha: 1 }); return; }
      gsap.to(indicator, { x, autoAlpha: 1, duration: 0.18, ease: 'power2.out', overwrite: true });
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(nav);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, { dependencies: [tab] });
  useEffect(() => {
    const changed = () => { setRosterModels(null); setDashboardStartSit(null); setRevision(n => n + 1); };
    window.addEventListener(PROJECTION_CHANGED, changed);
    return () => window.removeEventListener(PROJECTION_CHANGED, changed);
  }, []);
  const refresh = useCallback(() => {
    setDetails(null); setRefreshing(true);
    refreshProjectionSnapshot().catch(cause => { setRefreshError(cause.message); setRefreshing(false); });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Keep a successfully loaded league visible while a manual refresh runs.
    // Only the first load needs to replace the page with its skeleton.
    setLoading(!snapshot); setRefreshing(!!snapshot); setError(null);
    Promise.all([fetchBackend<League>('/league', controller.signal), fetchBackend<FantasyTeam>('/my-team', controller.signal), fetchBackend<FantasyMatchups>('/fantasy-matchups', controller.signal), fetchBackend<NFLLiveStatus>('/nfl/live-status', controller.signal).catch(reason => { if (!controller.signal.aborted) setRefreshError(`NFL live status unavailable: ${reason.message}`); return null; }), fetchBackend<FantasyPredictions>('/fantasy-predictions', controller.signal).then(data => { setPredictionError(null); return data; }).catch(reason => { if (!controller.signal.aborted) setPredictionError(`Prediction refresh failed: ${reason.message}`); return null; })])
      .then(([league, team, matchups, liveStatus, predictions]) => {
        if (controller.signal.aborted) return;
        if (matchups.my_team_id !== team.team_id || matchups.week !== league.current_week || team.week !== league.current_week) throw new Error('ESPN changed scoring weeks during the request. Refresh to load a consistent fantasy week.');
        setSnapshot({ league, team, matchups, predictions, liveTeamIds: liveStatus && liveStatus.current_week != null && liveStatus.current_week !== league.current_week ? [] : liveStatus?.in_progress_team_ids ?? null, updatedAt: new Date() }); setRefreshError(null); setLoading(false); setRefreshing(false);
      }).catch(error => { if (!controller.signal.aborted) {
        if (snapshot) setRefreshError(`League refresh failed: ${error.message}`);
        else setError(error.message);
        setLoading(false); setRefreshing(false);
      } });
    return () => controller.abort();
  }, [revision]);
  const liveMode = !snapshot || snapshot.liveTeamIds == null ? 'unknown' : snapshot.liveTeamIds.length ? 'live' : 'idle';
  const pollWeek = ['League Matchups','Predictions'].includes(tab) ? selectedWeek ?? snapshot?.league.current_week : snapshot?.league.current_week;
  const liveRelevant = ['Dashboard','My Team','League Matchups','Predictions'].includes(tab);
  const upcoming = snapshot?.matchups.fantasy_matchups.some(row => [row.home_team,row.away_team].some(team => team?.roster?.some(player => player.nfl_game_time && new Date(player.nfl_game_time).getTime()>Date.now()))) ?? false;
  useAdaptivePoll({enabled:!!snapshot&&!loading&&!error&&liveRelevant,week:pollWeek,currentWeek:snapshot?.league.current_week,live:liveMode==='live',upcoming,
    load:async(signal)=>{
      if(!snapshot)return;
      const current=snapshot.league.current_week;
      // Current-week endpoints use their existing snapshot/cache paths. No force-refresh.
      const [team,matchups,status]=await Promise.all([
        fetchBackend<FantasyTeam>(`/my-team?week=${current}`,signal),
        fetchBackend<FantasyMatchups>(`/fantasy-matchups?week=${current}`,signal),
        fetchBackend<NFLLiveStatus>('/nfl/live-status',signal).catch(()=>null),
      ]);
      if(signal.aborted)return;
      const liveIds=status && status.current_week != null && status.current_week !== current ? [] : status?.in_progress_team_ids??snapshot.liveTeamIds;
      const changed=liveInputSignature(matchups,liveIds)!==liveInputSignature(snapshot.matchups,snapshot.liveTeamIds);
      let predictionFailed=false;
      const predictions=changed||!snapshot.predictions||!!predictionError ? await fetchBackend<FantasyPredictions>(`/fantasy-predictions?week=${current}`,signal).catch(()=>{predictionFailed=true;if(!signal.aborted)setPredictionError('Prediction refresh unavailable.');return snapshot.predictions;}) : snapshot.predictions;
      if(signal.aborted)return;
      if(matchups.my_team_id!==team.team_id||team.week!==current||matchups.week!==current||(predictions&&predictions.week!==current))throw new Error('Week changed during refresh.');
      setSnapshot(previous=>previous?{...previous,team,matchups,predictions,liveTeamIds:liveIds,updatedAt:new Date()}:previous);
      setDetails(previous=>previous?matchups.fantasy_matchups.find(row=>row.fantasy_matchup_id===previous.fantasy_matchup_id)??previous:null);
      setRefreshError(null);if(!predictionFailed)setPredictionError(null);
      if(predictionFailed)throw new Error('Prediction refresh unavailable.');
    },onError:()=>setRefreshError('Background refresh failed. Showing the last successful league data.')});
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
  const rosterProjectionById = Object.fromEntries((snapshot && rosterModels?.week === snapshot.league.current_week ? rosterModels.players : []).map(row => [row.player_id, canonicalProjection(row.player)]));
  useEffect(() => {
    if (!snapshot || !['Dashboard', 'My Team'].includes(tab)) return;
    const controller = new AbortController();
    const load = async () => {
      try { const result = await fetchBackend<LeagueProjections>(`/projections?week=${snapshot.league.current_week}`, controller.signal); if (!controller.signal.aborted) setRosterModels(result); }
      catch { /* preserve the last successful model; missing projections stay unavailable */ }

    };
    void load();
    return () => controller.abort();
  }, [snapshot?.league.current_week, tab, revision]);
  useEffect(() => {
    if (!snapshot || tab !== 'Dashboard') return;
    const controller = new AbortController();
    fetchBackend<StartSitResponse>(`/start-sit?week=${snapshot.league.current_week}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) setDashboardStartSit(result); })
      .catch(() => { /* Start/Sit remains available on its own page if the summary cannot load. */ });
    return () => controller.abort();
  }, [snapshot?.league.current_week, tab, revision]);
  return <div className={`sports-app editorial-app ${menuOpen ? 'more-menu-open' : ''}`}>
    <header className="sports-masthead editorial-masthead">
      <a className="sports-wordmark" href="/" aria-label="Fantasy Football Analyzer home"><span className="sports-mark"><span/><span/><span/></span><span className="wordmark-copy"><strong>FANTASY</strong><small>FOOTBALL ANALYZER</small></span></a>
      <nav ref={navRef} className="sports-primary-nav editorial-primary-nav" aria-label="Fantasy navigation">{primaryNavigation.map(({ name }) => {
        const label = name === 'League Matchups' ? 'League' : name === 'NFL Schedule' ? 'NFL' : name;
        return <button key={name} aria-label={name} title={name} aria-current={tab === name ? 'page' : undefined} className={`sports-nav-destination ${tab === name ? 'active' : ''}`} onClick={() => navigate(name)}><span>{label}</span></button>;
      })}<i ref={navIndicatorRef} className="sports-nav-motion-indicator" aria-hidden="true"/></nav>
      <div className="sports-context-tools editorial-context-tools"><span className="sports-week-mark"><span>Week</span><strong>{snapshot?.league.current_week ?? '--'}</strong></span><span className="editorial-espn-status"><i/> ESPN connected</span><span className="editorial-updated"><Stamp date={snapshot?.updatedAt ?? null}/></span>{liveMode === 'live' && <span className="sports-live"><i/>LIVE</span>}<button className="sports-tool-button" title="Open Analyzer" aria-label="Open Analyzer" onClick={() => window.dispatchEvent(new CustomEvent('analyzer:open'))}><BarChart3 size={16}/></button>{hasRootRefresh && <button className="sports-tool-button" title="Refresh league data" aria-label="Refresh league data" onClick={refresh} disabled={loading || refreshing || isWeekLoading || (!!remotePredictionPath && remotePrediction.loading)}><RefreshCw size={16} className={loading || refreshing ? 'spin' : ''}/></button>}</div>
    </header>
    {menuOpen && <><button className="sports-more-backdrop" aria-label="Close more navigation" onClick={() => setMenuOpen(false)}/><nav className="sports-more-menu" aria-label="More fantasy destinations">{mobileMoreNavigation.map(({ name, icon: Icon }) => <button key={name} aria-current={tab === name ? 'page' : undefined} onClick={() => navigate(name)}><Icon size={17}/>{name}<ArrowRight size={14}/></button>)}</nav></>}
    <div className="sports-main-shell editorial-main-shell">
    <main>{tab === 'Dashboard' ? null : ['League Matchups', 'Predictions', 'NFL Schedule', 'Players', 'Waivers', 'Start/Sit', 'Trades'].includes(tab) ? null : <div className="page-heading"><div><span className="eyebrow">{tab === 'NFL Schedule' ? 'NFL · real games' : `Fantasy football · ${snapshot?.league.year ?? ''}`}</span><h1>{tab}</h1><p>{tab === 'My Team' ? 'Your roster, organized by starting slot.' : tab === 'Players' ? 'Search, compare, and save real NFL players.' : tab === 'Trades' ? 'Find a useful deal and see what it means for both teams.' : tab === 'Waivers' ? 'Free agents ranked for your team’s needs.' : tab === 'Start/Sit' ? 'Choose the strongest legal lineup for your league.' : tab === 'NFL Schedule' ? 'Real NFL games, separate from fantasy matchups.' : 'Simulated outcomes for every fantasy matchup.'}</p></div><button className="button research-ask-button" type="button" onClick={() => window.dispatchEvent(new CustomEvent('analyzer:open'))}><BarChart3 size={15}/> Insights</button></div>}
    {loading ? <LoadingState/> : error ? <ErrorState error={error} retry={refresh}/> : snapshot && <>
    {(refreshError || (['Dashboard', 'League Matchups'].includes(tab) && predictionError)) && <div className="refresh-warning" role="status"><CircleHelp size={14}/><span>Refresh unavailable. Showing the last successful league data.</span></div>}
    {tab === 'Dashboard' && <DashboardHome snapshot={snapshot} startSit={dashboardStartSit?.week === snapshot.league.current_week ? dashboardStartSit : null} onNavigate={navigate} onDetails={setDetails} customProjections={rosterProjectionById}/>}
    {tab === 'My Team' && <RosterLineupBoard team={snapshot.team} week={snapshot.league.current_week} liveTeamIds={snapshot.liveTeamIds} customProjections={rosterProjectionById}/>}
    {tab === 'Players' && <PlayerSearchPanel liveTeamIds={snapshot.liveTeamIds}/>}
    {tab === 'Trades' && <TradeAnalyzerPanel data={snapshot.matchups} myTeamId={snapshot.team.team_id} week={snapshot.league.current_week}/>}
    
    {tab === 'NFL Schedule' && <NFLSchedulePanel/>}
    {tab === 'Start/Sit' && <StartSitPanel league={snapshot.league} liveTeamIds={snapshot.liveTeamIds}/>}
    {tab === 'Waivers' && <WaiverAssistantPanel league={snapshot.league} liveTeamIds={snapshot.liveTeamIds} selectedPositions={waiverPositions} onPositionsChange={setWaiverPositions}/>}
    {tab === 'Predictions' && <PredictionsPanel league={snapshot.league} week={week ?? snapshot.league.current_week} matchups={displayedMatchups ?? null} predictions={predictionData ?? null} liveTeamIds={snapshot.liveTeamIds} loading={isWeekLoading || (!!remotePredictionPath && (remotePrediction.loading || (!remotePrediction.data && !remotePrediction.error)))} error={(remotePath ? remote.error : null) || remotePrediction.error || (week === snapshot.league.current_week ? predictionError : null)} onWeekChange={changeWeek} onRetry={refresh}/>}
    {tab === 'League Matchups' && (isWeekLoading ? <ScoreSkeleton/> : remotePath && remote.error ? <section className="sf-page sf-empty" role="alert"><h2>League scores temporarily unavailable</h2><button className="button" onClick={refresh}>Retry</button></section> : displayedMatchups && <LeagueMatchupsPanel matchups={displayedMatchups} predictions={predictionData} myTeamId={snapshot.team.team_id} week={week ?? snapshot.league.current_week} currentWeek={snapshot.league.current_week} liveTeamIds={snapshot.liveTeamIds} weeks={weeks} onWeekChange={changeWeek} onDetails={setDetails}/>)}
    <footer className="page-footer"><span>{remotePath && remote.error ? <><CircleHelp size={13}/> Selected fantasy week unavailable</> : <><Check size={13}/> ESPN league connected</>}</span><span>-- = Unavailable <span className="meta-dot">·</span> No estimated replacements</span></footer>
    </>}
    </main></div><nav className="sports-mobile-nav" aria-label="Quick navigation">{[{name:'Dashboard',label:'Dashboard',icon:LayoutDashboard},{name:'My Team',label:'Team',icon:Shield},{name:'Players',label:'Players',icon:Search},{name:'Waivers',label:'Waivers',icon:Zap}].map(({name,label,icon:Icon})=><button type="button" key={name} className={tab===name?'active':''} aria-current={tab===name?'page':undefined} onClick={() => navigate(name)}><Icon size={19}/><span>{label}</span></button>)}<button type="button" className={menuOpen?'active':''} aria-expanded={menuOpen} onClick={()=>setMenuOpen(value=>!value)}><Menu size={19}/><span>More</span></button></nav>{details && snapshot && <MatchupDetailDialog matchup={details} prediction={predictionsById.get(details.fantasy_matchup_id)} close={() => setDetails(null)} week={week ?? snapshot.league.current_week} currentWeek={snapshot.league.current_week} liveTeamIds={snapshot.liveTeamIds}/>}
    <AnalysisPanel page={tab} week={week ?? snapshot?.league.current_week ?? null} positions={waiverPositions}/>
  </div>;
}
