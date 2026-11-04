'use client';
import { PlayerProjection } from './player-projection';
import { FantasyTeamAvatar } from './fantasy-team-avatar';
import { useProjectionUpdate } from '@/lib/use-projection-update';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRightLeft, Check, ChevronDown, Handshake, Search, TrendingUp, X } from 'lucide-react';
import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import { canonicalProjection, fetchBackend, requestBackend } from '@/lib/api';
import { FantasyMatchups, FantasyTeam, Player, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';
import { PlayerOpen, ResultSequence, MarketSkeleton, SelectionTrack, playerField } from './living-future-ui';
import { AnimatedPoints } from './player-board-cards';
import { teamAccentColor } from './prediction-bar';

type ImpactPlayer = { player_id: number; name: string; position: string | null; nfl_team: string | null; weekly_projection: number | null; espn_projection: number | null; season_average: number | null; confidence: string | null; uncertainty: number | null; bye_week: number | null; injury_status: string | null; lineup_slot: string | null; headshot_url?: string | null; nfl_team_id?: number | null; nfl_team_logo_url?: string | null; nfl_team_color?: string | null };
type Analysis = { you_give: ImpactPlayer[]; you_receive: ImpactPlayer[]; partner_team_name?: string; partner_team_id?: number; other_team?: { team_id: number; team_name: string }; trade_category?: string; validation_type?: string; package_shape?: string; weekly_lineup_change: { you: number; other_team: number; you_before: number; you_after: number; other_before: number; other_after: number; you_starting_lineup_after: (ImpactPlayer & { recommended_slot?: string })[]; other_starting_lineup_after: (ImpactPlayer & { recommended_slot?: string })[] }; rest_of_season_change: { you: number | null; other_team: number | null; method: string }; positional_impact: Record<string, unknown>; affected_starting_lineup_slots: Record<string, unknown>; depth_impact: Record<string, unknown>; risk: Record<string, unknown>; bye_week_implications: Record<string, unknown>; model: string; plausibility?: string; plausibility_basis?: string; verdict?: { worth_it: 'YES'|'LEAN YES'|'EVEN'|'LEAN NO'|'NO'; worth_it_reason: string; worth_it_confidence?: 'HIGH'|'MEDIUM'|'LOW'; worth_it_confidence_reason?: string; acceptance_likelihood: 'HIGH'|'MEDIUM'|'LOW'|'VERY LOW'; acceptance_reason: string; weekly_uncertainty: number | null; method: string }; rest_of_season_value_fit?: { give_value: number; receive_value: number; difference: number; uncertainty: number; method: string } };
type TargetRow = { player: ImpactPlayer; team_id: number; team_name: string; analysis: Analysis & { plausibility?: string; plausibility_basis?: string; target_reason?: string }; reason: string };
type TradeIdea = Analysis & { partner_team_id?: number; partner_team_name?: string; trade_category?: string; validation_type?: string; package_shape?: string };
type TargetResponse = { trade_targets: TargetRow[]; suggestions?: TradeIdea[]; possible_trades_to_explore?: TradeIdea[]; research_trade_ideas?: TradeIdea[]; trade_categories?: Record<string, number>; best_trade_partners: { team_id: number; team_name: string; best_weekly_fit: number }[]; roster_needs: Record<string, { label: string }>; search_mode?: 'league_wide' | 'specific_team'; mode?: 'conservative' | 'balanced' | 'aggressive'; positions?: string[]; message: string | null; last_updated: string };
const targetRequestCache = new Map<string, { promise: Promise<TargetResponse>; expiresAt: number }>();
const tradePlayerOrigins = new Map<number, { left: number; top: number }>();
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'FLEX'] as const;
gsap.registerPlugin(useGSAP);

function fetchTargets(week: number, positions: string[], searchMode: 'league_wide' | 'specific_team', teamId: number, mode: 'conservative' | 'balanced' | 'aggressive') {
  const key = `${week}:${positions.slice().sort().join(',')}:${searchMode}:${teamId}:${mode}`;
  const cached = targetRequestCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const query = new URLSearchParams({ week: String(week), search_mode: searchMode, mode });
  if (searchMode === 'specific_team') query.set('team_id', String(teamId));
  positions.forEach(position => query.append('positions', position));
  const promise = fetchBackend<TargetResponse>(`/trades/discovery?${query.toString()}`);
  targetRequestCache.set(key, { promise, expiresAt: Date.now() + 45_000 });
  promise.catch(() => targetRequestCache.delete(key));
  return promise;
}

function shortWorth(value?: string) { return value || 'Review'; }
function acceptanceLabel(value?: string) { return value === 'HIGH' ? 'LIKELY' : value === 'MEDIUM' ? 'POSSIBLE' : 'UNLIKELY'; }
function teamName(analysis: Analysis) { return analysis.partner_team_name || analysis.other_team?.team_name || 'League manager'; }
function teamId(analysis: Analysis) { return analysis.partner_team_id ?? analysis.other_team?.team_id ?? -1; }
function simpleImpactReason(analysis: Analysis, side: 'you' | 'other_team' = 'you') {
  const change = analysis.weekly_lineup_change[side];
  const lineup = change > 0.05
    ? `Adds about ${points(change)} projected points per week to ${side === 'you' ? 'your' : 'their'} best starting lineup.`
    : change < -0.05
      ? `Lowers ${side === 'you' ? 'your' : 'their'} best starting lineup by about ${points(Math.abs(change))} projected points per week.`
      : `${side === 'you' ? 'Your' : 'Their'} best starting lineup stays about the same this week.`;
  const longTerm = analysis.rest_of_season_change[side];
  if (longTerm == null || Math.abs(longTerm) < 0.1) return lineup;
  const outlook = longTerm > 0
    ? ` The long-term outlook also improves.`
    : ` The long-term outlook also gets weaker.`;
  return `${lineup}${outlook}`;
}
function isFlexPosition(position: string | null) { return !!position && ['RB', 'WR', 'TE'].includes(position); }
function selectedPositionMatches(player: ImpactPlayer, selected: string[]) {
  return selected.includes(player.position || '') || (selected.includes('FLEX') && isFlexPosition(player.position));
}
function fantasyAccent(team?: FantasyTeam) { return teamAccentColor(team?.team_id, team?.primary_color); }

function FantasyTeamMark({ team, compact = false }: { team?: FantasyTeam; compact?: boolean }) {
  const [logoFailed, setLogoFailed] = useState(false);
  if (!team) return <span className="trade-fantasy-mark">--</span>;
  const color = fantasyAccent(team);
  return <div className={`trade-fantasy-identity ${compact ? 'compact' : ''}`} style={{ '--trade-fantasy-color': color } as React.CSSProperties}>
    <FantasyTeamAvatar team={team}/>
    {!compact && <div><strong>{team.team_name}</strong><small>{team.owners.map(owner => owner.displayName || owner.firstName).filter(Boolean).join(', ') || 'League team'}</small></div>}
  </div>;
}

function TradeSearchControls({ positions, onPositions, searchMode, onSearchMode, mode, onMode, teams, selectedTeam, onTeam }: {
  positions: string[]; onPositions: (positions: string[]) => void; searchMode: 'league_wide' | 'specific_team'; onSearchMode: (value: 'league_wide' | 'specific_team') => void;
  mode: 'conservative' | 'balanced' | 'aggressive'; onMode: (value: 'conservative' | 'balanced' | 'aggressive') => void; teams: FantasyTeam[]; selectedTeam?: FantasyTeam; onTeam: (id: number) => void;
}) {
  const counts = useMemo(() => Object.entries((selectedTeam?.roster || []).reduce<Record<string, number>>((all, player) => { const position = player.position || 'Other'; all[position] = (all[position] || 0) + 1; return all; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4), [selectedTeam]);
  return <section className="lf-trade-controls" aria-label="Find a trade controls">
    <div className="trade-controls-main">
      <div className="trade-control-block trade-position-control"><span className="trade-field-label">I want to improve</span><div className="trade-position-filter" role="group" aria-label="Filter trade targets by position">{POSITIONS.map(position => <button key={position} type="button" className={positions.includes(position) ? 'active' : ''} aria-pressed={positions.includes(position)} onClick={() => onPositions(positions.includes(position) ? positions.filter(item => item !== position) : [...positions, position])}>{positions.includes(position) && <Check size={12}/>} {position}</button>)}</div><div className="trade-filter-actions"><button type="button" onClick={() => onPositions([...POSITIONS])}>Select all</button><button type="button" onClick={() => onPositions([])}>Clear all</button></div></div>
      <div className="trade-control-block"><span className="trade-field-label">Search</span><div className="trade-mode-toggle" role="group" aria-label="Trade search mode"><button type="button" className={searchMode === 'league_wide' ? 'active' : ''} aria-pressed={searchMode === 'league_wide'} onClick={() => onSearchMode('league_wide')}>League wide</button><button type="button" className={searchMode === 'specific_team' ? 'active' : ''} aria-pressed={searchMode === 'specific_team'} onClick={() => onSearchMode('specific_team')}>Specific team</button></div>{searchMode === 'specific_team' && <label className="trade-manager-select"><span>Manager</span><select aria-label="Specific fantasy team" value={selectedTeam?.team_id || ''} onChange={event => onTeam(Number(event.target.value))}>{teams.map(team => <option value={team.team_id} key={team.team_id}>{team.team_name}</option>)}</select></label>}</div>
      <div className="trade-control-block"><span className="trade-field-label">Style</span><div className="trade-style-select"><select aria-label="Trade suggestion mode" value={mode} onChange={event => onMode(event.target.value as typeof mode)}><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="aggressive">Aggressive</option></select><ChevronDown size={14}/></div></div>

    </div>
    {searchMode === 'specific_team' && selectedTeam && <div className="trade-manager-preview"><FantasyTeamMark team={selectedTeam}/><div className="trade-roster-snapshot"><span>ROSTER PREVIEW</span><div>{counts.map(([position, count]) => <i key={position}>{position} <b>{count}</b></i>)}{!counts.length && <small>Roster data unavailable</small>}</div></div></div>}
    <p className="trade-controls-note">Position filters apply to every automatic deal. Manual trades can include any position.</p>
  </section>;
}

function SmallPlayer({ player, size = 'md' }: { player: ImpactPlayer; size?: 'sm' | 'md' | 'lg' }) {
  const full = player as unknown as Player;
  return <div className={`trade-identity-player lf-trade-asset lf-surface ${size}`} data-pointer-reactive style={playerField(full)}>
    <PlayerAvatar player={full} size={size === 'lg' ? 'lg' : size}/>
    <div><PlayerOpen player={full} className="trade-person-name"/><span>{player.position || '--'} · {player.nfl_team || '--'}</span><small>Projection <PlayerProjection player={player}/></small></div>
  </div>;
}

function TradeExchange({ give, receive, compact = false }: { give: ImpactPlayer[]; receive: ImpactPlayer[]; compact?: boolean }) {
  return <div className={`trade-deal-exchange ${compact ? 'compact' : ''}`}>
    <div><span className="trade-side-title">You give</span>{give.map(player => <SmallPlayer key={player.player_id} player={player} size={compact ? 'sm' : 'md'}/>)}</div>
    <span className="trade-exchange-symbol" aria-label="for"><ArrowRightLeft size={compact ? 17 : 21}/></span>
    <div><span className="trade-side-title">You get</span>{receive.map(player => <SmallPlayer key={player.player_id} player={player} size={compact ? 'sm' : 'md'}/>)}</div>
  </div>;
}

function VerdictPair({ analysis }: { analysis: Analysis }) {
  return <div className="trade-verdict-pair"><div><span>Good for you</span><strong className={`worth-${(analysis.verdict?.worth_it || 'review').toLowerCase().replaceAll(' ', '-')}`}>{shortWorth(analysis.verdict?.worth_it)}</strong>{analysis.verdict?.worth_it_confidence && <small className="trade-verdict-confidence" title={analysis.verdict.worth_it_confidence_reason}>{analysis.verdict.worth_it_confidence.toLowerCase().replace(/^./, value => value.toUpperCase())} confidence</small>}</div><div><span>They may consider it</span><strong>{acceptanceLabel(analysis.verdict?.acceptance_likelihood)}</strong></div></div>;
}

function AnalysisDetails({ analysis }: { analysis: Analysis }) {
  const change = analysis.weekly_lineup_change;
  const lineup = (players: Analysis['weekly_lineup_change']['you_starting_lineup_after']) => players.map(player => <span key={player.player_id}>{player.recommended_slot || player.lineup_slot || '--'} · {player.name} · <PlayerProjection player={player}/></span>);
  return <details className="trade-deep-details"><summary>View numbers and lineup changes <ChevronDown size={13}/></summary><div className="trade-numbers-grid"><span>Your best lineup<strong>{points(change.you_before)} → {points(change.you_after)} <small>this week</small></strong></span><span>Their best lineup<strong>{points(change.other_before)} → {points(change.other_after)} <small>this week</small></strong></span><span>Your long-term value<strong>{points(analysis.rest_of_season_change.you)}</strong></span><span>Their long-term value<strong>{points(analysis.rest_of_season_change.other_team)}</strong></span></div><div className="trade-after-lineups"><div><b>Your lineup after</b>{lineup(change.you_starting_lineup_after)}</div><div><b>Their lineup after</b>{lineup(change.other_starting_lineup_after)}</div></div><details className="trade-methodology-deep"><summary>How this was calculated</summary><p>{analysis.verdict?.method || analysis.model}</p><p>{analysis.rest_of_season_change.method}</p></details></details>;
}

function TradeTargetHero({ row, team, week, positions, searchMode }: { row: TargetRow; team?: FantasyTeam; week: number; positions: string[]; searchMode: 'league_wide' | 'specific_team' }) {
  const analysis = row.analysis;
  const target = row.player;
  const receive = analysis.you_receive.length ? analysis.you_receive : [target];
  const reasonForYou = row.reason || simpleImpactReason(analysis);
  const reasonForThem = simpleImpactReason(analysis, 'other_team');
  return <article className="lf-target-object lf-surface" data-pointer-reactive data-lf-reveal style={playerField(target as unknown as Player)}>
    <div className="lf-target-identity"><PlayerAvatar player={target as unknown as Player} size="lg"/><div><PlayerOpen player={target as unknown as Player}/><span>{target.position || '--'} · {target.nfl_team || '--'}</span><small>{row.team_name}</small></div><span className="lf-target-projection"><PlayerProjection player={target}><AnimatedPoints value={canonicalProjection(target)}/></PlayerProjection><small>Projection</small></span></div>
    <p>{reasonForYou}</p><PlayerStatusButton player={target as unknown as Player}/>
    <details className="lf-target-deal"><summary>Explore possible deal <ChevronDown size={13}/></summary><TradeExchange give={analysis.you_give} receive={receive}/><VerdictPair analysis={analysis}/><p>{reasonForThem}</p><AnalysisDetails analysis={analysis}/><button type="button" className="lf-text-action" onClick={() => window.dispatchEvent(new CustomEvent('analyzer:open', { detail: { action: 'manual-trade', tradeContext: { team_id: row.team_id, give_player_ids: analysis.you_give.map(player => player.player_id), receive_player_ids: receive.map(player => player.player_id), week, search_mode: searchMode, target_positions: positions } } }))}>Review deal <ArrowDown size={13}/></button></details>
  </article>;
}

function SuggestedDealRow({ analysis, index, teams }: { analysis: Analysis; index: number; teams: FantasyTeam[] }) {
  const partner = teams.find(team => team.team_id === teamId(analysis));
  const validated = analysis.validation_type === 'MODEL-VALIDATED' || analysis.validation_type === 'IMMEDIATE WIN-WIN';
  return <article className="lf-deal-object" data-lf-reveal>
    <span className="trade-suggested-index">{String(index + 1).padStart(2, '0')}</span>
    <div className="trade-suggested-partner"><FantasyTeamMark team={partner} compact/><span>{teamName(analysis)}</span></div>
    <TradeExchange give={analysis.you_give} receive={analysis.you_receive} compact/>
    <div className="trade-suggested-result"><VerdictPair analysis={analysis}/><p>{analysis.verdict?.worth_it_reason || simpleImpactReason(analysis)}</p><details><summary>More details <ChevronDown size={12}/></summary><p>{analysis.verdict?.acceptance_reason}</p><AnalysisDetails analysis={analysis}/></details></div>
    <span className={`trade-idea-type ${validated ? 'validated' : ''}`}>{validated ? 'MODEL-VALIDATED' : 'POSSIBLE IDEA'}</span>
  </article>;
}

function TradePlayerTile({ player, selected, onToggle }: { player: Player; selected: boolean; onToggle: () => void }) {
  const tile = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const origin = !selected ? tradePlayerOrigins.get(player.player_id) : undefined;
    if (!origin || !tile.current) return;
    tradePlayerOrigins.delete(player.player_id);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = tile.current.getBoundingClientRect();
    gsap.fromTo(tile.current,
      { x: Math.max(-160, Math.min(160, origin.left - target.left)), y: Math.max(-100, Math.min(100, origin.top - target.top)), scale: 0.96, autoAlpha: 0.65 },
      { x: 0, y: 0, scale: 1, autoAlpha: 1, duration: 0.2, ease: 'power2.out', clearProps: 'transform,opacity,visibility' },
    );
  }, { scope: tile, dependencies: [selected], revertOnUpdate: true });
  return <div ref={tile} className={`lf-trade-pick lf-surface ${selected ? 'selected' : ''}`} data-pointer-reactive style={playerField(player)}>
    <label className="lf-trade-select"><input type="checkbox" aria-label={`${selected ? 'Remove' : 'Select'} ${player.name} ${selected ? 'from' : 'for'} trade`} checked={selected} onChange={() => {
      if (!selected && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && tile.current) {
        const { left, top } = tile.current.getBoundingClientRect();
        tradePlayerOrigins.set(player.player_id, { left, top });
      } else if (selected) tradePlayerOrigins.delete(player.player_id);
      onToggle();
    }}/></label>
    <PlayerAvatar player={player} size="md"/>
    <div className="trade-pick-player"><PlayerOpen player={player}/><span>{player.position || '--'} · {player.nfl_team || '--'}{player.lineup_slot ? ` · ${player.lineup_slot}` : ''}</span><PlayerStatusButton player={player}/></div>
    <span className="lf-pick-projection"><PlayerProjection player={player}><AnimatedPoints value={canonicalProjection(player)}/></PlayerProjection><small>Projection</small></span>
    {selected && <Check className="trade-pick-check" size={15}/>}
  </div>;
}

function ManualTradeTray({ give, receive, onRemove, onAnalyze, busy }: { give: Player[]; receive: Player[]; onRemove: (side: 'give' | 'receive', id: number) => void; onAnalyze: () => void; busy: boolean }) {
  const tray = useRef<HTMLElement>(null);
  useGSAP(() => {
    const chips = tray.current?.querySelectorAll<HTMLElement>('[data-tray-player-id]');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      [...give, ...receive].forEach(player => tradePlayerOrigins.delete(player.player_id));
      return;
    }
    chips?.forEach(chip => {
      const id = Number(chip.dataset.trayPlayerId);
      const origin = tradePlayerOrigins.get(id);
      if (!origin) return;
      tradePlayerOrigins.delete(id);
      const target = chip.getBoundingClientRect();
      gsap.fromTo(chip,
        { x: Math.max(-160, Math.min(160, origin.left - target.left)), y: Math.max(-100, Math.min(100, origin.top - target.top)), scale: 0.94, autoAlpha: 0.65 },
        { x: 0, y: 0, scale: 1, autoAlpha: 1, duration: 0.2, ease: 'power2.out', clearProps: 'transform,opacity,visibility' },
      );
    });
  }, { scope: tray, dependencies: [give, receive], revertOnUpdate: true });
  if (!give.length && !receive.length) return null;
  return <aside ref={tray} className="trade-floating-tray" aria-label="Selected trade">
    <div className="trade-tray-side"><span>You give</span>{give.length ? give.map(player => <button data-tray-player-id={player.player_id} key={player.player_id} onClick={event => { if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) { const { left, top } = event.currentTarget.getBoundingClientRect(); tradePlayerOrigins.set(player.player_id, { left, top }); } onRemove('give', player.player_id); }} title={`Remove ${player.name}`}><img src={player.headshot_url || ''} alt=""/><b>{player.name}</b><X size={12}/></button>) : <small>Select from your roster</small>}</div>
    <ArrowRightLeft className="trade-tray-arrow" size={19}/>
    <div className="trade-tray-side"><span>You get</span>{receive.length ? receive.map(player => <button data-tray-player-id={player.player_id} key={player.player_id} onClick={event => { if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) { const { left, top } = event.currentTarget.getBoundingClientRect(); tradePlayerOrigins.set(player.player_id, { left, top }); } onRemove('receive', player.player_id); }} title={`Remove ${player.name}`}><img src={player.headshot_url || ''} alt=""/><b>{player.name}</b><X size={12}/></button>) : <small>Select from their roster</small>}</div>
    <button className="trade-tray-analyze" onClick={onAnalyze} disabled={busy || !give.length || !receive.length}><ArrowRightLeft size={15}/>{busy ? 'Analyzing…' : 'Analyze trade'}</button>
  </aside>;
}

function TradeVerdict({ analysis, partner, onClose }: { analysis: Analysis; partner: string; onClose: () => void }) {
  return <section className="trade-result-sheet" aria-label="Trade result" data-lf-reveal>
    <header><div><span className="trade-field-label">TRADE RESULT · {partner}</span><h2>Is this a good deal?</h2></div><button onClick={onClose} aria-label="Close trade result"><X size={17}/></button></header>
    <TradeExchange give={analysis.you_give} receive={analysis.you_receive}/><VerdictPair analysis={analysis}/>
    <div className="trade-result-reasons"><p><b>Why it helps you</b>{simpleImpactReason(analysis)}</p><p><b>Why they may accept</b>{simpleImpactReason(analysis, 'other_team')}</p></div>
    <AnalysisDetails analysis={analysis}/>
  </section>;
}

function slotFitLabel(label: string) { const normalized = label.toLowerCase(); if (normalized.includes('weak depth')) return 'Needs depth'; if (normalized.includes('weak')) return 'Could improve'; if (normalized.includes('strong')) return 'Strong'; if (normalized.includes('average')) return 'Solid'; return label; }

export default function TradeAnalyzerPanel({ data, myTeamId, week }: { data: FantasyMatchups; myTeamId: number; week: number }) {
  const teams = useMemo(() => data.fantasy_matchups.flatMap(matchup => [matchup.home_team, matchup.away_team]).filter((team): team is NonNullable<typeof team> => !!team), [data]);
  const others = teams.filter(team => team.team_id !== myTeamId);
  const [teamIdValue, setTeamIdValue] = useState<number>(others[0]?.team_id || 0);
  const [give, setGive] = useState<number[]>([]); const [receive, setReceive] = useState<number[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'conservative' | 'balanced' | 'aggressive'>('balanced');
  const [targetPositions, setTargetPositions] = useState<string[]>(['QB', 'RB', 'WR', 'TE', 'FLEX']);
  const [searchMode, setSearchMode] = useState<'league_wide' | 'specific_team'>('league_wide');
  const [targets, setTargets] = useState<TargetResponse | null>(null); const [targetLoading, setTargetLoading] = useState(true); const [targetError, setTargetError] = useState<string | null>(null); const [targetRevision, setTargetRevision] = useState(0);
  useProjectionUpdate(() => { setAnalysis(null); setTargetRevision(n => n + 1); });
  const [workspace, setWorkspace] = useState<'discover' | 'build'>('discover');
  const [mobileRoster, setMobileRoster] = useState<'you' | 'them'>('you');
  const own = teams.find(team => team.team_id === myTeamId); const opponent = teams.find(team => team.team_id === teamIdValue);
  const matches = (player: ImpactPlayer) => selectedPositionMatches(player, targetPositions);
  const visibleTargets = (targets?.trade_targets || []).filter(row => matches(row.player));
  const suggestions = (targets?.suggestions || []).filter(item => item.you_receive.some(matches));
  const possibleIdeas = (targets?.possible_trades_to_explore || []).filter(item => item.you_receive.some(matches));
  const fallbackIdeas = (targets?.research_trade_ideas || []).filter(item => item.you_receive.some(matches));
  const dealIdeas = suggestions.length ? suggestions : possibleIdeas.length ? possibleIdeas : fallbackIdeas;
  const ownNeedCopy = Object.entries(targets?.roster_needs || {}).filter(([, value]) => /weak/i.test(value.label)).map(([position]) => position);

  useEffect(() => { setGive([]); setReceive([]); setAnalysis(null); setError(null); }, [teamIdValue]);
  useEffect(() => { setGive([]); setReceive([]); setAnalysis(null); setError(null); }, [week]);
  useEffect(() => {
    const controller = new AbortController();
    if (!targetPositions.length) { setTargets({ trade_targets: [], suggestions: [], possible_trades_to_explore: [], research_trade_ideas: [], best_trade_partners: [], roster_needs: {}, positions: [], mode, search_mode: searchMode, message: 'Select at least one position to search for trade targets.', last_updated: new Date().toISOString() }); setTargetLoading(false); setTargetError(null); return () => controller.abort(); }
    setTargetLoading(true); setTargetError(null);
    fetchTargets(week, targetPositions, searchMode, teamIdValue, mode).then(result => { if (!controller.signal.aborted) setTargets(result); }).catch(cause => { if (!controller.signal.aborted) setTargetError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!controller.signal.aborted) setTargetLoading(false); });
    return () => controller.abort();
  }, [week, targetPositions, searchMode, teamIdValue, mode, targetRevision]);
  useEffect(() => { window.dispatchEvent(new CustomEvent('analyzer:context', { detail: { tradeContext: { team_id: teamIdValue, give_player_ids: give, receive_player_ids: receive, week, search_mode: searchMode, target_positions: targetPositions } } })); }, [teamIdValue, give, receive, week, searchMode, targetPositions]);

  async function analyzeTrade() { setBusy(true); setError(null); try { const result = await requestBackend<Analysis>('/trades/analyze', 'POST', { team_id: teamIdValue, give_player_ids: give, receive_player_ids: receive, week }); setAnalysis(result); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } }
  function toggleTargetPosition(position: string) { setTargetPositions(current => current.includes(position) ? current.filter(item => item !== position) : [...current, position]); }
  function flip(setter: (value: number[] | ((old: number[]) => number[])) => void, id: number) { setter(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]); }
  const tradeSide = (title: string, players: Player[], selected: number[], setter: (value: number[] | ((old: number[]) => number[])) => void, side: 'you' | 'them') => <section className="trade-roster-board" data-side={side} key={title}>
    <header><div><span className="trade-field-label">{side === 'you' ? 'YOUR TEAM' : 'THEIR TEAM'}</span><h3>{title}</h3></div><span>{selected.length} selected</span></header>
    <div className="trade-pick-list">{players.map(player => <TradePlayerTile key={player.player_id} player={player} selected={selected.includes(player.player_id)} onToggle={() => flip(setter, player.player_id)}/>)}</div>
  </section>;

  return <div className="lf-page lf-trades">
    <header className="lf-page-heading"><div><h1>Trade lab</h1><p>Explore fits. Build an exchange. Know the trade-off.</p></div><span className="lf-context-label">Week {week} · {own?.team_name || 'Your team'}</span></header>
    <SelectionTrack className="lf-workspace-switch" label="Trade workspace" value={workspace}><button type="button" aria-pressed={workspace === 'discover'} onClick={() => setWorkspace('discover')}>Discover targets</button><button type="button" aria-pressed={workspace === 'build'} onClick={() => setWorkspace('build')}>Build a trade</button></SelectionTrack>
    {workspace === 'discover' && <>
    <TradeSearchControls positions={targetPositions} onPositions={setTargetPositions} searchMode={searchMode} onSearchMode={setSearchMode} mode={mode} onMode={setMode} teams={others} selectedTeam={opponent} onTeam={setTeamIdValue}/>

    <section className="trade-desk-section trade-targets-section" aria-labelledby="trade-targets-heading">
      <div className="trade-desk-section-heading"><div><h2 id="trade-targets-heading">{searchMode === 'league_wide' ? 'Target radar' : `Targets on ${opponent?.team_name || 'their team'}`}</h2><p>{targetPositions.length ? `Looking for: ${targetPositions.join(' + ')}` : 'Choose at least one position to search.'}</p></div><span className="trade-results-stamp">{searchMode === 'league_wide' ? `${others.length} managers` : opponent?.team_name || 'Manager'}</span></div>
      {!targetPositions.length ? <div className="trade-empty-inline"><strong>Select at least one position to search for trade targets.</strong></div> : targetLoading ? <MarketSkeleton label="Scanning rosters · evaluating fit · checking value" count={3}/> : targetError ? <div className="trade-empty-inline error" role="alert"><strong>Trade ideas could not load</strong><p>Trade discovery is temporarily unavailable. Try again shortly.</p><button onClick={() => setTargetRevision(value => value + 1)}>Try again</button></div> : visibleTargets.length ? <ResultSequence identity={visibleTargets.map(row => row.player.player_id).join(',')} className="lf-target-radar">{visibleTargets.slice(0, 3).map((row, index) => <TradeTargetHero row={{ ...row, reason: row.reason || row.analysis.target_reason || row.analysis.verdict?.worth_it_reason || 'This player fits the position you selected.' }} team={teams.find(team => team.team_id === row.team_id)} week={week} positions={targetPositions} searchMode={searchMode} key={`${row.team_id}-${row.player.player_id}-${index}`}/>)}</ResultSequence> : <div className="trade-empty-inline"><strong>No strong match found</strong><p>We couldn’t find a deal that clearly helps both teams with these filters.</p>{dealIdeas.length > 0 && <small>{dealIdeas.length} possible idea{dealIdeas.length === 1 ? '' : 's'} are below. Each was still checked against both rosters.</small>}<div className="trade-empty-suggestions"><span>Try adding another position</span><span>or change the deal style</span>{searchMode === 'specific_team' && <span>or search the league</span>}</div></div>}
      {!targetLoading && !targetError && visibleTargets.length > 0 && <div className="trade-target-need-note"><TrendingUp size={15}/><span>{ownNeedCopy.length ? `Your roster could use help at ${ownNeedCopy.join(' and ')}.` : 'Targets are ranked using your roster fit and both teams’ trade analysis.'}</span></div>}
    </section>

    <section className="trade-desk-section trade-deals-section" aria-labelledby="trade-deals-heading">
      <div className="trade-desk-section-heading"><div><h2 id="trade-deals-heading">Suggested deals</h2><p>{mode.charAt(0).toUpperCase() + mode.slice(1)} · {targetPositions.length ? `Looking for ${targetPositions.join(' + ')}` : 'No positions selected'}</p></div><span className="trade-results-stamp">{dealIdeas.length ? `${Math.min(dealIdeas.length, 5)} ideas` : '—'}</span></div>
      {targetLoading ? <MarketSkeleton label="Evaluating possible exchanges…" count={2}/> : dealIdeas.length ? <ResultSequence identity={dealIdeas.map(item => item.you_receive.map(player => player.player_id).join(',')).join(':')} className="lf-deal-list">{dealIdeas.slice(0, 5).map((item, index) => <SuggestedDealRow analysis={item} index={index} teams={teams} key={`${teamId(item)}-${item.you_give.map(player => player.player_id).join(',')}-${item.you_receive.map(player => player.player_id).join(',')}`}/>)}</ResultSequence> : <div className="trade-empty-inline compact"><strong>No suggested deals yet.</strong><p>Try another position, style, or manager.</p></div>}
    </section>

    </>}
    {workspace === 'build' && <section className="trade-desk-section trade-builder-section" aria-labelledby="trade-builder-heading">
      <div className="trade-desk-section-heading trade-builder-title"><div><h2 id="trade-builder-heading">Your exchange</h2><p>Pick players from both rosters. This does not send a trade to ESPN.</p></div><label>Other team<select aria-label="Manual trade team" value={teamIdValue} onChange={event => setTeamIdValue(Number(event.target.value))}>{others.map(team => <option value={team.team_id} key={team.team_id}>{team.team_name}</option>)}</select></label></div>
      {!own?.roster || !opponent?.roster ? <div className="trade-empty-inline">Roster data is unavailable for one of the selected teams.</div> : <>
        <div className="trade-mobile-roster-tabs" role="tablist" aria-label="Choose roster">{[{key: 'you' as const, label: 'YOUR TEAM'}, {key: 'them' as const, label: 'THEIR TEAM'}].map(tab => <button key={tab.key} role="tab" aria-selected={mobileRoster === tab.key} className={mobileRoster === tab.key ? 'active' : ''} onClick={() => setMobileRoster(tab.key)}>{tab.label}</button>)}</div>
        <div className="trade-roster-pickers" data-active-roster={mobileRoster}>{tradeSide(own.team_name, own.roster, give, setGive, 'you')}{tradeSide(opponent.team_name, opponent.roster, receive, setReceive, 'them')}</div>
        <ManualTradeTray give={own.roster.filter(player => give.includes(player.player_id))} receive={opponent.roster.filter(player => receive.includes(player.player_id))} onRemove={(side, id) => side === 'give' ? setGive(current => current.filter(value => value !== id)) : setReceive(current => current.filter(value => value !== id))} onAnalyze={analyzeTrade} busy={busy}/>
      </>}
      {error && <div className="trade-analysis-error" role="alert"><strong>Trade analysis failed</strong><p>Trade analysis is unavailable right now. Try the analysis again.</p></div>}
      {analysis && <ResultSequence identity={`${give.join(',')}:${receive.join(',')}`}><TradeVerdict analysis={analysis} partner={opponent?.team_name || 'Selected team'} onClose={() => setAnalysis(null)}/></ResultSequence>}
      <details className="trade-methodology"><summary>How trades are compared <ChevronDown size={13}/></summary><p>Each deal uses the existing trade analysis to compare both teams’ best legal starting lineups, long-term value, roster depth, and risk. No trade is ever submitted to ESPN.</p></details>
    </section>}
  </div>;
}
