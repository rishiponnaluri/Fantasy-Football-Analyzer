'use client';
import { AnimatedPoints } from './player-board-cards';
import { useAdaptivePoll } from '@/lib/use-adaptive-poll';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { motionAllowed } from '@/lib/motion';
import { visibleMarket, nflWinner } from '@/lib/score-display.mjs';
import { ResultSequence } from './living-future-ui';
import { ScoreSkeleton, SmoothScoreReveal } from './score-space-ui';
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, RefreshCw, X, ChevronDown, MapPin, ExternalLink } from 'lucide-react';
import { fetchBackend } from '@/lib/api';
import { NFLGame, NFLGameDetail, NFLSchedule, points } from '@/lib/types';

gsap.registerPlugin(useGSAP);

function msg(error: unknown) { return error instanceof Error ? error.message : String(error); }
function date(value: string | null) { return value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unavailable'; }
function score(value: number | null | undefined) { return value == null ? '--' : String(value); }
function validColor(value?: string | null, fallback = '#283443') {
  return value && /^[\da-f]{6}$/i.test(value) ? `#${value}` : fallback;
}
function NFLTeamMark({ team }: { team: NFLGame['away_team'] }) {
  const [failed, setFailed] = useState(false);
  return team.logo_url && !failed
    ? <img className="nfl-team-logo" src={team.logo_url} alt={`${team.name} logo`} loading="lazy" onError={() => setFailed(true)}/>
    : <span className="nfl-abbr">{team.abbreviation || '--'}</span>;
}
function clockLabel(game: Pick<NFLGameDetail, 'status'> | Pick<NFLGame, 'status'>) {
  if (game.status.state !== 'in') return game.status.description;
  const period = game.status.period;
  const segment = period == null ? '' : period > 4 ? 'OT' : `Q${period}`;
  return [segment, game.status.clock].filter(Boolean).join(' · ') || 'In progress';
}

function kickoffLabel(kickoff: string | null) {
  if (!kickoff) return 'Kickoff unavailable';
  const value = new Date(kickoff);
  if (Number.isNaN(value.getTime())) return 'Kickoff unavailable';
  return value.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function dayHeading(kickoff: string | null) {
  if (!kickoff) return 'Date unavailable';
  const value = new Date(kickoff);
  if (Number.isNaN(value.getTime())) return 'Date unavailable';
  return value.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function groupGamesByDay(games: NFLGame[]) {
  const groups = new Map<string, { title: string; games: NFLGame[] }>();
  for (const game of games) {
    const value = game.kickoff && !Number.isNaN(new Date(game.kickoff).getTime())
      ? new Date(game.kickoff).toLocaleDateString()
      : 'unknown-date';
    const existing = groups.get(value) || { title: dayHeading(game.kickoff), games: [] };
    existing.games.push(game);
    groups.set(value, existing);
  }
  return [...groups.values()];
}

function NflMarketBar({ game }: { game: NFLGame }) {
  const marker = useRef<HTMLElement>(null);
  const previous = useRef<number | null>(null);
  const market = visibleMarket(game);
  const away = market ? Math.max(0, Math.min(1, market.away_probability)) : null;
  const home = market ? Math.max(0, Math.min(1, market.home_probability)) : null;
  useGSAP(() => {
    const old = previous.current;
    previous.current = away;
    if (old == null || away == null || old === away || !marker.current || !motionAllowed()) return;
    gsap.fromTo(marker.current,{left:`${old*100}%`},{left:`${away*100}%`,duration:.2,ease:'power2.out'});
  },{scope:marker,dependencies:[away],revertOnUpdate:true});
  if (!market || away == null || home == null) return null;
  const awayColor = validColor(game.away_team.primary_color);
  const homeColor = validColor(game.home_team.primary_color);
  return <div className="sf-nfl-market"><div className="sf-market-labels"><span><b>{game.away_team.abbreviation}</b> {(away*100).toFixed(1)}%</span><span>MARKET</span><span>{(home*100).toFixed(1)}% <b>{game.home_team.abbreviation}</b></span></div><div className="sf-market-track" role="img" aria-label={`${market.source} market: ${game.away_team.name} ${(away*100).toFixed(1)} percent, ${game.home_team.name} ${(home*100).toFixed(1)} percent`} style={{background:`linear-gradient(90deg,${awayColor} 0 ${away*100}%,${homeColor} ${away*100}% 100%)`}}><i ref={marker} className="sf-market-football" style={{left:`${away*100}%`}} aria-hidden="true"><svg viewBox="0 0 32 20"><path d="M2 10c4-5.4 9-8 14-8s10 2.6 14 8c-4 5.4-9 8-14 8S6 15.4 2 10Z"/><path className="football-seam" d="M9 5.2c4 2.2 10 7.4 14 9.6M10.5 13.4l2-2.3m1.1 4.2 2-2.3m1.1 4.1 2-2.3"/></svg></i></div></div>;
}

export function NflGameTile({ game, open, expanded }: { game: NFLGame; open: () => void; expanded: boolean }) {
  const state = game.status.state || 'unknown';
  const final = state === 'post';
  const live = state === 'in';
  const winner = nflWinner(game);
  return <article className={`sf-nfl-game sf-split-surface sf-nfl-${state}`} data-pointer-reactive data-lf-reveal style={{'--sf-left':validColor(game.away_team.primary_color),'--sf-right':validColor(game.home_team.primary_color)} as React.CSSProperties}>
    <button id={`sf-nfl-opener-${game.event_id}`} type="button" className="sf-nfl-game-main" onClick={open} aria-expanded={expanded} aria-controls={`sf-nfl-detail-${game.event_id}`} aria-label={`${expanded?'Close':'View'} ${game.away_team.name} at ${game.home_team.name} game details`}><div className="sf-nfl-game-state">{live ? <span className="sf-game-state live"><i/>LIVE · {clockLabel(game)}</span> : final ? <span className="sf-game-state final">FINAL</span> : <span className="sf-nfl-kickoff">{kickoffLabel(game.kickoff)}</span>}<ChevronDown size={15} className={expanded?'is-expanded':''}/></div><div className="sf-nfl-teams">{[{team:game.away_team,side:'away'},{team:game.home_team,side:'home'}].map(({team,side})=><div className={`sf-nfl-team ${winner===side?'is-winner':winner && winner!=='tie'?'is-loser':''}`} key={team.team_id} style={{'--sf-team':validColor(team.primary_color)} as React.CSSProperties}><NFLTeamMark team={team}/><div><strong>{team.name}</strong><small>{team.abbreviation} · {side==='away'?'Away':'Home'}</small></div>{(live||final)&&<b className="sf-nfl-score"><AnimatedPoints value={team.score} format={value=>score(value??null)}/></b>}</div>)}</div><span className="sf-nfl-detail-hint">{expanded?'Close details':'Game details'}<ChevronDown size={13} className={expanded?'is-expanded':''}/></span></button>
    {visibleMarket(game) ? <NflMarketBar game={game}/> : !final ? <p className="sf-market-unavailable">Market unavailable</p> : null}
  </article>;
}

function GameDetails({ eventId, scheduleGame, currentWeek, close }: { eventId: string; scheduleGame: NFLGame; currentWeek: number; close: () => void }) {
  const [game, setGame] = useState<NFLGameDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const isLive = game?.status.state === 'in';
  const fetchGame = useCallback(async (signal?: AbortSignal) => {
    const data = await fetchBackend<NFLGameDetail>(`/nfl/games/${eventId}`, signal);
    if (!signal?.aborted) { setGame(data); setUpdatedAt(new Date()); setRefreshError(null); }
  }, [eventId]);
  async function retryGame() {
    setLoading(true); setError(null);
    try { await fetchGame(); }
    catch (reason) { setError(msg(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    fetchGame(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(msg(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fetchGame]);
  useAdaptivePoll({enabled:!!game&&isLive,week:scheduleGame.week,currentWeek,live:isLive,load:signal=>fetchGame(signal),onError:()=>setRefreshError('Game refresh unavailable.')});
  const market = visibleMarket(scheduleGame);
  return <div className="sf-nfl-detail" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();close();}}}>
    <header className="sf-section-heading"><div><h3>Game details</h3><span>NFL · Week {scheduleGame.week}</span></div><button type="button" className="icon-button" aria-label="Close NFL game details" onClick={close}><X size={18}/></button></header>
    {loading && !game ? <div className="sf-detail-loading skeleton" role="status" aria-label="Loading real NFL game details"/> : error && !game ? <div className="sf-empty" role="alert"><p>Game details unavailable right now.</p><button className="button" onClick={retryGame}><RefreshCw size={14}/> Retry</button></div> : game && <>
      <div className="sf-nfl-detail-context"><span>{game.status.description}{game.status.state==='in' && ` · ${clockLabel(game)}`}</span><span><Clock3 size={13}/>{date(game.kickoff)}</span>{scheduleGame.venue?.name && <span><MapPin size={13}/>{scheduleGame.venue.name}{scheduleGame.venue.indoor ? ' · Indoors' : ''}</span>}<small>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}` : ''}</small></div>
      {refreshError && <p className="sf-muted" role="status">Game refresh unavailable. Showing the last successful data.</p>}
      {market && <div className="sf-market-source"><strong>Market source</strong><span>{market.source} · {market.market_state}</span><span>Retrieved {date(market.retrieved_at)}</span><span>{market.event_identifier} · normalized from market prices</span>{market.source_url && <a href={market.source_url} target="_blank" rel="noreferrer">View source <ExternalLink size={12}/></a>}</div>}
      <details className="sf-nfl-boxscore" open={game.status.state!=='pre'}><summary>Team statistics &amp; game leaders</summary><div className="sf-nfl-stat-columns">{[game.away_team,game.home_team].map((team,index)=><section key={team?.team_id??index}><h3>{team?.name||'Team unavailable'}</h3>{team?.statistics?.length ? <dl>{team.statistics.map(stat=><div key={stat.name}><dt>{stat.label||stat.name}</dt><dd>{stat.display_value??'Unavailable'}</dd></div>)}</dl> : <p>Statistics not yet published.</p>}</section>)}</div><div className="sf-nfl-leader-columns">{game.leaders.length ? game.leaders.map((team,index)=><section key={`${team.abbreviation}-${index}`}><h3>{team.team_name||team.abbreviation||'Team'}</h3>{team.categories.map(category=><div className="sf-nfl-leader-category" key={category.name}><h4>{category.name}</h4>{category.leaders.map(leader=><div key={leader.player_id??leader.name}><strong>{leader.name}</strong><span>{leader.display_value||points(leader.value)}</span></div>)}</div>)}</section>) : <p>Game leaders not yet published.</p>}</div></details>
    </>}
  </div>;
}

export default function NFLSchedulePanel() {
  const [schedule, setSchedule] = useState<NFLSchedule | null>(null);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [gameId, setGameId] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [revision, setRevision] = useState(0);
  const week = selectedWeek ?? schedule?.current_week ?? null;
  const isLive = schedule?.games.some(game => game.status.state === 'in') ?? false;

  const loadWeek = useCallback(async (target: number | null, signal?: AbortSignal) => {
    const data = await fetchBackend<NFLSchedule>(`/nfl/schedule${target === null ? '' : `?week=${target}`}`, signal);
    if (!signal?.aborted) { setSchedule(data); setUpdatedAt(new Date()); setRefreshError(null); }
    return data;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    loadWeek(selectedWeek, controller.signal).then(data => {
      if (!controller.signal.aborted && selectedWeek === null) setSelectedWeek(data.current_week);
    }).catch(reason => {
      if (!controller.signal.aborted) {
        if (schedule) {
          setRefreshError(msg(reason));
          // If a selected week cannot be fetched, return to the last week whose
          // ESPN data actually loaded so the panel never implies stale games
          // belong to the newly selected week.
          setSelectedWeek(schedule.week);
        }
        else setError(msg(reason));
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [selectedWeek, revision, loadWeek]);

  useAdaptivePoll({enabled:!!schedule&&!loading,week:selectedWeek??schedule?.week,currentWeek:schedule?.current_week,live:isLive,upcoming:schedule?.games.some(game=>game.status.state==='pre')??false,load:signal=>loadWeek(schedule!.week,signal),onError:()=>setRefreshError('Schedule refresh unavailable.')});

  async function manualRefresh() {
    setRefreshing(true);
    try { await loadWeek(week); } catch (reason) { setRefreshError(msg(reason)); }
    finally { setRefreshing(false); }
  }
  function changeWeek(value: number) { setGameId(null); setSelectedWeek(Math.max(1, Math.min(18, value))); }
  const displaySchedule = schedule && schedule.week === week ? schedule : null;
  const weekIndex = week ?? 0;

  const dayGroups = displaySchedule ? groupGamesByDay(displaySchedule.games) : [];

  function closeDetails() {
    const opener = gameId ? document.getElementById(`sf-nfl-opener-${gameId}`) : null;
    setGameId(null);
    opener?.focus({preventScroll:true});
  }
  return <div className="sf-page sf-nfl"><header className="sf-page-heading"><div><h1>NFL schedule</h1><p>{displaySchedule ? `${displaySchedule.season} · Week ${displaySchedule.week} · ${displaySchedule.games.length} games` : 'Real games. Every score.'}</p></div><div className="sf-nfl-actions"><span>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}` : ''}</span><button className="button" onClick={manualRefresh} disabled={refreshing}><RefreshCw size={14}/> {refreshing?'Refreshing':'Refresh'}</button></div></header>
    {schedule && <nav className="sf-nfl-week-control" aria-label="NFL week navigation"><button type="button" onClick={()=>changeWeek(weekIndex-1)} disabled={weekIndex<=1} aria-label="Previous NFL week"><ArrowLeft size={15}/></button><label><span className="sr-only">NFL week</span><select aria-label="Select NFL week" value={week??schedule.current_week} onChange={event=>changeWeek(Number(event.target.value))}>{Array.from({length:schedule.last_week},(_,i)=>i+1).map(value=><option key={value} value={value}>Week {value}{value===schedule.current_week?' · Current':''}</option>)}</select></label><button type="button" onClick={()=>changeWeek(weekIndex+1)} disabled={weekIndex>=schedule.last_week} aria-label="Next NFL week"><ArrowRight size={15}/></button>{week!==schedule.current_week&&<button type="button" className="sf-current-shortcut" onClick={()=>changeWeek(schedule.current_week)}>Current week</button>}<span>NFL games · market probabilities</span></nav>}
    {refreshError && <p className="sf-muted" role="status">Schedule refresh unavailable. Showing the last successful week.</p>}
    {loading&&!displaySchedule ? <ScoreSkeleton mode="nfl"/> : error&&!displaySchedule ? <div className="sf-empty" role="alert"><CalendarDays size={24}/><h2>NFL schedule unavailable</h2><button className="button" onClick={()=>setRevision(value=>value+1)}><RefreshCw size={14}/> Retry</button></div> : displaySchedule && (displaySchedule.games.length ? <ResultSequence identity={`${displaySchedule.week}:${displaySchedule.games.map(row=>row.event_id).join(',')}`} className="sf-nfl-days">{dayGroups.map(group=><section className="sf-nfl-day" key={group.title}><header><h2>{group.title.split(',')[0]}</h2><p>{group.title.split(',').slice(1).join(',').trim()}</p><span>{group.games.length} {group.games.length===1?'game':'games'}</span></header><div className="sf-nfl-games">{group.games.map(game=><Fragment key={game.event_id}><NflGameTile game={game} expanded={gameId===game.event_id} open={()=>setGameId(current=>current===game.event_id?null:game.event_id)}/><SmoothScoreReveal open={gameId===game.event_id} id={`sf-nfl-detail-${game.event_id}`} label={`${game.away_team.name} at ${game.home_team.name} details`}><GameDetails eventId={game.event_id} scheduleGame={game} currentWeek={displaySchedule.current_week} close={closeDetails}/></SmoothScoreReveal></Fragment>)}</div></section>)}</ResultSequence> : <section className="sf-empty"><CalendarDays size={24}/><h2>No games listed</h2><p>ESPN has not listed games for NFL Week {displaySchedule.week}.</p></section>)}
    {displaySchedule?.teams_on_bye.length ? <section className="sf-nfl-byes"><strong>On bye</strong><span>{displaySchedule.teams_on_bye.map(team=>`${team.abbreviation} · ${team.name}`).join(' / ')}</span></section> : null}
  </div>;
}
