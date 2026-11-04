'use client';
import { PlayerProjection } from './player-projection';
import LatestPlayerUpdates from './latest-player-updates';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Activity, Bookmark, BookmarkCheck, Info, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { canonicalProjection, PROJECTION_CHANGED, fetchBackend, requestBackend } from '@/lib/api';
import { Player, points } from '@/lib/types';
import { motionAllowed, motionTiming } from '@/lib/motion';
import { nflTeamPalette } from '@/lib/nfl-team-colors';

gsap.registerPlugin(useGSAP);

type QuickViewContextValue = { open: (playerId: number, initial?: Player) => void };
const QuickViewContext = createContext<QuickViewContextValue | null>(null);
export function usePlayerQuickView() { return useContext(QuickViewContext); }
type StatusPlayer = Pick<Player, 'player_id' | 'name' | 'position' | 'nfl_team' | 'injury_status'> & Partial<Player>;
type StatusContextValue = { open: (player: StatusPlayer) => void };
const StatusContext = createContext<StatusContextValue | null>(null);
export function usePlayerStatusPanel() { return useContext(StatusContext); }
const playerDetailsCache = new Map<number, Player>();
function TeamPlayerBanner({ player, variant }: { player: Player; variant: 'quick' | 'status' }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => { setPhotoFailed(false); setLogoFailed(false); }, [player.player_id]);
  const [color, secondary] = nflTeamPalette(player.nfl_team, player.nfl_team_color, player.nfl_team_alternate_color) || ['#252c39', '#141923'];
  const defense = player.position === 'D/ST' || player.position === 'DST';
  const portrait = defense ? player.nfl_team_logo_url : player.headshot_url || `https://a.espncdn.com/i/headshots/nfl/players/full/${player.player_id}.png`;
  return <div className={`team-player-banner team-player-banner-${variant}`} style={{'--banner-team': color, '--banner-secondary': secondary} as React.CSSProperties}>
    {player.nfl_team_logo_url && !logoFailed && <img className="team-player-banner-mark" src={player.nfl_team_logo_url} alt="" aria-hidden="true" onError={() => setLogoFailed(true)}/>}
    {!photoFailed && portrait ? <img className={`team-player-banner-portrait ${defense ? 'is-defense' : ''}`} src={portrait} alt={`${player.name} portrait`} onError={() => setPhotoFailed(true)}/> : <span className="team-player-banner-fallback">{player.position || player.nfl_team || 'NFL'}</span>}
    <div className="team-player-banner-copy"><span className="eyebrow">{player.nfl_team_full_name || player.nfl_team || 'NFL player'}</span><h2 id={variant === 'quick' ? 'quick-view-player-name' : undefined}>{player.name}</h2><p>{player.position || 'Position unavailable'} · {player.nfl_team_full_name || player.nfl_team || 'NFL team unavailable'}{player.jersey_number != null ? ` · #${player.jersey_number}` : ''}</p><PlayerStatusButton player={player}/></div>
  </div>;
}
const positionStats: Record<string, [string, string][]> = {
  QB: [['passingCompletions','Completions'],['passingAttempts','Attempts'],['passingYards','Pass yards'],['passingTouchdowns','Pass TD'],['passingInterceptions','INT'],['rushingAttempts','Rush att.'],['rushingYards','Rush yards'],['rushingTouchdowns','Rush TD']],
  RB: [['rushingAttempts','Carries'],['rushingYards','Rush yards'],['rushingTouchdowns','Rush TD'],['receivingTargets','Targets'],['receivingReceptions','Receptions'],['receivingYards','Rec. yards'],['receivingTouchdowns','Rec. TD']],
  WR: [['receivingTargets','Targets'],['receivingReceptions','Receptions'],['receivingYards','Rec. yards'],['receivingTouchdowns','Rec. TD'],['rushingAttempts','Rush att.'],['rushingYards','Rush yards'],['rushingTouchdowns','Rush TD']],
  TE: [['receivingTargets','Targets'],['receivingReceptions','Receptions'],['receivingYards','Rec. yards'],['receivingTouchdowns','Rec. TD'],['rushingAttempts','Rush att.'],['rushingYards','Rush yards'],['rushingTouchdowns','Rush TD']],
  K: [['attemptedFieldGoals','FG att.'],['madeFieldGoals','FG made'],['attemptedExtraPoints','XP att.'],['madeExtraPoints','XP made']],
  'D/ST': [['defensiveSacks','Sacks'],['defensiveInterceptions','INT'],['defensiveFumbles','Fumbles'],['defensiveBlockedKicks','Blocks'],['defensiveSafeties','Safeties'],['defensiveTouchdowns','TDs']],
};

export function PlayerQuickViewProvider({ children }: { children: React.ReactNode }) {
  const [projectionRevision, setProjectionRevision] = useState(0);
  useEffect(() => {
    const changed = () => { playerDetailsCache.clear(); setProjectionRevision(n => n + 1); };
    window.addEventListener(PROJECTION_CHANGED, changed);
    return () => window.removeEventListener(PROJECTION_CHANGED, changed);
  }, []);
  const [quickWeek, setQuickWeek] = useState<number | null>(null);
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusPlayer, setStatusPlayer] = useState<Player | null>(null);
  const [statusDetails, setStatusDetails] = useState<Player | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [savedPlayerIds, setSavedPlayerIds] = useState<Set<number>>(new Set());
  const [savingPlayer, setSavingPlayer] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [quickViewTab, setQuickViewTab] = useState<'overview' | 'game-log' | 'matchup'>('overview');
  const statusDialog = useRef<HTMLDialogElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const tabNav = useRef<HTMLElement>(null);
  const tabIndicator = useRef<HTMLSpanElement>(null);
  const tabContent = useRef<HTMLDivElement>(null);
  const tabIndicatorReady = useRef(false);
  const statsRef = useRef<HTMLDivElement>(null);
  const previousStats = useRef<{ id: number | null; key: string } | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openerWasKeyboardFocused = useRef(false);
  const scrollYRef = useRef(0);
  const quickViewMotion = useRef<gsap.core.Timeline | null>(null);
  const { contextSafe } = useGSAP({ scope: dialog });
  const prefersReducedMotion = () => !motionAllowed();
  const finishQuickViewClose = useCallback(() => {
    quickViewMotion.current?.kill();
    quickViewMotion.current = null;
    if (dialog.current?.open) dialog.current.close();
    setPlayerId(null);
    window.scrollTo({ top: scrollYRef.current, behavior: 'instant' });
    const opener = openerRef.current;
    if (opener) {
      if (!openerWasKeyboardFocused.current && opener.matches('.player-avatar')) {
        opener.setAttribute('data-qv-return-focus', 'pointer');
        opener.addEventListener('blur', () => opener.removeAttribute('data-qv-return-focus'), { once: true });
      }
      requestAnimationFrame(() => {
        opener.focus({ preventScroll: true });
        window.scrollTo({ top: scrollYRef.current, behavior: 'instant' });
      });
    }
    openerRef.current = null;
  }, []);
  const closeQuickView = useCallback(contextSafe(() => {
    const node = dialog.current;
    if (!node?.open) { setPlayerId(null); return; }
    quickViewMotion.current?.kill();
    if (prefersReducedMotion()) { finishQuickViewClose(); return; }
    const inner = node.querySelector<HTMLElement>('.quick-view-inner');
    quickViewMotion.current = gsap.timeline({ onComplete: finishQuickViewClose });
    if (inner) quickViewMotion.current.to(inner, { autoAlpha: 0, y: 8, scale: 0.99, duration: motionTiming.quickClose, ease: 'power1.in' }, 0);
    quickViewMotion.current.to(node, { '--quickview-backdrop-alpha': 0, duration: motionTiming.backdrop, ease: 'power1.in' }, 0);
  }), [contextSafe, finishQuickViewClose]);
  const open = useCallback(contextSafe((id: number, initial?: Player) => {
    setQuickWeek(initial?.week ?? null);
    const available = initial || null;
    const node = dialog.current;
    setPlayerId(id); setPlayer(available); setError(null); setLoading(true);
    if (!node || node.open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openerWasKeyboardFocused.current = openerRef.current?.matches(':focus-visible') || false;
    scrollYRef.current = window.scrollY;
    setQuickViewTab('overview');
    tabIndicatorReady.current = false;
  }), [contextSafe]);
  useGSAP(() => {
    if (playerId === null || !dialog.current || dialog.current.open) return;
    const node = dialog.current;
    const inner = node.querySelector<HTMLElement>('.quick-view-inner');
    quickViewMotion.current?.kill();
    if (prefersReducedMotion()) {
      node.style.setProperty('--quickview-backdrop-alpha', '.74');
      if (inner) gsap.set(inner, { clearProps: 'opacity,visibility,transform' });
      node.showModal();
      return;
    }
    node.style.setProperty('--quickview-backdrop-alpha', '0');
    if (inner) gsap.set(inner, { autoAlpha: 0, y: 8, scale: 0.99 });
    node.showModal();
    quickViewMotion.current = gsap.timeline();
    if (inner) quickViewMotion.current.to(inner, { autoAlpha: 1, y: 0, scale: 1, duration: motionTiming.quickOpen, ease: 'power2.out' }, 0);
    quickViewMotion.current.to(node, { '--quickview-backdrop-alpha': 0.74, duration: motionTiming.backdrop, ease: 'power1.out' }, 0);
  }, { scope: dialog, dependencies: [playerId] });
  useGSAP(() => {
    const activeTab = tabNav.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    const indicator = tabIndicator.current;
    if (activeTab && indicator) {
      const target = { x: activeTab.offsetLeft, width: activeTab.offsetWidth, autoAlpha: 1 };
      if (!motionAllowed() || !tabIndicatorReady.current) gsap.set(indicator, target);
      else gsap.to(indicator, { ...target, duration: motionTiming.tab, ease: 'power2.out', overwrite: true });
      tabIndicatorReady.current = true;
    }
    if (!tabContent.current || !dialog.current?.open || !motionAllowed()) return;
    gsap.fromTo(tabContent.current, { autoAlpha: 0.82, y: 5 }, { autoAlpha: 1, y: 0, duration: motionTiming.tab, ease: 'power1.out', clearProps: 'opacity,visibility,transform' });
  }, { scope: dialog, dependencies: [quickViewTab, playerId] });
  const openStatus = useCallback((initial: StatusPlayer) => { const immediate = initial as Player; setStatusPlayer(immediate); setStatusDetails(playerDetailsCache.get(initial.player_id) || null); setStatusLoading(true); if (statusDialog.current && !statusDialog.current.open) statusDialog.current.showModal(); }, []);
  useEffect(() => {
    if (playerId === null) return;
    const controller = new AbortController();
    fetchBackend<Player>(`/players/${playerId}${quickWeek ? `?week=${quickWeek}` : ''}`, controller.signal).then(data => {
      playerDetailsCache.set(playerId, data);
      if (!controller.signal.aborted) {
        setPlayer(current => {
          if (!current || current.player_id !== playerId) return data;
          return {
            ...data,
            nfl_team: current.nfl_team || data.nfl_team,
            nfl_team_id: current.nfl_team_id ?? data.nfl_team_id,
            nfl_team_color: current.nfl_team_color || data.nfl_team_color,
            nfl_team_alternate_color: current.nfl_team_alternate_color || data.nfl_team_alternate_color,
            nfl_team_logo_url: current.nfl_team_logo_url || data.nfl_team_logo_url,
            headshot_url: current.headshot_url || data.headshot_url,
          };
        });
        setLoading(false);
      }
    }).catch(reason => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
    });
    return () => controller.abort();
  }, [playerId, quickWeek, projectionRevision]);
  useEffect(() => {
    if (playerId === null) return;
    const controller = new AbortController();
    fetchBackend<{ items: { player_id: number }[] }>('/watchlist', controller.signal).then(result => {
      if (!controller.signal.aborted) setSavedPlayerIds(new Set(result.items.map(item => item.player_id)));
    }).catch(() => { /* Saved-player state is optional until the user opens a profile. */ });
    return () => controller.abort();
  }, [playerId, quickWeek, projectionRevision]);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ playerId: number; saved: boolean }>).detail;
      if (!detail) return;
      setSavedPlayerIds(current => { const next = new Set(current); if (detail.saved) next.add(detail.playerId); else next.delete(detail.playerId); return next; });
    };
    window.addEventListener('watchlist:changed', update);
    return () => window.removeEventListener('watchlist:changed', update);
  }, []);
  useEffect(() => {
    if (!statusPlayer) return;
    const controller = new AbortController();
    fetchBackend<Player>(`/players/${statusPlayer.player_id}${statusPlayer.week ? `?week=${statusPlayer.week}` : ''}`, controller.signal).then(data => {
      playerDetailsCache.set(data.player_id, data);
      if (!controller.signal.aborted) { setStatusDetails(data); setStatusPlayer(data); setStatusLoading(false); }
    }).catch(() => { if (!controller.signal.aborted) setStatusLoading(false); });
    return () => controller.abort();
  }, [statusPlayer?.player_id]);
  const games = player?.game_log || [];
  const recentAverage = (count: number) => {
    const values = games.slice(-count).map(game => game.fantasy_points).filter((value): value is number => typeof value === 'number');
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  };
  const displayedStatsKey = player ? [canonicalProjection(player), player.season_fantasy_average, recentAverage(3)].join('|') : '';
  useGSAP(() => {
    const previous = previousStats.current;
    previousStats.current = { id: playerId, key: displayedStatsKey };
    if (loading || !player || !statsRef.current || !motionAllowed() || previous?.id !== playerId || previous.key === displayedStatsKey) return;
    gsap.fromTo(statsRef.current, { autoAlpha: 0.82, y: 3 }, { autoAlpha: 1, y: 0, duration: motionTiming.value, ease: 'power1.out', clearProps: 'opacity,visibility,transform' });
  }, { scope: dialog, dependencies: [loading, playerId, displayedStatsKey] });
  const currentStats: [string, string][] = player ? (positionStats[player.position || ''] || Object.entries(player.game_stats || {}).map(([key])=>[key,key.replaceAll('_',' ')] as [string,string])).filter(([key])=>typeof player.game_stats?.[key] === 'number') : [];
  const shownStatus = statusDetails || statusPlayer;
  async function toggleSavedPlayer() {
    if (!player) return;
    setSavingPlayer(true); setSaveError(null);
    try {
      const wasSaved = savedPlayerIds.has(player.player_id);
      if (wasSaved) await requestBackend(`/watchlist/${player.player_id}`, 'DELETE');
      else await requestBackend('/watchlist', 'POST', { player_id: player.player_id, label: null });
      const saved = !wasSaved;
      setSavedPlayerIds(current => { const next = new Set(current); if (saved) next.add(player.player_id); else next.delete(player.player_id); return next; });
      window.dispatchEvent(new CustomEvent('watchlist:changed', { detail: { playerId: player.player_id, saved } }));
    } catch (cause) { setSaveError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSavingPlayer(false); }
  }
  const statusText = String(shownStatus?.injury_status || 'Status unavailable').replaceAll('_', ' ');
  const statusUpper = statusText.toUpperCase();
  const statusEvents = shownStatus?.custom_projection?.context_events || [];
  const officialReport = statusEvents.filter(event => event.event_type === 'official_injury_report').slice().sort((a,b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))[0];
  const reportDetail = officialReport?.detail || {};
  const injury = [reportDetail.primary_injury, reportDetail.secondary_injury, reportDetail.injury, reportDetail.injury_type, reportDetail.body_part].find(value => typeof value === 'string' && value.trim());
  const practice = typeof reportDetail.practice_status === 'string' ? reportDetail.practice_status : null;
  const reportStatus = typeof reportDetail.report_status === 'string' ? reportDetail.report_status : null;
  const expectedReturn = [reportDetail.expected_return, reportDetail.return_estimate].find(value => typeof value === 'string' && value.trim());
  const earliestEligible = [reportDetail.earliest_eligible_return, reportDetail.earliest_eligible_week].find(value => typeof value === 'string' || typeof value === 'number');
  const reportDate = officialReport?.timestamp || (typeof reportDetail.report_date === 'string' ? reportDetail.report_date : null);
  const statusTimeline = statusEvents.filter(event => event.event_type && (event.timestamp || event.detail?.report_status || event.detail?.practice_status || event.detail?.primary_injury)).slice().sort((a,b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
  const statusNews = shownStatus?.news || [];
  const fantasyGuidance = /\bOUT\b|INJURED RESERVE|\bIR\b|\bPUP\b|SUSPENDED|INACTIVE/.test(statusUpper)
    ? /\bIR\b|INJURED RESERVE|\bPUP\b/.test(statusUpper) ? 'Keep him in an IR spot if your league has one. Do not count on him in your lineup this week.' : 'Do not start him this week.'
    : /DOUBTFUL/.test(statusUpper) ? 'Have a backup ready. He is unlikely to play.'
      : /QUESTIONABLE|LIMITED|DAY TO DAY|DTD/.test(statusUpper) ? 'Keep him in your lineup for now, but check his status before kickoff.'
        : /ACTIVE|HEALTHY|NORMAL/.test(statusUpper) ? 'No current injury concern is listed in the available data.'
          : 'The available information is not specific enough for lineup advice.';
  const returnGuidance = typeof expectedReturn === 'string' ? expectedReturn : null;
  const whatHappened = injury && practice ? `The report lists ${String(injury)} and says he was ${practice.toLowerCase()} this week.` : injury ? `The injury report lists ${String(injury)}. Details about when it happened are not available.` : practice ? `The official report lists him as ${practice.toLowerCase()} this week. The reason was not included.` : null;
  const statusAccent = shownStatus?.nfl_team_color && /^[\da-f]{6}$/i.test(shownStatus.nfl_team_color) ? `#${shownStatus.nfl_team_color}` : '#405226';
    return <QuickViewContext.Provider value={{ open }}><StatusContext.Provider value={{ open: openStatus }}>{children}<dialog className="quick-view-dialog status-dialog" ref={statusDialog} onCancel={() => { statusDialog.current?.close(); setStatusPlayer(null); }} onClick={event => { if (event.target === event.currentTarget) { statusDialog.current?.close(); setStatusPlayer(null); } }} aria-labelledby="player-status-title"><div className="quick-view-inner"><header><span className="eyebrow">PLAYER STATUS</span><button className="icon-button" aria-label="Close player status" onClick={() => { statusDialog.current?.close(); setStatusPlayer(null); }}><X size={18}/></button></header>{shownStatus && <><div className="status-panel-hero" style={{'--banner-team': statusAccent} as React.CSSProperties}><TeamPlayerBanner player={shownStatus} variant="status"/></div><section className="status-section"><h3>Status</h3><strong className="status-current-value">{statusText}</strong></section><section className="status-section"><h3>Injury</h3><p>{injury ? String(injury) : 'Injury detail is unavailable.'}</p></section><section className="status-section"><h3>Latest report</h3><p>{whatHappened || (reportStatus ? `Listed as ${reportStatus}.` : 'No additional report details are available.')}</p><small>{reportDate ? `${new Date(String(reportDate)).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} · ${officialReport?.source || 'Structured injury report'}` : 'Report time unavailable · source unavailable'}</small></section><section className="status-section"><h3>Practice this week</h3><div className="practice-timeline" aria-label="Official practice report"><div><span>{practice ? 'Latest practice' : 'Practice report'}</span><strong>{practice || 'Unavailable'}</strong><small>{practice ? (officialReport?.source || 'Official injury report') : 'No practice status was provided'}</small></div></div><details className="status-definitions"><summary>Practice status definitions</summary><p>DNP means did not practice. Limited means the player took part in some practice. Full means full practice participation.</p></details></section><section className="status-section"><h3>Return status</h3>{earliestEligible !== undefined && <p><span>Earliest eligible</span><strong>Week {String(earliestEligible).replace(/^week\s*/i,'')}</strong></p>}<p><span>Expected</span><strong>{returnGuidance || 'No return estimate has been reported.'}</strong></p></section><section className="status-section status-fantasy-guidance"><h3>What this means for fantasy</h3><p>{fantasyGuidance}</p>{shownStatus.nfl_game_time && /QUESTIONABLE|DOUBTFUL|LIMITED|DTD/.test(statusUpper) && <small>Kickoff: {new Date(shownStatus.nfl_game_time).toLocaleString([], {weekday:'short',hour:'numeric',minute:'2-digit'})}</small>}</section>{statusTimeline.length > 0 && <section className="status-section"><h3>Recent updates</h3><ol className="status-vertical-timeline">{statusTimeline.map((event,index)=><li key={`${event.event_type}-${event.timestamp}-${index}`}><span className="timeline-dot"/><time>{event.timestamp ? new Date(event.timestamp).toLocaleDateString([], {month:'short',day:'numeric'}) : 'Official report'}</time><strong>{event.event_type === 'official_injury_report' ? 'Official injury report' : event.event_type?.replaceAll('_',' ')}</strong><p>{String(event.detail?.practice_status || event.detail?.report_status || event.detail?.primary_injury || event.detail?.depth_chart_position || 'Structured update; more detail was not provided.')}</p></li>)}</ol></section>}<section className="status-section status-panel-updates"><h3>Related updates</h3>{statusNews.length ? statusNews.slice(0,4).map((item,index)=><article key={`${item.source}-${index}`}><time>{item.timestamp ? new Date(item.timestamp).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Date unavailable'}</time><strong>{item.headline}</strong>{item.summary && <p>{item.summary}</p>}<small>{item.source || 'Source unavailable'}</small>{item.url && <a href={item.url} target="_blank" rel="noreferrer">Read update ↗</a>}</article>) : statusEvents.length ? statusEvents.slice(0,4).map((event,index)=><article key={`${event.event_type}-${index}`}><time>{event.timestamp ? new Date(event.timestamp).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Date unavailable'}</time><strong>{event.event_type === 'official_injury_report' ? 'Official injury report' : (event.event_type || 'Structured update').replaceAll('_',' ')}</strong><p>{String(event.detail?.primary_injury || event.detail?.secondary_injury || event.detail?.practice_status || event.detail?.report_status || event.detail?.depth_chart_position || 'Structured update; additional details are unavailable.')}</p><small>{event.source || 'Source unavailable'}</small>{typeof event.detail?.url === 'string' && <a href={event.detail.url} target="_blank" rel="noreferrer">Read update ↗</a>}</article>) : <p>No recent relevant news is available.</p>}{statusLoading && <small className="status-loading-note">Checking ESPN for more player details…</small>}</section>{reportDate && <footer className="status-source">Source: {officialReport?.source || 'Structured player status'} · Updated {new Date(reportDate).toLocaleString()}</footer>}</>}</div></dialog><dialog className="quick-view-dialog" ref={dialog} onCancel={event => { event.preventDefault(); closeQuickView(); }} onClick={event => { if (event.target === event.currentTarget) closeQuickView(); }} aria-labelledby="quick-view-player-name"><div className="quick-view-inner"><header><span className="eyebrow">PLAYER QUICK VIEW</span><button className="icon-button" aria-label="Close player quick view" onClick={closeQuickView}><X size={18}/></button></header>{loading && !player ? <div className="quick-view-skeleton"><span className="skeleton h-16 w-16 rounded-full"/><span className="skeleton h-7 w-60"/><span className="skeleton h-24 w-full"/></div> : error && !player ? <div className="error-card" role="alert"><Activity size={22}/><h2>Player details unavailable</h2><p>Player details could not be loaded right now.</p><button className="button" onClick={() => playerId !== null && open(playerId, player || undefined)}>Retry</button></div> : player && <><TeamPlayerBanner player={player} variant="quick"/>{loading ? <span className="quick-view-refreshing" role="status">Updating details…</span> : error ? <span className="quick-view-refreshing" role="status">Some player details are unavailable.</span> : null}
<div className="quick-view-core-stats" ref={statsRef} aria-busy={loading}>{[['Projection', canonicalProjection(player)], ['Season avg.', player.season_fantasy_average], ['Recent avg.', recentAverage(3)]].map(([label, value]) => <div key={String(label)}><span>{label}</span><strong className={loading && typeof value !== 'number' ? 'is-loading' : ''}>{label === 'Projection' ? <PlayerProjection player={player}/> : points(typeof value === 'number' ? value : null)}</strong></div>)}</div>
<nav className="quick-view-tabs" ref={tabNav} aria-label="Player details"><span className="quick-view-tab-indicator" ref={tabIndicator} aria-hidden="true"/>{([{id:'overview',label:'Overview'},{id:'game-log',label:'Game log'},{id:'matchup',label:'Matchup'}] as const).map(tab => <button type="button" key={tab.id} aria-pressed={quickViewTab === tab.id} onClick={() => setQuickViewTab(tab.id)}>{tab.label}</button>)}</nav>
<div ref={tabContent} className="quick-view-tab-content" role="region" aria-live="polite">
{quickViewTab === 'overview' && <><section className="quick-view-news"><h3>Current game stats</h3>{currentStats.length ? <div className="quick-view-grid">{currentStats.map(([key,label]) => <div key={key}><span>{label}</span><strong>{player.game_stats?.[key]}</strong></div>)}</div> : <p>Current game stats are unavailable.</p>}</section>
<LatestPlayerUpdates key={`${player.player_id}-${player.week}`} playerId={player.player_id} updates={player.latest_updates} loading={loading}/>

<details className="quick-view-extra"><summary>Player details</summary><div>{[['Age',player.age],['Height',player.height],['Weight',player.weight ? `${player.weight} lb` : null],['Bye week',player.bye_week],['Fantasy status',player.roster_status || (player.fantasy_team_id ? 'Rostered' : null)],['Owner team',player.fantasy_team_name ? `${player.fantasy_team_name}${player.fantasy_team_owner ? ` · ${player.fantasy_team_owner}` : ''}` : null]].filter(([,value]) => value != null).map(([label,value]) => <span key={String(label)}>{label} <b>{String(value)}</b></span>)}</div></details></>}
{quickViewTab === 'game-log' && <section className="quick-view-news"><h3>Recent games</h3>{games.length ? <div className="quick-view-grid">{games.slice(-5).reverse().map(game => <div key={game.week}><span>Week {game.week}</span><strong>{points(game.fantasy_points)}</strong></div>)}</div> : <p>Game log is unavailable.</p>}{player.rankings && <details className="quick-view-extra"><summary>ESPN league ranks</summary><div>{[['Season points',player.rankings.season_points],['Points / game',player.rankings.points_per_game],[`Week ${player.week} model`,player.rankings.week_our_projection]].map(([label,rank]) => {const value = rank as {position:number;overall:number}|null|undefined;return <span key={String(label)}>{String(label)} <b>{value ? `#${value.position} ${player.position || ''} · #${value.overall} overall` : 'Unavailable'}</b></span>;})}</div></details>}</section>}
{quickViewTab === 'matchup' && <section className="quick-view-news"><h3>This week</h3><div className="quick-view-matchup-info">{player.nfl_opponent && <div><span>Opponent</span><strong>vs {player.nfl_opponent}</strong></div>}{player.nfl_game_time && <div><span>Kickoff</span><strong>{new Date(player.nfl_game_time).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</strong></div>}{player.injury_status && <div><span>Status</span><strong>{String(player.injury_status).replaceAll('_',' ')}</strong></div>}{!player.nfl_opponent && !player.nfl_game_time && !player.injury_status && <p>Matchup details are unavailable.</p>}</div>{player.custom_projection?.adjustments?.length ? <details className="quick-view-extra"><summary>Projection details</summary><ul>{player.custom_projection.adjustments.map((factor,index) => <li key={`${factor.key}-${index}`}>{factor.label}: {factor.evidence}</li>)}</ul></details> : null}</section>}
</div>
<div className="quick-view-actions"><a className="button" href={`/players/${player.player_id}`}>View full profile <span aria-hidden="true">→</span></a><button className="button" type="button" onClick={() => void toggleSavedPlayer()} disabled={savingPlayer}>{savedPlayerIds.has(player.player_id) ? <BookmarkCheck size={15}/> : <Bookmark size={15}/>} {savingPlayer ? 'Saving…' : savedPlayerIds.has(player.player_id) ? 'Saved' : 'Save player'}</button></div>{saveError && <p className="quick-view-save-error" role="alert">Could not update saved players. Please try again.</p>}</>}</div></dialog></StatusContext.Provider></QuickViewContext.Provider>;
}

export function PlayerStatusButton({ player, className = '', compact = false }: { player: StatusPlayer; className?: string; compact?: boolean }) {
  const status = usePlayerStatusPanel();
  const value = String(player.injury_status || '').replaceAll('_', ' ').trim() || 'Status unavailable';
  const known = value !== 'Status unavailable' && !['ACTIVE', 'NORMAL', 'HEALTHY'].includes(value.toUpperCase());
  const shortNames: Record<string,string> = { QUESTIONABLE:'Q', DOUBTFUL:'D', OUT:'OUT', INJURED_RESERVE:'IR', 'INJURED RESERVE':'IR', DAY_TO_DAY:'DTD', 'DAY TO DAY':'DTD', PUP:'PUP', SUSPENDED:'SUSP', ACTIVE:'ACT', HEALTHY:'ACT', NORMAL:'ACT' };
  const shownValue = compact ? shortNames[value.toUpperCase()] || (known ? value.slice(0,4).toUpperCase() : '--') : value;
  return <button type="button" className={`player-status-badge ${known ? 'has-status' : 'status-clear'} ${compact ? 'is-compact' : ''} ${className}`} onClick={() => status?.open(player)} aria-label={`${player.name} status: ${value}. Open details`} title={`${value} · View player status details`}><span>{shownValue}</span><Info size={12}/></button>;
}

export function TeamLogo({ player, className = '' }: { player: Pick<Player, 'nfl_team' | 'nfl_team_logo_url'>; className?: string }) {
  const [failed, setFailed] = useState(false);
  return player.nfl_team_logo_url && !failed
    ? <img className={className} src={player.nfl_team_logo_url} alt={`${player.nfl_team || 'NFL'} logo`} loading="lazy" onError={() => setFailed(true)}/>
    : <span className={`team-logo-fallback ${className}`} aria-label={`${player.nfl_team || 'NFL'} logo unavailable`}>{player.nfl_team || 'NFL'}</span>;
}
export function PlayerAvatar({ player, size = 'md', interactive = true }: { interactive?: boolean; player: Pick<Player, 'player_id' | 'name' | 'position' | 'nfl_team' | 'nfl_team_id' | 'nfl_team_logo_url' | 'headshot_url'> & Partial<Pick<Player, 'nfl_team_color' | 'nfl_team_alternate_color'>>; size?: 'sm' | 'md' | 'lg' }) {
  const quickView = usePlayerQuickView();
  const [failed, setFailed] = useState(false);
  const isDefense = player.position === 'D/ST' || player.position === 'DST';
  const url = isDefense ? player.nfl_team_logo_url : (player.headshot_url || `https://a.espncdn.com/i/headshots/nfl/players/full/${player.player_id}.png`);
  const teamColor = player.nfl_team_color && /^[\da-f]{6}$/i.test(player.nfl_team_color) ? `#${player.nfl_team_color}` : undefined;
  const content = failed || !url ? (isDefense ? <TeamLogo player={player}/> : <span>{player.position || player.nfl_team || 'NFL'}</span>) : <img src={url} alt="" loading="lazy" onError={() => setFailed(true)}/>;
  if (!interactive) return <span className={`player-avatar player-avatar-${size}`}>{content}</span>;
  return <button className={`player-avatar player-avatar-${size} ${failed ? 'player-avatar-fallback' : ''} ${isDefense ? 'player-avatar-team' : ''}`} style={teamColor ? {'--player-team-accent': teamColor} as React.CSSProperties : undefined} type="button" aria-label={`Quick view for ${player.name}`} title={`Quick view for ${player.name}`} onClick={() => quickView?.open(player.player_id, player as Player)}>{failed || !url ? (isDefense ? <TeamLogo player={player}/> : <span>{player.position || player.nfl_team || 'NFL'}</span>) : <img src={url} alt="" loading="lazy" onError={() => setFailed(true)}/>}</button>;
}
