'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fetchBackend } from '@/lib/api';
import { FantasyMatchup, FantasyMatchups, FantasyPredictions, League, LeagueProjections, PlayerProjectionRecord, points } from '@/lib/types';
import { teamAccentColor } from './prediction-bar';
import { LeagueMatchupsPanel, MatchupDetailDialog } from './league-matchups-panel';

function ProjectionAudit({ data, loading, error }: { data: LeagueProjections | null; loading: boolean; error: string | null }) {
  const groups = new Map<number, PlayerProjectionRecord[]>();
  for (const record of data?.players ?? []) {
    if (record.fantasy_team_id == null) continue;
    groups.set(record.fantasy_team_id, [...(groups.get(record.fantasy_team_id) ?? []), record]);
  }
  return <section className="projection-engine-panel"><div className="projection-engine-head"><div><span className="eyebrow">PLAYER OUTCOME MODEL · FANTASY ROSTERS</span><h2>Player projection engine</h2><p>ESPN projections updated with real game history and separately sourced NFL context. Adjustment rows include their evidence and source.</p></div><span className="timestamp">{data ? `Updated ${new Date(data.last_updated).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : loading ? 'Loading ESPN history…' : 'Unavailable'}</span></div>
    {error && <p className="projection-fetch-error" role="status">Projection refresh failed: {error}{data ? ' Showing the last successful data.' : ''}</p>}
    {loading && !data ? <div className="skeleton h-24"/> : !data ? <div className="player-unavailable">{error || 'No real ESPN projections are available for this week.'}</div> : <details className="projection-audit"><summary>Inspect projections and supported adjustments · {data.player_count} league-rostered players</summary><p className="projection-audit-model">{data.model}</p><div className="projection-source-status">{Object.entries(data.source_status?.sources ?? {}).map(([name,source])=><span key={name} className={source.available ? source.stale ? 'source-stale' : 'source-ready' : 'source-unavailable'}>{name.replaceAll('_',' ')} · {source.available ? source.stale ? 'stale' : 'available' : 'unavailable'}{source.source_updated_at ? ` · source ${source.source_updated_at}` : ''}</span>)}</div><div className="projection-groups">{Array.from(groups.entries()).map(([teamId, records]) => <section className="projection-group" key={teamId}><h3 style={{ '--team-accent': teamAccentColor(teamId) } as React.CSSProperties}>{records[0]?.player.fantasy_team_name || `Fantasy team ${teamId}`}</h3>{records.map(record => <article className="projection-player-row" key={record.player_id}><div className="projection-player-ident"><Link href={`/players/${record.player_id}`}>{record.player.name}</Link><span>{record.player.position || '--'} · {record.player.nfl_team || '--'} · {record.is_starter ? record.player.lineup_slot || 'Starter' : record.player.lineup_status}</span></div><div><span>ESPN</span><strong>{points(record.projection.espn_projection)}</strong></div><div><span>Our model</span><strong>{points(record.projection.our_projection)}</strong></div><div><span>Floor / median / ceiling</span><strong>{record.projection.floor == null || record.projection.ceiling == null ? '--' : `${record.projection.floor.toFixed(1)} / ${points(record.projection.median)} / ${record.projection.ceiling.toFixed(1)}`}</strong></div><div><span>Confidence</span><strong className={`confidence-${record.projection.confidence}`}>{record.projection.confidence}</strong></div><div className="projection-row-adjustments">{record.projection.adjustments.length ? record.projection.adjustments.map(adjustment => <span key={adjustment.key} title={`${adjustment.evidence} Source: ${adjustment.source}`}>{adjustment.label} {adjustment.adjustment > 0 ? '+' : ''}{adjustment.adjustment.toFixed(2)}</span>) : <span>No supported adjustment</span>}</div><details className="projection-player-context"><summary>Why this projection?</summary>{record.projection.adjustments.map(item=><p key={item.key}><strong>{item.label} {item.adjustment > 0 ? '+' : ''}{item.adjustment.toFixed(2)}:</strong> {item.evidence} <span>Source: {item.source}</span></p>)}{record.projection.unavailable_factors.map(item=><p key={item.key}><strong>{item.label} unavailable:</strong> {item.reason}</p>)}</details></article>)}</section>)}</div></details>}
  </section>;
}

export default function PredictionsPanel({ league, week, matchups, predictions, liveTeamIds, loading, error, onWeekChange, onRetry }: {
  league: League;
  week: number;
  matchups: FantasyMatchups | null;
  predictions: FantasyPredictions | null;
  liveTeamIds: number[] | null;
  loading: boolean;
  error: string | null;
  onWeekChange: (week: number | null) => void;
  onRetry: () => void;
}) {
  const weeks = league.fantasy_weeks;
  const [selectedMatchup, setSelectedMatchup] = useState<FantasyMatchup | null>(null);
  const predictionById = new Map((predictions?.predictions ?? []).map(item => [item.fantasy_matchup_id, item]));
  const [leagueProjections, setLeagueProjections] = useState<LeagueProjections | null>(null);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [projectionLoading, setProjectionLoading] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setProjectionLoading(!leagueProjections || leagueProjections.week !== week);
    const refresh = async () => {
      try {
        const data = await fetchBackend<LeagueProjections>(`/projections?week=${week}`, controller.signal);
        if (!controller.signal.aborted) { setLeagueProjections(data); setProjectionError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) setProjectionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) { setProjectionLoading(false); timer = setTimeout(refresh, 60_000); }
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [week, matchups?.league_id]);
  const projectionWeek = leagueProjections?.week === week ? leagueProjections : null;
  return <>
    {loading ? <div className="prediction-loading" role="status"><div className="skeleton h-40"/><div className="skeleton h-40"/><span>Loading real ESPN fantasy matchup data and simulations…</span></div> : error ? <section className="error-card" role="alert"><h2>Fantasy matchups could not be loaded</h2><p>{error}</p><button className="button" onClick={onRetry}>Retry</button></section> : !matchups || !predictions ? <section className="panel empty">No prediction data is available for fantasy week {week}.</section> : matchups.fantasy_matchups.length === 0 ? <section className="panel empty">ESPN has not published fantasy matchups for week {week}.</section> : <LeagueMatchupsPanel mode="predictions" matchups={matchups} predictions={predictions} myTeamId={matchups.my_team_id} week={week} currentWeek={league.current_week} liveTeamIds={liveTeamIds} weeks={weeks} onWeekChange={onWeekChange} onDetails={setSelectedMatchup}/>}
    <details className="projection-audit-shell"><summary>Player projection details {projectionWeek ? `· ${projectionWeek.player_count} league-rostered players` : ''}</summary><ProjectionAudit data={projectionWeek} loading={projectionLoading} error={projectionError}/></details>
    {selectedMatchup && <MatchupDetailDialog matchup={selectedMatchup} prediction={predictionById.get(selectedMatchup.fantasy_matchup_id)} close={() => setSelectedMatchup(null)} week={week} currentWeek={league.current_week} liveTeamIds={liveTeamIds}/>}
  </>;
}
