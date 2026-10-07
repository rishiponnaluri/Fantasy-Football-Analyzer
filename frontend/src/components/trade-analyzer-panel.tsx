'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowRightLeft, Check, ChevronDown, Handshake, Search, TrendingUp, X } from 'lucide-react';
import { fetchBackend, requestBackend } from '@/lib/api';
import { FantasyMatchups, FantasyTeam, Player, points } from '@/lib/types';
import { PlayerAvatar, PlayerStatusButton } from './player-quick-view';

type ImpactPlayer = { player_id: number; name: string; position: string | null; nfl_team: string | null; weekly_projection: number | null; espn_projection: number | null; season_average: number | null; confidence: string | null; uncertainty: number | null; bye_week: number | null; injury_status: string | null; lineup_slot: string | null; headshot_url?: string | null; nfl_team_id?: number | null; nfl_team_logo_url?: string | null; nfl_team_color?: string | null };
type Analysis = { you_give: ImpactPlayer[]; you_receive: ImpactPlayer[]; partner_team_name?: string; partner_team_id?: number; other_team?: { team_id: number; team_name: string }; trade_category?: string; validation_type?: string; package_shape?: string; weekly_lineup_change: { you: number; other_team: number; you_before: number; you_after: number; other_before: number; other_after: number; you_starting_lineup_after: (ImpactPlayer & { recommended_slot?: string })[]; other_starting_lineup_after: (ImpactPlayer & { recommended_slot?: string })[] }; rest_of_season_change: { you: number | null; other_team: number | null; method: string }; positional_impact: Record<string, unknown>; affected_starting_lineup_slots: Record<string, unknown>; depth_impact: Record<string, unknown>; risk: Record<string, unknown>; bye_week_implications: Record<string, unknown>; model: string; plausibility?: string; plausibility_basis?: string; verdict?: { worth_it: 'YES'|'LEAN YES'|'EVEN'|'LEAN NO'|'NO'; worth_it_reason: string; acceptance_likelihood: 'HIGH'|'MEDIUM'|'LOW'|'VERY LOW'; acceptance_reason: string; weekly_uncertainty: number | null; method: string }; rest_of_season_value_fit?: { give_value: number; receive_value: number; difference: number; uncertainty: number; method: string } };
type TargetRow = { player: ImpactPlayer; team_id: number; team_name: string; analysis: Analysis & { plausibility?: string; plausibility_basis?: string; target_reason?: string }; reason: string };
type TradeIdea = Analysis & { partner_team_id?: number; partner_team_name?: string; trade_category?: string; validation_type?: string; package_shape?: string };
type TargetResponse = { trade_targets: TargetRow[]; suggestions?: TradeIdea[]; possible_trades_to_explore?: TradeIdea[]; research_trade_ideas?: TradeIdea[]; trade_categories?: Record<string, number>; best_trade_partners: { team_id: number; team_name: string; best_weekly_fit: number }[]; roster_needs: Record<string, { label: string }>; search_mode?: 'league_wide' | 'specific_team'; mode?: 'conservative' | 'balanced' | 'aggressive'; positions?: string[]; message: string | null; last_updated: string };
const targetRequestCache = new Map<string, { promise: Promise<TargetResponse>; expiresAt: number }>();
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'FLEX'] as const;

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
function fantasyAccent(team?: FantasyTeam) { return team?.primary_color ? `#${team.primary_color.replace('#', '')}` : '#b8ff3d'; }

function FantasyTeamMark({ team, compact = false }: { team?: FantasyTeam; compact?: boolean }) {
  const [logoFailed, setLogoFailed] = useState(false);
  if (!team) return <span className="trade-fantasy-mark">--</span>;
  const color = fantasyAccent(team);
  return <div className={`trade-fantasy-identity ${compact ? 'compact' : ''}`} style={{ '--trade-fantasy-color': color } as React.CSSProperties}>
    {team.team_logo_url && !logoFailed ? <img src={team.team_logo_url} alt="" onError={() => setLogoFailed(true)}/> : <span>{team.abbreviation || team.team_name.slice(0, 2).toUpperCase()}</span>}
    {!compact && <div><strong>{team.team_name}</strong><small>{team.owners.map(owner => owner.displayName || owner.firstName).filter(Boolean).join(', ') || 'League team'}</small></div>}
  </div>;
}

function TradeSearchControls({ positions, onPositions, searchMode, onSearchMode, mode, onMode, teams, selectedTeam, onTeam }: {
  positions: string[]; onPositions: (positions: string[]) => void; searchMode: 'league_wide' | 'specific_team'; onSearchMode: (value: 'league_wide' | 'specific_team') => void;
  mode: 'conservative' | 'balanced' | 'aggressive'; onMode: (value: 'conservative' | 'balanced' | 'aggressive') => void; teams: FantasyTeam[]; selectedTeam?: FantasyTeam; onTeam: (id: number) => void;
}) {
  const counts = useMemo(() => Object.entries((selectedTeam?.roster || []).reduce<Record<string, number>>((all, player) => { const position = player.position || 'Other'; all[position] = (all[position] || 0) + 1; return all; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4), [selectedTeam]);
  return <section className="trade-desk-controls" aria-label="Find a trade controls">
    <div className="trade-controls-main">
      <div className="trade-control-block trade-position-control"><span className="trade-field-label">WHAT DO YOU WANT TO IMPROVE?</span><div className="trade-position-filter" role="group" aria-label="Filter trade targets by position">{POSITIONS.map(position => <button key={position} type="button" className={positions.includes(position) ? 'active' : ''} aria-pressed={positions.includes(position)} onClick={() => onPositions(positions.includes(position) ? positions.filter(item => item !== position) : [...positions, position])}>{positions.includes(position) && <Check size={12}/>} {position}</button>)}</div><div className="trade-filter-actions"><button type="button" onClick={() => onPositions([...POSITIONS])}>Select all</button><button type="button" onClick={() => onPositions([])}>Clear all</button></div></div>
      <div className="trade-control-block"><span className="trade-field-label">SEARCH</span><div className="trade-mode-toggle" role="group" aria-label="Trade search mode"><button type="button" className={searchMode === 'league_wide' ? 'active' : ''} aria-pressed={searchMode === 'league_wide'} onClick={() => onSearchMode('league_wide')}>League wide</button><button type="button" className={searchMode === 'specific_team' ? 'active' : ''} aria-pressed={searchMode === 'specific_team'} onClick={() => onSearchMode('specific_team')}>Specific team</button></div>{searchMode === 'specific_team' && <label className="trade-manager-select"><span>Manager</span><select aria-label="Specific fantasy team" value={selectedTeam?.team_id || ''} onChange={event => onTeam(Number(event.target.value))}>{teams.map(team => <option value={team.team_id} key={team.team_id}>{team.team_name}</option>)}</select></label>}</div>
      <div className="trade-control-block"><span className="trade-field-label">STYLE</span><div className="trade-style-select"><select aria-label="Trade suggestion mode" value={mode} onChange={event => onMode(event.target.value as typeof mode)}><option value="conservative">Conservative</option><option value="balanced">Balanced</option><option value="aggressive">Aggressive</option></select><ChevronDown size={14}/></div></div>
      <div className="trade-looking-for"><Search size={15}/><div><span>LOOKING FOR</span><strong>{positions.length ? positions.join(' + ') : 'Choose a position'}</strong><small>{searchMode === 'league_wide' ? 'Searching every other roster' : `Only ${selectedTeam?.team_name || 'the selected team'}`}</small></div></div>
    </div>
    {searchMode === 'specific_team' && selectedTeam && <div className="trade-manager-preview"><FantasyTeamMark team={selectedTeam}/><div className="trade-roster-snapshot"><span>ROSTER PREVIEW</span><div>{counts.map(([position, count]) => <i key={position}>{position} <b>{count}</b></i>)}{!counts.length && <small>Roster data unavailable</small>}</div></div></div>}
    <p className="trade-controls-note">Position filters apply to every automatic deal. Manual trades can include any position.</p>
  </section>;
}

function SmallPlayer({ player, size = 'md' }: { player: ImpactPlayer; size?: 'sm' | 'md' | 'lg' }) {
  const full = player as unknown as Player;
  return <div className={`trade-identity-player ${size}`}>
    <PlayerAvatar player={full} size={size === 'lg' ? 'lg' : size}/>
    <div><Link href={`/players/${player.player_id}`} className="trade-person-name">{player.name}</Link><span>{player.position || '--'} · {player.nfl_team || '--'}</span></div>
  </div>;
}

function TradeExchange({ give, receive, compact = false }: { give: ImpactPlayer[]; receive: ImpactPlayer[]; compact?: boolean }) {
  return <div className={`trade-deal-exchange ${compact ? 'compact' : ''}`}>
    <div><span className="trade-side-title">YOU GIVE</span>{give.map(player => <SmallPlayer key={player.player_id} player={player} size={compact ? 'sm' : 'md'}/>)}</div>
    <span className="trade-exchange-symbol" aria-label="for"><ArrowRightLeft size={compact ? 17 : 21}/></span>
    <div><span className="trade-side-title">YOU GET</span>{receive.map(player => <SmallPlayer key={player.player_id} player={player} size={compact ? 'sm' : 'md'}/>)}</div>
  </div>;
}

function VerdictPair({ analysis }: { analysis: Analysis }) {
  return <div className="trade-verdict-pair"><div><span>GOOD FOR YOU</span><strong className={`worth-${(analysis.verdict?.worth_it || 'review').toLowerCase().replaceAll(' ', '-')}`}>{shortWorth(analysis.verdict?.worth_it)}</strong></div><div><span>THEY MAY CONSIDER IT</span><strong>{acceptanceLabel(analysis.verdict?.acceptance_likelihood)}</strong></div></div>;
}

function AnalysisDetails({ analysis }: { analysis: Analysis }) {
  const change = analysis.weekly_lineup_change;
  const lineup = (players: Analysis['weekly_lineup_change']['you_starting_lineup_after']) => players.map(player => `${player.recommended_slot || player.lineup_slot || '--'} · ${player.name} · ${points(player.weekly_projection)}`);
  return <details className="trade-deep-details"><summary>View numbers and lineup changes <ChevronDown size={13}/></summary><div className="trade-numbers-grid"><span>Your best lineup<strong>{points(change.you_before)} → {points(change.you_after)} <small>this week</small></strong></span><span>Their best lineup<strong>{points(change.other_before)} → {points(change.other_after)} <small>this week</small></strong></span><span>Your long-term value<strong>{points(analysis.rest_of_season_change.you)}</strong></span><span>Their long-term value<strong>{points(analysis.rest_of_season_change.other_team)}</strong></span></div><div className="trade-after-lineups"><div><b>Your lineup after</b>{lineup(change.you_starting_lineup_after).map(line => <span key={line}>{line}</span>)}</div><div><b>Their lineup after</b>{lineup(change.other_starting_lineup_after).map(line => <span key={line}>{line}</span>)}</div></div><details className="trade-methodology-deep"><summary>How this was calculated</summary><p>{analysis.verdict?.method || analysis.model}</p><p>{analysis.rest_of_season_change.method}</p></details></details>;
}

function TradeTargetHero({ row, team, week, positions, searchMode }: { row: TargetRow; team?: FantasyTeam; week: number; positions: string[]; searchMode: 'league_wide' | 'specific_team' }) {
  const analysis = row.analysis;
  const target = row.player;
  const receive = analysis.you_receive.length ? analysis.you_receive : [target];
  const reasonForYou = row.reason || simpleImpactReason(analysis);
  const reasonForThem = simpleImpactReason(analysis, 'other_team');
  return <article className="trade-target-feature" style={{ '--trade-target-color': target.nfl_team_color ? `#${target.nfl_team_color.replace('#', '')}` : '#b8ff3d' } as React.CSSProperties}>
    <div className="trade-target-feature-top"><span className="trade-target-rank">TARGET</span><span className={`trade-idea-type ${analysis.validation_type === 'MODEL-VALIDATED' ? 'validated' : ''}`}>{analysis.validation_type === 'MODEL-VALIDATED' ? 'MODEL-VALIDATED' : 'POSSIBLE TO EXPLORE'}</span></div>
    <div className="trade-target-focus"><PlayerAvatar player={target as unknown as Player} size="lg"/><div className="trade-target-copy"><span className="trade-target-position">{target.position || '--'} · {target.nfl_team || '--'}</span><Link href={`/players/${target.player_id}`} className="trade-target-name">{target.name}</Link><span className="trade-target-owner">Owned by <b>{row.team_name}</b></span>{team && <FantasyTeamMark team={team} compact/>}<PlayerStatusButton player={target as unknown as Player}/></div></div>
    <div className="trade-target-reasons"><p><b>Why he helps</b>{reasonForYou}</p><p><b>Why they may move him</b>{reasonForThem}</p></div>
    <div className="trade-target-deal-label">POSSIBLE DEAL</div><TradeExchange give={analysis.you_give} receive={receive}/>
    <VerdictPair analysis={analysis}/>
    <div className="trade-target-explain"><span>{simpleImpactReason(analysis, 'other_team')}</span><button type="button" onClick={() => window.dispatchEvent(new CustomEvent('analyzer:open', { detail: { action: 'manual-trade', tradeContext: { team_id: row.team_id, give_player_ids: analysis.you_give.map(player => player.player_id), receive_player_ids: receive.map(player => player.player_id), week, search_mode: searchMode, target_positions: positions } } }))}>View deal <ArrowDown size={14}/></button></div>
    <AnalysisDetails analysis={analysis}/>
  </article>;
}

function SuggestedDealRow({ analysis, index, teams }: { analysis: Analysis; index: number; teams: FantasyTeam[] }) {
  const partner = teams.find(team => team.team_id === teamId(analysis));
  const validated = analysis.validation_type === 'MODEL-VALIDATED' || analysis.validation_type === 'IMMEDIATE WIN-WIN';
  return <article className="trade-suggested-row">
    <span className="trade-suggested-index">{String(index + 1).padStart(2, '0')}</span>
    <div className="trade-suggested-partner"><FantasyTeamMark team={partner} compact/><span>{teamName(analysis)}</span></div>
    <TradeExchange give={analysis.you_give} receive={analysis.you_receive} compact/>
    <div className="trade-suggested-result"><VerdictPair analysis={analysis}/><p>{simpleImpactReason(analysis)}</p><details><summary>More details <ChevronDown size={12}/></summary><p>{analysis.verdict?.acceptance_reason}</p><AnalysisDetails analysis={analysis}/></details></div>
    <span className={`trade-idea-type ${validated ? 'validated' : ''}`}>{validated ? 'MODEL-VALIDATED' : 'POSSIBLE IDEA'}</span>
  </article>;
}

function TradePlayerTile({ player, selected, onToggle }: { player: Player; selected: boolean; onToggle: () => void }) {
  return <div className={`trade-pick-tile ${selected ? 'selected' : ''}`}>
    <input type="checkbox" aria-label={`${selected ? 'Remove' : 'Select'} ${player.name} ${selected ? 'from' : 'for'} trade`} checked={selected} onChange={onToggle}/>
    <PlayerAvatar player={player} size="md"/>
    <div className="trade-pick-player"><Link href={`/players/${player.player_id}`}>{player.name}</Link><span>{player.position || '--'} · {player.nfl_team || '--'}{player.lineup_slot ? ` · ${player.lineup_slot}` : ''}</span><PlayerStatusButton player={player}/></div>
    <strong>{points(player.custom_projection?.our_projection ?? player.projected_fantasy_points)}<small>proj.</small></strong>
    {selected && <Check className="trade-pick-check" size={15}/>}
  </div>;
}

function ManualTradeTray({ give, receive, onRemove, onAnalyze, busy }: { give: Player[]; receive: Player[]; onRemove: (side: 'give' | 'receive', id: number) => void; onAnalyze: () => void; busy: boolean }) {
  if (!give.length && !receive.length) return null;
  return <aside className="trade-floating-tray" aria-label="Selected trade">
    <div className="trade-tray-side"><span>YOU GIVE</span>{give.length ? give.map(player => <button key={player.player_id} onClick={() => onRemove('give', player.player_id)} title={`Remove ${player.name}`}><img src={player.headshot_url || ''} alt=""/><b>{player.name}</b><X size={12}/></button>) : <small>Select from your roster</small>}</div>
    <ArrowRightLeft className="trade-tray-arrow" size={19}/>
    <div className="trade-tray-side"><span>YOU GET</span>{receive.length ? receive.map(player => <button key={player.player_id} onClick={() => onRemove('receive', player.player_id)} title={`Remove ${player.name}`}><img src={player.headshot_url || ''} alt=""/><b>{player.name}</b><X size={12}/></button>) : <small>Select from their roster</small>}</div>
    <button className="trade-tray-analyze" onClick={onAnalyze} disabled={busy || !give.length || !receive.length}><ArrowRightLeft size={15}/>{busy ? 'Analyzing…' : 'Analyze trade'}</button>
  </aside>;
}

function TradeVerdict({ analysis, partner, onClose }: { analysis: Analysis; partner: string; onClose: () => void }) {
  return <section className="trade-result-sheet" aria-label="Trade result">
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

  return <div className="feature-page trade-page trade-desk-page">
    <header className="trade-desk-heading"><div><span className="trade-field-label">WEEK {week} · LEAGUE DEAL FINDER</span><h1>Find a trade</h1><p>Find a player who helps your team and a deal the other manager may consider.</p></div><div className="trade-desk-league"><span>{own?.team_name || 'Your team'}</span><small>ESPN league · Week {week}</small></div></header>
    <TradeSearchControls positions={targetPositions} onPositions={setTargetPositions} searchMode={searchMode} onSearchMode={setSearchMode} mode={mode} onMode={setMode} teams={others} selectedTeam={opponent} onTeam={setTeamIdValue}/>

    <section className="trade-desk-section trade-targets-section" aria-labelledby="trade-targets-heading">
      <div className="trade-desk-section-heading"><div><span className="trade-field-label">{searchMode === 'league_wide' ? 'SEARCHING EVERY ROSTER' : 'SELECTED MANAGER'}</span><h2 id="trade-targets-heading">{searchMode === 'league_wide' ? 'Best targets across your league' : `Targets on ${opponent?.team_name || 'their team'}`}</h2><p>{targetPositions.length ? `Looking for: ${targetPositions.join(' + ')}` : 'Choose at least one position to search.'}</p></div><span className="trade-results-stamp">{searchMode === 'league_wide' ? `${others.length} managers` : opponent?.team_name || 'Manager'}</span></div>
      {!targetPositions.length ? <div className="trade-empty-inline"><strong>Select at least one position to search for trade targets.</strong></div> : targetLoading ? <div className="trade-progress-line" role="status"><span className="trade-progress-dot"/>Scanning rosters and testing {targetPositions.join(' + ')} packages…</div> : targetError ? <div className="trade-empty-inline error" role="alert"><strong>Trade ideas could not load</strong><p>{targetError}</p><button onClick={() => setTargetRevision(value => value + 1)}>Try again</button></div> : visibleTargets.length ? <div className="trade-target-feature-list">{visibleTargets.slice(0, 3).map((row, index) => <TradeTargetHero row={{ ...row, reason: row.reason || row.analysis.target_reason || row.analysis.verdict?.worth_it_reason || 'This player fits the position you selected.' }} team={teams.find(team => team.team_id === row.team_id)} week={week} positions={targetPositions} searchMode={searchMode} key={`${row.team_id}-${row.player.player_id}-${index}`}/>)}</div> : <div className="trade-empty-inline"><strong>NO STRONG MATCH FOUND</strong><p>We couldn’t find a deal that clearly helps both teams with these filters.</p>{dealIdeas.length > 0 && <small>{dealIdeas.length} possible idea{dealIdeas.length === 1 ? '' : 's'} are below. Each was still checked against both rosters.</small>}<div className="trade-empty-suggestions"><span>Try adding another position</span><span>or change the deal style</span>{searchMode === 'specific_team' && <span>or search the league</span>}</div></div>}
      {!targetLoading && !targetError && visibleTargets.length > 0 && <div className="trade-target-need-note"><TrendingUp size={15}/><span>{ownNeedCopy.length ? `Your roster could use help at ${ownNeedCopy.join(' and ')}.` : 'Targets are ranked using your roster fit and both teams’ trade analysis.'}</span></div>}
    </section>

    <section className="trade-desk-section trade-deals-section" aria-labelledby="trade-deals-heading">
      <div className="trade-desk-section-heading"><div><span className="trade-field-label">ANALYZED AGAINST BOTH ROSTERS</span><h2 id="trade-deals-heading">Suggested deals</h2><p>{mode.charAt(0).toUpperCase() + mode.slice(1)} · {targetPositions.length ? `Looking for ${targetPositions.join(' + ')}` : 'No positions selected'}</p></div><span className="trade-results-stamp">{dealIdeas.length ? `${Math.min(dealIdeas.length, 5)} ideas` : '—'}</span></div>
      {targetLoading ? <div className="trade-progress-line" role="status"><span className="trade-progress-dot"/>Evaluating deals for {targetPositions.join(' + ')}…</div> : dealIdeas.length ? <div className="trade-suggested-list">{dealIdeas.slice(0, 5).map((item, index) => <SuggestedDealRow analysis={item} index={index} teams={teams} key={`${teamId(item)}-${item.you_give.map(player => player.player_id).join(',')}-${item.you_receive.map(player => player.player_id).join(',')}`}/>)}</div> : <div className="trade-empty-inline compact"><strong>No suggested deals yet.</strong><p>Try another position, style, or manager.</p></div>}
    </section>

    <section className="trade-desk-section trade-builder-section" aria-labelledby="trade-builder-heading">
      <div className="trade-desk-section-heading trade-builder-title"><div><span className="trade-field-label">MANUAL ANALYSIS</span><h2 id="trade-builder-heading">Build your own</h2><p>Pick players from both rosters. This does not send a trade to ESPN.</p></div><label>Other team<select aria-label="Manual trade team" value={teamIdValue} onChange={event => setTeamIdValue(Number(event.target.value))}>{others.map(team => <option value={team.team_id} key={team.team_id}>{team.team_name}</option>)}</select></label></div>
      {!own?.roster || !opponent?.roster ? <div className="trade-empty-inline">Roster data is unavailable for one of the selected teams.</div> : <>
        <div className="trade-mobile-roster-tabs" role="tablist" aria-label="Choose roster">{[{key: 'you' as const, label: 'YOUR TEAM'}, {key: 'them' as const, label: 'THEIR TEAM'}].map(tab => <button key={tab.key} role="tab" aria-selected={mobileRoster === tab.key} className={mobileRoster === tab.key ? 'active' : ''} onClick={() => setMobileRoster(tab.key)}>{tab.label}</button>)}</div>
        <div className="trade-roster-pickers" data-active-roster={mobileRoster}>{tradeSide(own.team_name, own.roster, give, setGive, 'you')}{tradeSide(opponent.team_name, opponent.roster, receive, setReceive, 'them')}</div>
        <ManualTradeTray give={own.roster.filter(player => give.includes(player.player_id))} receive={opponent.roster.filter(player => receive.includes(player.player_id))} onRemove={(side, id) => side === 'give' ? setGive(current => current.filter(value => value !== id)) : setReceive(current => current.filter(value => value !== id))} onAnalyze={analyzeTrade} busy={busy}/>
      </>}
      {error && <div className="trade-analysis-error" role="alert"><strong>Trade analysis failed</strong><p>{error}</p></div>}
      {analysis && <TradeVerdict analysis={analysis} partner={opponent?.team_name || 'Selected team'} onClose={() => setAnalysis(null)}/ >}
      <details className="trade-methodology"><summary>How trades are compared <ChevronDown size={13}/></summary><p>Each deal uses the existing trade analysis to compare both teams’ best legal starting lineups, long-term value, roster depth, and risk. No trade is ever submitted to ESPN.</p></details>
    </section>
  </div>;
}
