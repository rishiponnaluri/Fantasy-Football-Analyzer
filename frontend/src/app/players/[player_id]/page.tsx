'use client';
import { PlayerProjection, usePlayerBye, useCurrentFantasyWeek } from '@/components/player-projection';
import { useProjectionUpdate } from '@/lib/use-projection-update';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowLeft, CalendarDays, Clock3, Shield } from 'lucide-react';
import { canonicalProjection, fetchBackend } from '@/lib/api';
import { NFLLiveStatus, Player, PlayerGame, points } from '@/lib/types';
import { useAdaptivePoll } from '@/lib/use-adaptive-poll';
import { PlayerAvatar, PlayerStatusButton, TeamLogo } from '@/components/player-quick-view';
import AnalysisPanel from '@/components/analysis-panel';
import { ProjectionConfidenceNote } from '@/components/projection-explanation';

const statGroups: Record<string, [string, string][]> = {
  QB: [['passingCompletions','Completions'],['passingAttempts','Attempts'],['passingYards','Passing yards'],['passingTouchdowns','Passing TDs'],['passingInterceptions','Interceptions'],['rushingAttempts','Rushing attempts'],['rushingYards','Rushing yards'],['rushingTouchdowns','Rushing TDs']],
  RB: [['rushingAttempts','Carries'],['rushingYards','Rushing yards'],['rushingTouchdowns','Rushing TDs'],['receivingTargets','Targets'],['receivingReceptions','Receptions'],['receivingYards','Receiving yards'],['receivingTouchdowns','Receiving TDs']],
  WR: [['receivingTargets','Targets'],['receivingReceptions','Receptions'],['receivingYards','Receiving yards'],['receivingTouchdowns','Receiving TDs'],['rushingAttempts','Rushing attempts'],['rushingYards','Rushing yards'],['rushingTouchdowns','Rushing TDs']],
  TE: [['receivingTargets','Targets'],['receivingReceptions','Receptions'],['receivingYards','Receiving yards'],['receivingTouchdowns','Receiving TDs'],['rushingAttempts','Rushing attempts'],['rushingYards','Rushing yards'],['rushingTouchdowns','Rushing TDs']],
  K: [['attemptedFieldGoals','FG attempts'],['madeFieldGoals','FG made'],['madeFieldGoalsFromUnder40','FG made <40'],['madeFieldGoalsFrom40To49','FG made 40–49'],['madeFieldGoalsFrom50Plus','FG made 50+'],['attemptedExtraPoints','XP attempts'],['madeExtraPoints','XP made']],
  'D/ST': [['defensiveSacks','Sacks'],['defensiveInterceptions','Interceptions'],['defensiveFumbles','Fumble recoveries'],['defensiveBlockedKicks','Blocked kicks'],['defensiveSafeties','Safeties'],['defensiveTouchdowns','Defensive TDs'],['kickoffReturnTouchdowns','Kick return TDs'],['puntReturnTouchdowns','Punt return TDs']],
};
const statLabel: Record<string, string> = Object.fromEntries(Object.values(statGroups).flat().map(([key,label]) => [key,label]));
function GameStats({ stats, position }: { stats: Record<string, number> | undefined; position: string | null }) {
  const fields = statGroups[position || ''] || Object.entries(stats || {}).map(([key]) => [key, statLabel[key] || key] as [string,string]);
  return <div className="player-stats-grid">{fields.map(([key,label]) => <div className="player-stat" key={key}><span>{label}</span><strong>{stats && typeof stats[key] === 'number' ? stats[key] : '--'}</strong></div>)}</div>;
}
function GameLog({ games, position }: { games: PlayerGame[] | undefined; position: string | null }) {
  if (!games?.length) return <p className="player-unavailable">Unavailable from ESPN for this season.</p>;
  const stats = statGroups[position || ''] || [];
  const keys = (stats.length ? stats.map(([key]) => key) : Object.keys(games.at(-1)?.stats || {})).filter(key => games.some(game => typeof game.stats?.[key] === 'number'));
  return <div className="table-scroll"><table className="player-game-log"><thead><tr><th>Week</th><th className="numeric">Fantasy pts</th><th className="numeric">ESPN projection</th>{keys.map(key => <th className="numeric" key={key}>{statLabel[key] || key}</th>)}</tr></thead><tbody>{games.map(game => <tr key={game.week}><td>Week {game.week}</td><td className="numeric">{points(game.fantasy_points)}</td><td className="numeric">{points(game.projected_fantasy_points)}</td>{keys.map(key => <td className="numeric" key={key}>{typeof game.stats[key] === 'number' ? game.stats[key] : '--'}</td>)}</tr>)}</tbody></table></div>;
}
function fantasyRates(games: PlayerGame[], position: string | null, seasonAverage: number | null | undefined) {
  const keys = (statGroups[position || ''] || []).map(([key,label]) => [key,label] as [string,string]);
  const rows = keys.map(([key,label]) => {
    const values = games.map(game => game.stats?.[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length ? { label: `${label} / game`, value: values.reduce((sum,value)=>sum+value,0)/values.length } : null;
  }).filter((value): value is {label:string;value:number} => value !== null);
  if (typeof seasonAverage === 'number') rows.unshift({ label: 'Fantasy points / game', value: seasonAverage });
  const stats = Object.fromEntries(keys.map(([key]) => [key, games.map(game=>game.stats?.[key]).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value))]));
  if (position === 'QB' && stats.passingAttempts?.length && stats.passingCompletions?.length) {
    const attempts = stats.passingAttempts.reduce((a,b)=>a+b,0); const completions=stats.passingCompletions.reduce((a,b)=>a+b,0);
    if (attempts > 0) rows.push({label:'Completion %',value:100*completions/attempts});
  }
  if (position === 'RB' && stats.rushingAttempts?.length && stats.rushingYards?.length) {
    const carries=stats.rushingAttempts.reduce((a,b)=>a+b,0); const yards=stats.rushingYards.reduce((a,b)=>a+b,0);
    if (carries > 0) rows.push({label:'Yards / carry',value:yards/carries});
  }
  return rows;
}
function PlayerLoading() { return <div className="player-detail-loading"><span className="skeleton h-10 w-56"/><span className="skeleton h-5 w-80 max-w-full"/><div className="player-stats-grid">{Array.from({length:8},(_,i)=><span key={i} className="skeleton h-24"/>)}</div></div>; }

export default function PlayerDetailsPage() {
  const params = useParams<{ player_id: string }>();
  const playerId = params.player_id;
  const validId = useMemo(() => /^-?\d+$/.test(playerId) && Number(playerId) !== 0, [playerId]);
  const [player, setPlayer] = useState<Player | null>(null);
  const [liveTeamIds, setLiveTeamIds] = useState<number[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useProjectionUpdate(() => setRevision(n => n + 1));
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<'Overview' | 'Game Log' | 'Matchup' | 'News'>('Overview');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const person = await fetchBackend<Player>(`/players/${playerId}`, signal);
    if (signal?.aborted) return;
    setPlayer(person);
    setUpdatedAt(new Date());
    setRefreshError(previous => previous?.startsWith('Player refresh failed:') ? null : previous);
  }, [playerId]);
  useEffect(() => {
    const controller = new AbortController();
    if (!validId) { setError('The player ID in this URL is invalid.'); setLoading(false); return () => controller.abort(); }
    setLoading(true); setError(null);
    refresh(controller.signal).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh, validId, revision]);
  const live = liveTeamIds?.includes(player?.nfl_team_id ?? -1) ?? false;
  const currentWeek=useCurrentFantasyWeek();
  const bye=usePlayerBye(player??{});
  useEffect(()=>{const controller=new AbortController();void fetchBackend<NFLLiveStatus>('/nfl/live-status',controller.signal).then(status=>{if(!controller.signal.aborted)setLiveTeamIds(status.current_week!=null&&status.current_week!==player?.week?[]:status.in_progress_team_ids);}).catch(()=>{});return()=>controller.abort();},[player?.week]);
  useAdaptivePoll({enabled:!!player&&!loading&&!error&&!bye,week:player?.week,currentWeek,live,upcoming:!!player?.nfl_game_time&&new Date(player.nfl_game_time).getTime()>Date.now(),load:async(signal)=>{
    const status=await fetchBackend<NFLLiveStatus>('/nfl/live-status',signal);
    await refresh(signal);
    if(!signal.aborted)setLiveTeamIds(status.current_week!=null&&status.current_week!==player?.week?[]:status.in_progress_team_ids);
  },onError:()=>setRefreshError('Player refresh failed. Showing the last successful data.')});
  const games = player?.game_log || [];
  if (loading) return <main className="player-detail-shell"><PlayerLoading/></main>;
  if (error || !player) return <main className="player-detail-shell"><Link className="button back-link" href="/"><ArrowLeft size={15}/> Back to dashboard</Link><section className="player-error" role="alert"><Activity size={25}/><h1>Player details unavailable</h1><p>{error || 'ESPN did not return this player.'}</p><button className="button" onClick={() => setRevision(value => value + 1)}>Retry</button></section></main>;
  return <><main className="player-detail-shell player-profile-page">
    <div className="player-detail-top"><Link className="button back-link" href="/"><ArrowLeft size={15}/> Back to league</Link><span className="timestamp"><Clock3 size={13}/>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : 'Not updated yet'}</span></div>
    {refreshError && <div className="refresh-warning" role="status">{refreshError} Showing the last successful ESPN player data.</div>}
    <section className="player-hero" style={{'--player-team-color': player.nfl_team_color ? `#${player.nfl_team_color}` : '#292b25'} as React.CSSProperties}>{player.nfl_team_logo_url && <img className="player-hero-mark" src={player.nfl_team_logo_url} alt="" aria-hidden="true"/>}<div className="player-hero-identity"><PlayerAvatar player={player} size="lg"/><div className="player-hero-copy"><span className="eyebrow">{player.nfl_team || 'NFL player'} · WEEK {player.custom_projection?.week ?? player.week}</span><h1>{player.name}</h1><p>{player.position || 'Position unavailable'} · {player.nfl_team || 'NFL team unavailable'}{player.jersey_number != null ? ` · #${player.jersey_number}` : ''}</p><p>{player.nfl_opponent ? `vs ${player.nfl_opponent}` : 'Opponent unavailable'} · {player.nfl_game_time ? new Date(player.nfl_game_time).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Kickoff unavailable'} · Bye W{player.bye_week ?? '--'}</p><div className="player-hero-status"><PlayerStatusButton player={player}/>{live && <span className="live-indicator"><i/> LIVE</span>}</div></div></div>{player.position === 'D/ST' && <TeamLogo player={player} className="player-banner-logo"/>}</section>
    <div className="player-summary-featured"><article className="summary-lead"><span>Projection</span><strong><PlayerProjection player={player}/></strong><span>How much to expect this week</span></article><article className="summary-metric"><span>ESPN</span><strong><PlayerProjection player={player} value={player.custom_projection?.espn_projection}/></strong></article><article className="summary-metric"><span>Week rank</span><strong>{player.rankings?.week_our_projection ? `${player.position || ''} #${player.rankings.week_our_projection.position}` : '--'}</strong></article><article className="summary-metric"><span>Season PPG</span><strong>{points(player.season_fantasy_average)}</strong></article><div className="summary-range"><span>Floor · Median · Ceiling</span><strong><PlayerProjection player={player} value={player.custom_projection?.floor}/> <i>—</i> <PlayerProjection player={player} value={player.custom_projection?.median}/> <i>—</i> <PlayerProjection player={player} value={player.custom_projection?.ceiling}/></strong><ProjectionConfidenceNote confidence={player.custom_projection?.confidence} basis={player.custom_projection?.confidence_basis}/></div></div>
    <nav className="profile-tabs" role="tablist" aria-label="Player profile sections">{(['Overview','Game Log','Matchup','News'] as const).map(name=><button key={name} role="tab" type="button" aria-selected={profileTab===name} className={profileTab===name?'active':''} onClick={()=>setProfileTab(name)}>{name}</button>)}</nav>
    <section className="player-detail-panel projection-panel" hidden={profileTab!=='Matchup'}><div className="player-panel-title"><div><span className="eyebrow">CUSTOM PLAYER MODEL · WEEK {player.custom_projection?.week ?? player.week}</span><h2>Projection and matchup inputs</h2></div><span className={`projection-confidence confidence-${player.custom_projection?.confidence || 'low'}`}>{player.custom_projection?.confidence || 'Unavailable'} data confidence</span></div>
      <div className="projection-outcomes">{[{label:'ESPN projection',value:player.custom_projection?.espn_projection},{label:'Projection',value:canonicalProjection(player)},{label:'Floor · 10th pct',value:player.custom_projection?.floor},{label:'Median',value:player.custom_projection?.median},{label:'Ceiling · 90th pct',value:player.custom_projection?.ceiling},{label:'Scoring variation',value:player.custom_projection?.standard_deviation}].map(item=><div className="projection-outcome" key={item.label}><span>{item.label}</span><strong><PlayerProjection player={player} value={item.value}/></strong></div>)}</div>
      <details className="projection-model-note"><summary>How this was calculated</summary><p>ESPN is one input. Earlier game results update the estimate and help measure the player&apos;s likely scoring range.</p><ProjectionConfidenceNote confidence={player.custom_projection?.confidence} basis={player.custom_projection?.confidence_basis}/></details>
      {player.custom_projection?.adjustments.length ? <div className="projection-adjustments"><h3>Supported adjustments</h3>{player.custom_projection.adjustments.map(item=><div className="projection-adjustment" key={item.key}><div><strong>{item.label}</strong><b className={item.adjustment < 0 ? 'negative' : ''}>{item.adjustment > 0 ? '+' : ''}{item.adjustment.toFixed(2)}</b></div><p>{item.evidence}</p><small>Source: {item.source}</small></div>)}</div> : <p className="player-unavailable">No numerical adjustments are supported by the available ESPN history for this player and week.</p>}
      {player.custom_projection?.context_events.map((event,index)=><p className="projection-event" key={`${event.event_type || event.kind}-${index}`}><strong>{(event.event_type || event.kind || 'Context event').replaceAll('_',' ')}</strong>: {event.detail?.report_status ? `Report status: ${String(event.detail.report_status)}.` : ''} {event.detail?.practice_status ? `Practice: ${String(event.detail.practice_status)}.` : ''} {event.detail?.depth_chart_position ? `Roster position: ${String(event.detail.depth_chart_position)}.` : ''} {event.projection_effect || event.affected_metric || ''} <small>Source: {event.source}{event.timestamp ? ` · source updated ${event.timestamp}` : ''}</small></p>)}
      {player.custom_projection?.projection_context ? <details className="projection-unavailable"><summary>Real context inputs and source evidence</summary>{Object.entries(player.custom_projection.projection_context).map(([key,value])=><p key={key}><strong>{key.replaceAll('_',' ')}:</strong> {value && typeof value === 'object' && 'reason' in value ? String(value.reason) : JSON.stringify(value)}</p>)}</details> : null}
      {player.custom_projection?.unavailable_factors.length ? <details className="projection-unavailable"><summary>Inputs not available from current sources</summary>{player.custom_projection.unavailable_factors.map(item=><p key={item.key}><strong>{item.label}:</strong> {item.reason}</p>)}</details> : null}
    </section>
    <section className="player-detail-panel" hidden={profileTab!=='Overview'}><div className="player-panel-title"><div><span className="eyebrow">FANTASY RANKINGS · ESPN LEAGUE ROSTERS</span><h2>Positional and overall rank</h2></div></div><div className="player-game-info">{[
        ['Season points', player.rankings?.season_points], ['Points per game', player.rankings?.points_per_game], [`Week ${player.week} custom projection`, player.rankings?.week_our_projection],
      ].map(([label, rank]) => { const value = rank as { position: number; overall: number; scope: string } | null | undefined; return <div key={String(label)}><span>{String(label)}</span><strong>{value ? `#${value.position} ${player.position || ''} · #${value.overall} overall` : 'Unavailable'}</strong></div>; })}</div><p className="data-note">Ranks compare ESPN players rostered in this fantasy league and use the league&apos;s ESPN scoring totals. Tied scores share the same rank.</p></section>
    <section className="player-detail-panel" hidden={profileTab!=='News'}><div className="player-panel-title"><div><span className="eyebrow">PLAYER NEWS · STRUCTURED NFL CONTEXT</span><h2>Recent relevant updates</h2></div></div>{player.news?.length ? <div className="quick-view-news">{player.news.map((item,index)=><article key={`${item.source}-${index}`}><strong>{item.headline}</strong><p>{item.summary}</p><small>{item.source || 'Source unavailable'}{item.timestamp ? ` · ${item.timestamp}` : ''}</small>{item.url && <a href={item.url} target="_blank" rel="noreferrer">Read source →</a>}</article>)}</div> : <p className="player-unavailable">No recent relevant news</p>}</section>
    <section className="player-detail-panel" hidden={profileTab!=='Overview'}><div className="player-panel-title"><div><span className="eyebrow">FANTASY OUTLOOK · WEEK {player.custom_projection?.week ?? player.week}</span><h2>Projection and decision context</h2></div><span className={`projection-confidence confidence-${player.custom_projection?.confidence || 'low'}`}>{player.custom_projection?.confidence || 'Unavailable'} data confidence</span></div>{bye ? <p className="fantasy-outlook-copy">No NFL game is scheduled for this team in Week {player.week}.</p> : <p className="fantasy-outlook-copy">The projection is <PlayerProjection player={player}/> points versus ESPN&apos;s <PlayerProjection player={player} value={player.custom_projection?.espn_projection}/>. Likely range: <PlayerProjection player={player} value={player.custom_projection?.floor}/>–<PlayerProjection player={player} value={player.custom_projection?.ceiling}/>.</p>}<ProjectionConfidenceNote confidence={player.custom_projection?.confidence} basis={player.custom_projection?.confidence_basis}/>{player.custom_projection?.adjustments?.length ? <details className="fantasy-outlook-factors"><summary>Why the projection moved</summary><ul>{player.custom_projection.adjustments.map(item=><li key={item.key} className={item.adjustment<0?'negative':''}>{item.label} {item.adjustment>0?'+':''}{item.adjustment.toFixed(2)} — {item.evidence}</li>)}</ul></details> : <p className="player-unavailable">No supported adjustment is available for this week.</p>}</section>
    <section className="player-detail-panel" hidden={profileTab!=='Overview'}><div className="player-panel-title"><div><span className="eyebrow">SEASON ROLE & PRODUCTION</span><h2>Fantasy-relevant averages per game</h2></div></div>{fantasyRates(games, player.position, player.season_fantasy_average).length ? <div className="player-stats-grid">{fantasyRates(games, player.position, player.season_fantasy_average).map(item=><div className="player-stat" key={item.label}><span>{item.label}</span><strong>{item.value.toFixed(1)}</strong></div>)}</div> : <p className="player-unavailable">Unavailable from real game logs.</p>}</section>
    <section className="player-detail-panel" hidden={profileTab!=='Matchup'}><div className="player-panel-title"><div><span className="eyebrow">NFL GAME INFORMATION</span><h2>Next game</h2></div><CalendarDays size={18}/></div><div className="player-game-info"><div><span>Upcoming NFL opponent</span><strong>{player.nfl_opponent || '--'}</strong></div><div><span>Game time</span><strong>{player.nfl_game_time ? new Date(player.nfl_game_time).toLocaleString() : 'Unavailable'}</strong></div><div><span>Bye week</span><strong>{player.bye_week ?? '--'}</strong></div><div><span>Injury / status</span><strong>{player.injury_status || 'Unavailable'}</strong></div></div></section>
    <section className="player-detail-panel" hidden={profileTab!=='Game Log'}><div className="player-panel-title"><div><span className="eyebrow">WEEK {player.week}</span><h2>Current NFL statistics</h2></div><span className="muted text-sm">ESPN player card</span></div><GameStats stats={player.game_stats} position={player.position}/></section>
    <section className="player-detail-panel" hidden={profileTab!=='Game Log'}><div className="player-panel-title"><div><span className="eyebrow">RECENT FORM</span><h2>Last 3 games</h2></div><span className="muted text-sm">ESPN NFL game log</span></div><GameLog games={player.last_3_games} position={player.position}/></section>
    <section className="player-detail-panel" hidden={profileTab!=='Game Log'}><div className="player-panel-title"><div><span className="eyebrow">RECENT FORM</span><h2>Last 5 games</h2></div></div><GameLog games={player.last_5_games} position={player.position}/></section>
    <section className="player-detail-panel" hidden={profileTab!=='Game Log'}><div className="player-panel-title"><div><span className="eyebrow">SEASON</span><h2>Full season game log</h2></div><span className="muted text-sm">{games.length} ESPN scoring weeks</span></div><GameLog games={games} position={player.position}/></section>
    <p className="data-note"><Clock3 size={14}/> Updated {updatedAt?.toLocaleString() || 'Unavailable'} · Missing values reflect fields not supplied by ESPN.</p>
  </main><AnalysisPanel page={`Player profile · ${player.name}`} week={player.week} playerId={player.player_id}/></>;
}
