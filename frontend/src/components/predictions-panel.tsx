'use client';
import { PlayerProjection } from './player-projection';
import { useProjectionUpdate } from '@/lib/use-projection-update';

import { useEffect, useRef, useState } from 'react';
import { fetchBackend } from '@/lib/api';
import { FantasyMatchup, FantasyMatchups, FantasyPredictions, League, LeagueProjections, PlayerProjectionRecord, FantasyPredictionSide, MatchupPrediction, points } from '@/lib/types';
import { teamAccentColor } from './prediction-bar';
import { FantasyIdentity, FantasyProbability, FantasyMatchupDetails, SwingPlayerAssets } from './league-matchups-panel';
import { ScoreWeekControl, ScoreSkeleton, SmoothScoreReveal } from './score-space-ui';
import { PlayerOpen, ResultSequence } from './living-future-ui';
import { opponentFirst, predictionSides, liveIdsForWeek } from '@/lib/score-display.mjs';
import { ChevronDown, ChevronUp } from 'lucide-react';

function ProjectionAudit({ data, loading, error }: { data: LeagueProjections | null; loading: boolean; error: string | null }) {
  const groups = new Map<number, PlayerProjectionRecord[]>();
  for (const record of data?.players ?? []) {
    if (record.fantasy_team_id == null) continue;
    groups.set(record.fantasy_team_id, [...(groups.get(record.fantasy_team_id) ?? []), record]);
  }
  return <section className="projection-engine-panel"><div className="projection-engine-head"><div><h2>Player projection engine</h2><p>ESPN projections updated with real game history and separately sourced NFL context. Adjustment rows include their evidence and source.</p></div><span className="timestamp">{data ? `Updated ${new Date(data.last_updated).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}` : loading ? 'Loading ESPN history…' : 'Unavailable'}</span></div>
    {error && <p className="projection-fetch-error" role="status">Projection details temporarily unavailable.{data ? ' Showing the last successful data.' : ''}</p>}
    {loading && !data ? <div className="skeleton h-24"/> : !data ? <div className="player-unavailable">{'No projection details are available for this week.'}</div> : <details className="projection-audit"><summary>Inspect projections and supported adjustments · {data.player_count} league-rostered players</summary><p className="projection-audit-model">{data.model}</p><div className="projection-source-status">{Object.entries(data.source_status?.sources ?? {}).map(([name,source])=><span key={name} className={source.available ? source.stale ? 'source-stale' : 'source-ready' : 'source-unavailable'}>{name.replaceAll('_',' ')} · {source.available ? source.stale ? 'stale' : 'available' : 'unavailable'}{source.source_updated_at ? ` · source ${source.source_updated_at}` : ''}</span>)}</div><div className="projection-groups">{Array.from(groups.entries()).map(([teamId, records]) => <section className="projection-group" key={teamId}><h3 style={{ '--team-accent': teamAccentColor(teamId) } as React.CSSProperties}>{records[0]?.player.fantasy_team_name || `Fantasy team ${teamId}`}</h3>{records.map(record => <article className="projection-player-row" key={record.player_id}><div className="projection-player-ident"><PlayerOpen player={record.player}/><span>{record.player.position || '--'} · {record.player.nfl_team || '--'} · {record.is_starter ? record.player.lineup_slot || 'Starter' : record.player.lineup_status}</span></div><div><span>ESPN</span><strong><PlayerProjection player={record.player} week={data.week} value={record.projection.espn_projection}/></strong></div><div><span>Projection</span><strong><PlayerProjection player={record.player} week={data.week} value={record.projection.recommendation_projection}/></strong></div><div><span>Floor / median / ceiling</span><strong><PlayerProjection player={record.player} week={data.week}>{record.projection.floor == null || record.projection.ceiling == null ? '--' : `${record.projection.floor.toFixed(1)} / ${points(record.projection.median)} / ${record.projection.ceiling.toFixed(1)}`}</PlayerProjection></strong></div><div><span>Confidence</span><strong className={`confidence-${record.projection.confidence}`}>{record.projection.confidence}</strong></div><div className="projection-row-adjustments">{record.projection.adjustments.length ? record.projection.adjustments.map(adjustment => <span key={adjustment.key} title={`${adjustment.evidence} Source: ${adjustment.source}`}>{adjustment.label} {adjustment.adjustment > 0 ? '+' : ''}{adjustment.adjustment.toFixed(2)}</span>) : <span>No supported adjustment</span>}</div><details className="projection-player-context"><summary>Why this projection?</summary>{record.projection.adjustments.map(item=><p key={item.key}><strong>{item.label} {item.adjustment > 0 ? '+' : ''}{item.adjustment.toFixed(2)}:</strong> {item.evidence} <span>Source: {item.source}</span></p>)}{record.projection.unavailable_factors.map(item=><p key={item.key}><strong>{item.label} unavailable:</strong> {item.reason}</p>)}</details></article>)}</section>)}</div></details>}
  </section>;
}


function ModelRanges({ sides }: { sides: { team: NonNullable<FantasyMatchup['home_team']>; result?: FantasyPredictionSide }[] }) {
  const available = sides.filter(row => row.result?.score_percentiles && Object.values(row.result.score_percentiles).every(Number.isFinite));
  if (!available.length) return null;
  const low = Math.min(...available.map(row => row.result!.score_percentiles.p10));
  const high = Math.max(...available.map(row => row.result!.score_percentiles.p90));
  const pos = (value: number) => high === low ? 50 : (value-low)/(high-low)*100;
  return <section className="sf-model-ranges"><div className="sf-section-heading"><h3>Possible finishes</h3><span>Simulation percentiles</span></div><div className="sf-range-scale"><span>{low.toFixed(1)}</span><span>Fantasy points</span><span>{high.toFixed(1)}</span></div>{available.map(({team,result}) => {
    const p = result!.score_percentiles;
    return <div className="sf-range-row" key={team.team_id} style={{ '--sf-team': teamAccentColor(team.team_id,team.primary_color) } as React.CSSProperties}><div><strong>{team.team_name}</strong><span>{p.p10.toFixed(1)}–{p.p90.toFixed(1)}<small>10th–90th percentile</small></span></div><div className="sf-range-track" role="img" aria-label={`${team.team_name}: 10th percentile ${p.p10.toFixed(1)}, 25th ${p.p25.toFixed(1)}, median ${p.median.toFixed(1)}, 75th ${p.p75.toFixed(1)}, 90th ${p.p90.toFixed(1)} points`}><i className="sf-range-outer" style={{left:`${pos(p.p10)}%`,width:`${pos(p.p90)-pos(p.p10)}%`}}/><i className="sf-range-inner" style={{left:`${pos(p.p25)}%`,width:`${pos(p.p75)-pos(p.p25)}%`}}/><b style={{left:`${pos(p.median)}%`}}/></div></div>;
  })}<p className="sf-range-key"><i/> Central 50% <b/> Median <span>Wider band: 10th–90th percentile. Ranges are estimates, not guarantees.</span></p></section>;
}

function ModelFocus({ matchup, prediction, myTeamId }: { matchup: FantasyMatchup; prediction?: MatchupPrediction; myTeamId:number }) {
  const view = opponentFirst(matchup,myTeamId);
  const mapped = predictionSides(view,prediction);
  const sides = [{team:view.home_team,result:mapped.home,chance:mapped.homeWin},{team:view.away_team,result:mapped.away,chance:mapped.awayWin}].filter(row => row.team !== null) as { team:NonNullable<FantasyMatchup['home_team']>;result?:FantasyPredictionSide;chance?:number }[];
  const available = prediction?.status !== 'unavailable' && sides.length===2 && sides.every(row=>typeof row.chance==='number');
  const favored = available ? sides.reduce((a,b)=>(a.chance!>b.chance! ? a:b)) : null;
  const tied = available && sides[0].chance===sides[1].chance;
  const gap = sides.length===2 && sides.every(row=>typeof row.result?.expected_final_score==='number') ? Math.abs(sides[0].result!.expected_final_score-sides[1].result!.expected_final_score) : null;
  return <div className="sf-model-focus" key={matchup.fantasy_matchup_id}><section className="sf-model-field sf-split-surface" data-pointer-reactive style={{'--sf-left':teamAccentColor(view.home_team?.team_id,view.home_team?.primary_color),'--sf-right':teamAccentColor(view.away_team?.team_id,view.away_team?.primary_color)} as React.CSSProperties}><div className="sf-model-answer"><span>Model outlook</span><h2>{tied ? 'An even matchup' : favored ? <>{favored.team.team_name} <span>is favored</span></> : 'Prediction temporarily unavailable'}</h2></div><div className="sf-model-sides">{sides.map(({team,result,chance})=><div key={team.team_id}><FantasyIdentity team={team}/><strong className="sf-model-chance">{available && typeof chance==='number' ? `${(chance*100).toFixed(1)}%` : '—'}<small>Win chance</small></strong><p>Expected finish <b>{points(result?.expected_final_score)}</b></p></div>)}</div><FantasyProbability matchup={view} prediction={prediction}/><div className="sf-model-context"><span>Projected score gap <b>{points(gap)} pts</b></span><span>{prediction?.team_a && prediction?.team_b ? `${prediction.team_a.modeled_players.length+prediction.team_b.modeled_players.length} players remaining` : 'Remaining players unavailable'}</span></div></section><ModelRanges sides={sides}/></div>;
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
  const pickerRef = useRef<HTMLDivElement>(null);
  const weeks = league.fantasy_weeks;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setSelectedId(null); setExpanded(false); }, [week]);
  const predictionById = new Map((predictions?.predictions ?? []).map(item => [item.fantasy_matchup_id, item]));
  const [projectionRevision, setProjectionRevision] = useState(0);
  useProjectionUpdate(() => setProjectionRevision(n => n + 1));
  const [leagueProjections, setLeagueProjections] = useState<LeagueProjections | null>(null);
  const [projectionError, setProjectionError] = useState<string | null>(null);
  const [projectionLoading, setProjectionLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setProjectionLoading(!leagueProjections || leagueProjections.week !== week);
    const refresh = async () => {
      try {
        const data = await fetchBackend<LeagueProjections>(`/projections?week=${week}`, controller.signal);
        if (!controller.signal.aborted) { setLeagueProjections(data); setProjectionError(null); }
      } catch (cause) {
        if (!controller.signal.aborted) setProjectionError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) { setProjectionLoading(false); }
      }
    };
    void refresh();
    return () => controller.abort();
  }, [week, matchups?.league_id, projectionRevision]);
  const projectionWeek = leagueProjections?.week === week ? leagueProjections : null;
  const candidates = matchups?.fantasy_matchups.filter(row=>!row.is_bye) || [];
  const selected = candidates.find(row=>row.fantasy_matchup_id===selectedId) || candidates.find(row=>row.involves_my_team) || candidates[0];
  const prediction = selected ? predictionById.get(selected.fantasy_matchup_id) : undefined;
  const live = liveIdsForWeek(week,league.current_week,liveTeamIds);
  useEffect(() => {
    const picker = pickerRef.current;
    const active = picker?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!picker || !active || picker.scrollWidth <= picker.clientWidth) return;
    const offset = active.getBoundingClientRect().left - picker.getBoundingClientRect().left;
    if (offset < 0 || offset + active.offsetWidth > picker.clientWidth) {
      picker.scrollTo({ left: picker.scrollLeft + offset - (picker.clientWidth - active.offsetWidth) / 2, behavior: 'instant' });
    }
  }, [selected?.fantasy_matchup_id, loading]);
  return <div className="sf-page sf-model"><header className="sf-page-heading"><div><h1>Predictions</h1><p>Explore the outcomes. Understand the uncertainty.</p></div><ScoreWeekControl week={week} currentWeek={league.current_week} weeks={weeks} onChange={onWeekChange}/></header>
    {loading ? <ScoreSkeleton mode="model"/> : error ? <section className="sf-empty" role="alert"><h2>Prediction data temporarily unavailable</h2><button className="button" onClick={onRetry}>Retry</button></section> : !selected || !predictions ? <p className="sf-empty">No prediction data is available for fantasy week {week}.</p> : <>
      <div className="sf-model-workspace"><div ref={pickerRef} className="sf-matchup-picker" role="group" aria-label="Choose fantasy matchup">{candidates.map(row=><button key={row.fantasy_matchup_id} type="button" aria-pressed={selected.fantasy_matchup_id===row.fantasy_matchup_id} onClick={()=>{setSelectedId(row.fantasy_matchup_id);setExpanded(false);}} style={{'--sf-team':teamAccentColor(row.home_team?.team_id,row.home_team?.primary_color)} as React.CSSProperties}><span>{row.home_team?.team_name || 'Team unavailable'}</span><small>vs</small><span>{row.away_team?.team_name || 'Team unavailable'}</span>{row.involves_my_team && <b>Your matchup</b>}</button>)}</div><ResultSequence identity={`${week}:${selected.fantasy_matchup_id}`} className="sf-model-main"><div data-lf-reveal><ModelFocus matchup={selected} prediction={prediction} myTeamId={matchups!.my_team_id}/></div><section className="sf-model-confidence"><div><h3>Matchup confidence</h3><strong>{prediction?.model_confidence || 'Unavailable'}</strong><p>Confidence describes the model's evidence; win chance describes the simulated outcome.</p></div><div>{prediction?.model_confidence_reasons?.map((reason,index)=><p key={index}>{reason}</p>)}</div></section></ResultSequence></div>
      <SwingPlayerAssets matchup={selected} prediction={prediction} week={week}/>
      <div className="sf-model-drilldown"><button type="button" aria-expanded={expanded} aria-controls="sf-model-lineups" onClick={()=>setExpanded(value=>!value)}>{expanded ? 'Hide player outcomes' : 'Explore player outcomes'}{expanded ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}</button><SmoothScoreReveal open={expanded} id="sf-model-lineups" label="Model player outcomes"><FantasyMatchupDetails matchup={selected} prediction={prediction} week={week} currentWeek={league.current_week} liveTeamIds={live} showSwing={false}/></SmoothScoreReveal></div>
    </>}
    <details className="projection-audit-shell"><summary>Player projection details {projectionWeek ? `· ${projectionWeek.player_count} league-rostered players` : ''}</summary><ProjectionAudit data={projectionWeek} loading={projectionLoading} error={projectionError}/></details>
  </div>;
}
