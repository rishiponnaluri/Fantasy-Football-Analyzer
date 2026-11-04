'use client';
import { PlayerProjection } from './player-projection';
import { useProjectionUpdate } from '@/lib/use-projection-update';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Clock3, RefreshCw } from 'lucide-react';
import { canonicalProjection, refreshProjectionSnapshot, fetchBackend } from '@/lib/api';
import { League, PlayerGame, StartSitDecision, StartSitPlayer, StartSitResponse, points } from '@/lib/types';
import { liveRefreshIntervalMs } from '@/lib/live-refresh.mjs';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';
import { PlayerOpen, PlayerAsset, ResultSequence, MarketSkeleton, playerField } from './living-future-ui';
import { AnimatedPoints } from './player-board-cards';
import { ConfidenceDefinitions, ProjectionConfidenceNote, ProjectionDisagreementNote } from './projection-explanation';

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function average(games: PlayerGame[] | undefined) {
  const scores = (games || []).map(game => game.fantasy_points).filter((value): value is number => typeof value === 'number');
  return scores.length ? scores.reduce((total, value) => total + value, 0) / scores.length : null;
}
function usage(player: StartSitPlayer) {
  return Object.entries(player.recent_usage || {}).map(([name, value]) => `${name.replaceAll('_', ' ')} ${value}`).join(' · ') || 'Recent usage details are unavailable.';
}
function slotLabel(slot: string | null | undefined) {
  if (!slot) return 'Bench';
  const normalized = slot.toUpperCase();
  if (normalized === 'RB/WR/TE' || normalized === 'RB/WR' || normalized === 'WR/TE' || normalized === 'FLEX') return 'FLEX';
  return normalized;
}

function DecisionPlayer({ player, title, slot }: { player: StartSitPlayer; title: string; slot?: string | null }) {
  return <PlayerAsset player={player} label={title}><span className="lf-decision-slot">{slot && slotLabel(slot)}{player.nfl_opponent ? ` · vs ${player.nfl_opponent}` : ''}</span></PlayerAsset>;
}

function LineupRow({ player, slot, index, side }: { player: StartSitPlayer; slot: string; index: number; side: 'starter' | 'bench' }) {
  const recent = average(player.last_3_games);
  const confidence = player.projection_confidence || 'Low';
  const accent = player.nfl_team_color && /^[\da-f]{6}$/i.test(player.nfl_team_color) ? `#${player.nfl_team_color}` : '#77786f';
  return <article className={`lf-lineup-module lf-surface lf-lineup-${side}`} data-pointer-reactive data-lf-reveal style={playerField(player)} data-testid={`start-sit-${side}`}>
    <div className="lineup-slot-flag"><span>{slotLabel(slot)}</span>{side === 'starter' && <i aria-hidden="true"/>}</div>
    <PlayerAvatar player={player} size="lg" />
    <div className="lineup-sheet-player">
      <PlayerOpen player={player} className="lineup-sheet-name"/>
      <span className="lineup-sheet-meta">{player.nfl_team || '--'}{player.nfl_opponent ? ` · vs ${player.nfl_opponent}` : player.bye_week === player.week ? ' · BYE' : ' · Opponent unavailable'} · {player.position || '--'}</span>
      <PlayerStatusButton player={player} />
    </div>
    <div className="lineup-sheet-score"><PlayerProjection player={player}><AnimatedPoints value={canonicalProjection(player)}/></PlayerProjection><span>Projection</span></div>
    <span className={`lineup-data-confidence confidence-${confidence.toLowerCase()}`} title={`Projection data confidence: ${confidence}. This indicates how reliable the player's projection is.`}>{confidence}</span>
    <details className="lineup-row-details">
      <summary aria-label={`View details for ${player.name}`}>View details</summary>
      <div className="lineup-row-detail-content">
        <div className="lineup-detail-numbers"><span>Projection <b><PlayerProjection player={player}/></b></span><span>ESPN <b><PlayerProjection player={player} value={player.custom_projection?.espn_projection ?? player.projected_fantasy_points}/></b></span><span>Likely range <b><PlayerProjection player={player} value={player.floor}/> – <PlayerProjection player={player} value={player.ceiling}/></b></span><span>Recent avg <b>{points(recent)}</b></span></div>
        <p className="lineup-detail-reason">{player.recommendation_reason}</p>
        <p className="lineup-detail-usage">Recent usage: {usage(player)}</p>
        <details className="lineup-advanced-details"><summary>Advanced model details</summary><ConfidenceDefinitions/><ProjectionConfidenceNote confidence={player.custom_projection?.confidence} basis={player.custom_projection?.confidence_basis}/><ProjectionDisagreementNote value={player.model_disagreement}/><p>Median estimate: <PlayerProjection player={player} value={player.median}/> · ESPN lineup slot: {player.lineup_slot || 'Unavailable'}</p></details>
      </div>
    </details>
  </article>;
}

function ChangeMovement({ change }: { change: StartSitResponse['lineup_changes']['slot_changes'] extends (infer T)[] | undefined ? T : never }) {
  const from = slotLabel(change.current_slot);
  const to = slotLabel(change.recommended_slot);
  const isUp = to !== 'Bench';
  return <div className="lineup-movement"><span className={`lineup-movement-icon ${isUp ? 'up' : 'down'}`}>{isUp ? <ArrowUp size={14}/> : <ArrowDown size={14}/>}</span><strong>{change.name}</strong><span>{from}</span><ArrowRight size={13}/><span>{to}</span></div>;
}

function DecisionFeature({ data }: { data: StartSitResponse }) {
  const candidate = useMemo(() => {
    const decisions = data.lineup_changes.decisions || [];
    return decisions.find(item => item.confidence === 'high') || decisions.find(item => item.confidence === 'medium') || decisions[0] || null;
  }, [data.lineup_changes.decisions]);
  const decision = candidate as StartSitDecision | null;
  const strong = !!decision && decision.confidence !== 'low';
  const hasSwap = !!decision && decision.start.player_id !== decision.bench.player_id;
  return <section className={`lf-decision-engine ${strong ? 'has-recommendation' : 'is-close-call'}`} aria-label="Suggested lineup change">
    <div className="lf-section-heading"><h2>{strong ? 'Your next decision' : 'A closer look'}</h2><span>{strong ? 'Suggested change' : 'Close decision'}</span></div>
    {decision && hasSwap ? <>
      <div className="lf-decision-comparison">
        <DecisionPlayer player={decision.start} title={decision.confidence === 'low' ? 'LEAN START' : 'START'} slot={decision.start_slot} />
        <div className="lf-decision-center lf-surface" data-pointer-reactive><span>{decision.confidence === 'low' ? 'Close call' : 'Recommended'}</span><h3>Start {decision.start.name}</h3><strong>+{points(decision.expected_advantage)}<small>projected edge</small></strong><span className={`decision-confidence confidence-${decision.confidence}`}>{decision.confidence} confidence</span></div>
        <DecisionPlayer player={decision.bench} title="BENCH" slot={decision.bench_slot} />
      </div>
      <div className="start-sit-feature-bottom"><span className={`decision-confidence confidence-${decision.confidence}`}>{decision.confidence.toUpperCase()} CONFIDENCE</span><span>{decision.confidence_reasons?.[0] || decision.reason || 'The projections and player information are close.'}</span></div>
      <details className="start-sit-feature-details"><summary>See why</summary><p>{decision.reason || decision.start.recommendation_reason}</p>{decision.confidence_reasons?.length ? <ul>{decision.confidence_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}<div className="feature-source-values"><span>Projections <b><PlayerProjection player={decision.start}/> vs <PlayerProjection player={decision.bench}/></b></span><span>Expected advantage <b>{points(decision.expected_advantage)} pts</b></span><span>Decision confidence <b>{decision.confidence}</b></span></div></details>
    </> : <div className="no-swap-feature"><div><h2>{data.unfilled_slots.length ? 'Your lineup has an unfilled spot.' : data.lineup_changes.toss_up_count ? 'Your current lineup is a reasonable choice.' : 'No clear lineup change this week.'}</h2><p>{data.unfilled_slots.length ? 'The available starters are shown below. Fill the missing slot before setting your lineup.' : data.lineup_changes.toss_up_count ? 'The projections are close, so you can stick with the players you have in.' : 'Your best starting lineup is already set based on the information available.'}</p></div><strong>{points(data.recommended_projected_total)}<small>projected lineup</small></strong></div>}
    {data.lineup_changes.start.length > 0 && data.lineup_changes.bench.length > 0 && <div className="lineup-total-gain">Your best starting lineup projects about <strong>{points(data.lineup_changes.improvement_points)} points</strong> higher.</div>}
  </section>;
}

export default function StartSitPanel({ league, liveTeamIds }: { league: League; liveTeamIds: number[] | null }) {
  const [week, setWeek] = useState(league.current_week);
  const [data, setData] = useState<StartSitResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useProjectionUpdate(() => setRevision(n => n + 1));
  const liveMode = liveTeamIds === null ? 'unknown' : liveTeamIds.length ? 'live' : 'idle';
  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await fetchBackend<StartSitResponse>(`/start-sit?week=${week}`, signal);
    if (!signal?.aborted) { setData(result); setError(null); setRefreshError(null); }
  }, [week]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(!data || data.week !== week);
    if (!data || data.week !== week) setError(null);
    load(controller.signal).catch(reason => {
      if (controller.signal.aborted) return;
      if (data?.week === week) setRefreshError(errorText(reason)); else setError(errorText(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, revision]);



  async function refresh() {
    setRefreshing(true);
    try { await refreshProjectionSnapshot(week); await load(); } catch (reason) { setRefreshError(errorText(reason)); }
    finally { setRefreshing(false); }
  }

  const slotCount = data ? Object.values(data.scoring_rules.position_slot_counts).reduce((sum, count) => sum + count, 0) : 0;
  const slotOrder = ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX', 'K', 'D/ST'];
  const starters = [...(data?.recommended_starters || [])].sort((a, b) => {
    const rank = (player: StartSitPlayer) => { const index = slotOrder.indexOf(slotLabel(player.recommended_slot_label || player.recommended_slot || player.position)); return index < 0 ? 99 : index; };
    return rank(a) - rank(b);
  });
  const bench = data?.bench || [];
  const moves = data?.lineup_changes.slot_changes || [];

  return <div className="lf-page lf-start-sit">
    <header className="lf-page-heading"><div><h1>Start / sit</h1><p>Compare the options. Set your strongest nine.</p></div><div className="start-sit-head-actions"><label className="start-sit-week-select"><span className="sr-only">Fantasy week</span><select id="start-sit-week" value={week} onChange={event => setWeek(Number(event.target.value))}>{league.fantasy_weeks.map(item => <option key={item} value={item}>Week {item}{item === league.current_week ? ' · Current' : ''}</option>)}</select></label><button className="button" onClick={refresh} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/> Refresh</button></div></header>
    <div className="start-sit-update-line"><span><Clock3 size={12}/>{data ? `Updated ${new Date(data.last_updated).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}` : 'Not updated yet'}</span><span>{liveMode === 'live' ? 'Live refresh · 30 sec' : 'Refresh · 2 min'}</span></div>
    {refreshError && <div className="refresh-warning" role="status">Refresh unavailable. Showing the last successful lineup advice.</div>}
    {loading && (!data || data.week !== week) ? <MarketSkeleton label="Comparing eligible starters…" count={3} kind="comparison"/> : error && (!data || data.week !== week) ? <div className="error-card" role="alert"><AlertTriangle size={25}/><h2>Start/Sit advice unavailable</h2><p>Lineup advice is unavailable right now. Please try again.</p><button className="button" onClick={() => setRevision(value => value + 1)}>Retry</button></div> : data && data.week === week && <>
      {data.unfilled_slots.length > 0 && <div className="refresh-warning" role="status"><AlertTriangle size={14} aria-hidden="true"/><span>{data.unfilled_slots.map(slot => `No eligible ${slot} available`).join(' · ')}. Lineup incomplete: {starters.length} / {slotCount} spots filled.</span></div>}
      <DecisionFeature data={data}/>
      {moves.length > 0 && <details className="lineup-moves-section"><summary>What changes? · {moves.length} players move slots</summary><div className="lineup-movement-list">{moves.map(change=><ChangeMovement key={change.player_id} change={change}/>)}</div></details>}
      <div className="lineup-board-heading"><div><h2>Your best lineup</h2></div><div className="lineup-legality"><span className={data.legal_lineup ? 'legal' : 'needs-attention'}>{data.legal_lineup ? 'ESPN lineup rules' : 'Some lineup spots need attention'}</span><b>{starters.length} / {slotCount} spots filled</b></div></div>
      <ResultSequence identity={starters.map(player => `${player.player_id}:${player.recommended_slot_label}`).join(',')} className="lf-best-lineup"><section className="lf-starter-board" aria-label="Recommended starting lineup">{starters.length ? starters.map((player, index) => <LineupRow key={player.player_id} player={player} slot={player.recommended_slot_label || player.recommended_slot || player.position || '--'} index={index} side="starter"/>) : <p className="player-unavailable">No starter recommendations could be calculated from available real player data.</p>}</section></ResultSequence>
      {bench.length > 0 && <section className="lineup-bench-section"><div className="lineup-section-heading"><div><h2>Bench</h2></div><span>{bench.length} players</span></div><div className="lf-bench-board">{bench.map((player,index)=><LineupRow key={player.player_id} player={player} slot="Bench" index={index} side="bench"/>)}</div></section>}
      <section className="lineup-scoring-footer"><div><strong>{points(data.current_projected_total)}</strong><span>Current projected lineup</span><i>→</i><strong>{points(data.recommended_projected_total)}</strong><span>Best starting lineup</span></div><details><summary>How this is calculated</summary><p>{data.model} Starting spots use your actual ESPN league settings.</p><p>{Object.entries(data.scoring_rules.position_slot_counts).map(([slot,count]) => `${slot === 'RB/WR/TE' ? 'FLEX (RB/WR/TE)' : slot} × ${count}`).join(' · ') || 'Lineup settings unavailable'}</p><details className="lineup-advanced-details"><summary>Advanced scoring details</summary><p>Scoring format: {data.scoring_rules.scoring_type} · ESPN player rank: {data.scoring_rules.player_rank_type || 'Unavailable'}</p><div className="scoring-rules-list">{data.scoring_rules.scoring_format.map(rule=><span key={rule.stat_id}><i>{rule.label || `Stat ${rule.stat_id}`}</i><b>{rule.points == null ? '--' : `${rule.points} pts`}{Object.keys(rule.points_overrides || {}).length > 0 && <small> · {Object.entries(rule.points_overrides).map(([key,value])=>`${key}: ${value} pts`).join(', ')}</small>}</b></span>)}</div></details></details></section>
    </>}
  </div>;
}
