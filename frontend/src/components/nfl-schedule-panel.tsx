'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Clock3, RefreshCw, X } from 'lucide-react';
import { fetchBackend } from '@/lib/api';
import { NFLGame, NFLGameDetail, NFLSchedule, points } from '@/lib/types';

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
  if (!kickoff) return 'DATE UNAVAILABLE';
  const value = new Date(kickoff);
  if (Number.isNaN(value.getTime())) return 'DATE UNAVAILABLE';
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
  const market = game.market_probability;
  if (!market || game.status.state === 'post') return null;
  const away = Math.max(0, Math.min(1, market.away_probability));
  const home = Math.max(0, Math.min(1, market.home_probability));
  const awayColor = validColor(game.away_team.primary_color, '#777');
  const homeColor = validColor(game.home_team.primary_color, '#999');
  return <div className="nfl-market-block">
    <div className="nfl-market-labels"><span><b>{game.away_team.abbreviation}</b> {Math.round(away * 100)}%</span><span className="nfl-market-caption">MARKET</span><span>{Math.round(home * 100)}% <b>{game.home_team.abbreviation}</b></span></div>
    <div className="nfl-market-bar" role="img" aria-label={`${market.source} market: ${game.away_team.name} ${Math.round(away * 100)} percent, ${game.home_team.name} ${Math.round(home * 100)} percent`} style={{ '--away-color': awayColor, '--home-color': homeColor, '--away-probability': `${away * 100}%`, background: `linear-gradient(90deg,${awayColor} 0 ${away * 100}%,${homeColor} ${away * 100}% 100%)` } as React.CSSProperties}>
      <i className="nfl-market-football" aria-hidden="true"><svg viewBox="0 0 32 20"><path d="M2 10c4-5.4 9-8 14-8s10 2.6 14 8c-4 5.4-9 8-14 8S6 15.4 2 10Z"/><path className="football-seam" d="M9 5.2c4 2.2 10 7.4 14 9.6M10.5 13.4l2-2.3m1.1 4.2 2-2.3m1.1 4.1 2-2.3"/></svg></i>
    </div>
    <details className="nfl-market-details"><summary>Market details</summary><p>{market.source} · {market.market_state} · retrieved {new Date(market.retrieved_at).toLocaleString()}</p><p>{market.event_identifier} · normalized from market prices</p></details>
  </div>;
}

function NflGameTile({ game, open }: { game: NFLGame; open: () => void }) {
  const state = game.status.state || 'unknown';
  const final = state === 'post';
  const live = state === 'in';
  const awayWinner = final && game.away_team.score != null && game.home_team.score != null && game.away_team.score > game.home_team.score;
  const homeWinner = final && game.away_team.score != null && game.home_team.score != null && game.home_team.score > game.away_team.score;
  const tied = final && game.away_team.score != null && game.away_team.score === game.home_team.score;
  const awayLoser = final && !awayWinner && !tied;
  const homeLoser = final && !homeWinner && !tied;
  return <article className={`nfl-game-tile state-${state}`} style={{ '--away-color': validColor(game.away_team.primary_color), '--home-color': validColor(game.home_team.primary_color) } as React.CSSProperties}>
    <button type="button" className="nfl-game-main" onClick={open} aria-label={`View ${game.away_team.name} at ${game.home_team.name} game details`}>
      <div className="nfl-game-kicker">
        {live ? <span className="nfl-state-live"><i/> LIVE · {clockLabel(game)}</span> : final ? <span className="nfl-state-final">FINAL</span> : <span className="nfl-kickoff">{kickoffLabel(game.kickoff)}</span>}
      </div>
      <div className="nfl-game-teams">
        <div className={`nfl-game-team away ${awayWinner ? 'winner' : ''} ${awayLoser ? 'loser' : ''} ${tied ? 'tied' : ''}`} style={{ '--nfl-team-color': validColor(game.away_team.primary_color) } as React.CSSProperties}>
          <NFLTeamMark team={game.away_team}/><div className="nfl-game-team-copy"><strong>{game.away_team.name}</strong><span>{game.away_team.abbreviation}</span></div>
          {(live || final) && <b className="nfl-game-score">{score(game.away_team.score)}</b>}
        </div>
        <div className="nfl-at-mark">{final ? '—' : live ? '·' : 'AT'}</div>
        <div className={`nfl-game-team home ${homeWinner ? 'winner' : ''} ${homeLoser ? 'loser' : ''} ${tied ? 'tied' : ''}`} style={{ '--nfl-team-color': validColor(game.home_team.primary_color) } as React.CSSProperties}>
          <NFLTeamMark team={game.home_team}/><div className="nfl-game-team-copy"><strong>{game.home_team.name}</strong><span>{game.home_team.abbreviation}</span></div>
          {(live || final) && <b className="nfl-game-score">{score(game.home_team.score)}</b>}
        </div>
      </div>
    </button>
    {!final && game.market_probability ? <NflMarketBar game={game}/> : null}
    {!final && !game.market_probability ? <p className="nfl-market-unavailable">Market unavailable</p> : null}
  </article>;
}

function GameDetails({ eventId, close }: { eventId: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
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
  useEffect(() => {
    if (!game) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try { await fetchGame(controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setRefreshError(msg(reason)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, isLive ? 30_000 : 60_000); }
    };
    timer = setTimeout(poll, isLive ? 30_000 : 60_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [game !== null, isLive, fetchGame]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="details-dialog nfl-game-dialog" ref={dialog} onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }} aria-labelledby="nfl-game-detail-title"><div className="dialog-inner">
    <div className="dialog-top"><div><span className="eyebrow">NFL GAME · WEEK {game?.week ?? '--'}</span><h2 id="nfl-game-detail-title">Game details</h2></div><button className="icon-button" aria-label="Close NFL game details" onClick={() => { dialog.current?.close(); close(); }}><X size={20}/></button></div>
    {loading && !game ? <div className="skeleton h-48" role="status" aria-label="Loading real NFL game details"/> : error && !game ? <div className="error-card" role="alert"><p>{error}</p><button className="button" onClick={retryGame}><RefreshCw size={14}/> Retry</button></div> : game && <>
      <div className="nfl-detail-scoreline"><div><span>{game.away_team?.abbreviation || '--'} · Away</span><h3>{game.away_team?.name || 'Unavailable'}</h3></div><strong>{score(game.away_team?.score)} <i>–</i> {score(game.home_team?.score)}</strong><div className="home-detail-team"><span>{game.home_team?.abbreviation || '--'} · Home</span><h3>{game.home_team?.name || 'Unavailable'}</h3></div></div>
      <div className="nfl-detail-meta"><span>{game.status.description}{game.status.state === 'in' && ` · ${clockLabel(game)}`}</span><span><Clock3 size={13}/>{date(game.kickoff)}</span><span className="timestamp">{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : 'Not updated yet'}</span></div>
      {refreshError && <div className="refresh-warning" role="status">Refresh failed: {refreshError} Showing the last successful ESPN game data.</div>}
      <section className="nfl-detail-section"><div className="player-panel-title"><div><span className="eyebrow">ESPN BOX SCORE</span><h2>Team statistics</h2></div></div>{[game.away_team, game.home_team].map((team, index) => <div className="nfl-team-stat-block" key={team?.team_id ?? index}><h3>{team?.name || 'Unavailable'} <span>{team?.abbreviation || '--'}</span></h3>{team?.statistics?.length ? <div className="nfl-team-stats-grid">{team.statistics.map(stat => <div className="nfl-team-stat" key={stat.name}><span>{stat.label || stat.name}</span><strong>{stat.display_value ?? 'Unavailable'}</strong></div>)}</div> : <p className="player-unavailable">Unavailable from ESPN for this game.</p>}</div>)}</section>
      <section className="nfl-detail-section"><div className="player-panel-title"><div><span className="eyebrow">ESPN GAME LEADERS</span><h2>Player leaders</h2></div></div>{game.leaders.length ? <div className="nfl-leaders-grid">{game.leaders.map((team, ti) => <article className="nfl-leader-team" key={`${team.abbreviation}-${ti}`}><h3>{team.team_name || team.abbreviation || 'Team'}</h3>{team.categories.map(category => <div className="nfl-leader-category" key={category.name}><span>{category.name}</span>{category.leaders.length ? category.leaders.map(leader => <div className="nfl-leader-row" key={leader.player_id ?? leader.name}><strong>{leader.name}</strong><span>{leader.display_value || points(leader.value)}</span></div>) : <div className="nfl-leader-row muted">Unavailable</div>}</div>)}</article>)}</div> : <p className="player-unavailable">ESPN has not published player leaders for this game.</p>}</section>
    </>}
  </div></dialog>;
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

  useEffect(() => {
    if (!schedule || loading || (selectedWeek !== null && selectedWeek !== schedule.week)) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try { await loadWeek(schedule.week, controller.signal); }
      catch (reason) { if (!controller.signal.aborted) setRefreshError(msg(reason)); }
      finally { if (!controller.signal.aborted) timer = setTimeout(poll, isLive ? 30_000 : 60_000); }
    };
    timer = setTimeout(poll, isLive ? 30_000 : 60_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [schedule !== null, schedule?.week, loading, selectedWeek, isLive, loadWeek]);

  async function manualRefresh() {
    setRefreshing(true);
    try { await loadWeek(week); } catch (reason) { setRefreshError(msg(reason)); }
    finally { setRefreshing(false); }
  }
  function changeWeek(value: number) { setGameId(null); setSelectedWeek(Math.max(1, Math.min(18, value))); }
  const displaySchedule = schedule && schedule.week === week ? schedule : null;
  const weekIndex = week ?? 0;

  const dayGroups = displaySchedule ? groupGamesByDay(displaySchedule.games) : [];

  return <div className="feature-page nfl-schedule-page">
    <header className="nfl-schedule-heading">
      <div><span className="eyebrow">REAL NFL · {displaySchedule?.season ?? schedule?.season ?? 'REGULAR SEASON'}</span><h1>NFL Schedule</h1><p>{displaySchedule ? `${displaySchedule.games.length} games` : 'Actual NFL games, scores, and kickoff times.'}</p></div>
      <div className="nfl-schedule-actions"><span className="timestamp"><Clock3 size={13}/>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : 'Not updated yet'}</span><button className="button" onClick={manualRefresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/> Refresh</button></div>
    </header>
    {schedule && <nav className="nfl-week-nav" aria-label="NFL week navigation">
      <button type="button" className="nfl-week-neighbor" onClick={() => changeWeek(weekIndex - 1)} disabled={weekIndex <= 1}><ArrowLeft size={15}/><span>Week {weekIndex - 1}</span></button>
      <div className="nfl-week-current"><span>WEEK {week ?? '--'}</span>{week === schedule.current_week && <small>CURRENT</small>}</div>
      <button type="button" className="nfl-week-neighbor" onClick={() => changeWeek(weekIndex + 1)} disabled={weekIndex >= schedule.last_week}><span>Week {weekIndex + 1}</span><ArrowRight size={15}/></button>
      {week !== schedule.current_week && <button type="button" className="nfl-current-shortcut" onClick={() => changeWeek(schedule.current_week)}>Current week</button>}
    </nav>}
    {refreshError && <div className="refresh-warning" role="status">NFL schedule refresh failed: {refreshError}. Showing the last successful schedule.</div>}
    {loading && !displaySchedule ? <div className="nfl-day-board">{[0,1,2,3].map(item => <div className="skeleton h-44" key={item}/>)}</div> : error && !displaySchedule ? <div className="error-card" role="alert"><CalendarDays size={26}/><h2>NFL schedule unavailable</h2><p>{error}</p><button className="button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/> Retry</button></div> : displaySchedule && (displaySchedule.games.length ? <div className="nfl-day-board">{dayGroups.map(group => <section className="nfl-day-section" key={group.title}><header><h2>{group.title}</h2><span>{group.games.length} {group.games.length === 1 ? 'GAME' : 'GAMES'}</span></header><div className="nfl-day-games">{group.games.map(game => <NflGameTile game={game} key={game.event_id} open={() => setGameId(game.event_id)}/>)}</div></section>)}</div> : <section className="nfl-no-games"><CalendarDays size={24}/><div><h2>No games listed</h2><p>ESPN has not listed regular-season games for NFL Week {displaySchedule.week}.</p></div></section>)}
    {displaySchedule?.teams_on_bye.length ? <section className="nfl-bye-row"><strong>BYE</strong><span>{displaySchedule.teams_on_bye.map(team => `${team.abbreviation} · ${team.name}`).join('  /  ')}</span></section> : null}
    {gameId && <GameDetails key={gameId} eventId={gameId} close={() => setGameId(null)}/>}
  </div>;
}
