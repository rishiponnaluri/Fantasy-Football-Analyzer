'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Search, X } from 'lucide-react';
import { canonicalProjection, fetchBackend, requestBackend } from '@/lib/api';
import { FantasyPredictions, Player, PlayerSearchResult, StartSitResponse, WaiverResponse, points } from '@/lib/types';

type PanelTradeContext = { team_id?: number; give_player_ids?: number[]; receive_player_ids?: number[]; week?: number; search_mode?: 'league_wide' | 'specific_team'; target_positions?: string[] };
type PanelEvent = { action?: string; tradeContext?: PanelTradeContext };
type Summary = { title: string; lead: string; sections: { title: string; lines: string[] }[]; advanced?: string[] };
type TradePlayer = { player_id: number; name: string; position: string | null; weekly_projection?: number | null };
type TradeAnalysis = { you_give: TradePlayer[]; you_receive: TradePlayer[]; partner_team_name?: string; trade_category?: string; validation_type?: string; plausibility?: string; plausibility_basis?: string; weekly_lineup_change?: { you?: number | null; other_team?: number | null }; rest_of_season_change?: { you?: number | null; other_team?: number | null }; verdict?: { worth_it?: string; worth_it_reason?: string; acceptance_likelihood?: string; acceptance_reason?: string; method?: string } };
type TradeDiscovery = { trade_targets?: { player: TradePlayer; team_name: string; reason: string; analysis: TradeAnalysis }[]; suggestions?: TradeAnalysis[]; message?: string | null; positions?: string[]; search_mode?: string };
const ALL_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'];
const value = (number: number | null | undefined) => number == null ? 'Unavailable' : `${number.toFixed(1)} pts`;
const nameList = (players: TradePlayer[] | undefined) => (players || []).map(player => `${player.name} (${player.position || '--'})`).join(' + ') || 'Unavailable';

function pageTitle(page: string) {
  if (page.startsWith('Player profile')) return 'Player profile';
  return page;
}
function getSections(page: string) {
  const title = pageTitle(page);
  if (title === 'Players') return [['player-search', 'Search players'], ['player-compare', 'Compare selected players'], ['player-details', 'Projection & usage']];
  if (title === 'Waivers') return [['waivers', 'Roster needs & best adds']];
  if (title === 'Start/Sit') return [['startsit', 'Recommended lineup & close calls']];
  if (title === 'Trades') return [['trades', 'Trade targets & packages'], ['manual-trade', 'Analyze selected trade']];
  if (title === 'Predictions') return [['predictions', 'Your matchup outlook']];
  if (title === 'Player profile') return [['player-details', 'Projection, usage & matchup']];
  return [['startsit', 'Recommended lineup'], ['waivers', 'Roster needs'], ['predictions', 'Matchup outlook']];
}

export default function AnalysisPanel({ page, week, positions = ALL_POSITIONS, playerId }: { page: string; week: number | null; positions?: string[]; playerId?: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Summary | null>(null);
  const [tradeContext, setTradeContext] = useState<PanelTradeContext | null>(null);
  const [players, setPlayers] = useState<PlayerSearchResult[]>([]);
  const [searchText, setSearchText] = useState('');
  const [firstId, setFirstId] = useState<number | null>(null);
  const [secondId, setSecondId] = useState<number | null>(null);
  const actions = useMemo(() => getSections(page), [page]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<PanelEvent>).detail;
      if (detail?.tradeContext) setTradeContext(detail.tradeContext);
      setOpen(true);
      if (detail?.action) void run(detail.action, detail.tradeContext);
    };
    const onContext = (event: Event) => {
      const detail = (event as CustomEvent<PanelEvent>).detail;
      if (detail?.tradeContext) setTradeContext(detail.tradeContext);
    };
    window.addEventListener('analyzer:open', onOpen);
    window.addEventListener('analyzer:context', onContext);
    return () => { window.removeEventListener('analyzer:open', onOpen); window.removeEventListener('analyzer:context', onContext); };
  // `run` is stable in intent and reads page/week from the mounted panel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, week, positions.join(','), tradeContext]);

  async function run(action: string, explicitTradeContext?: PanelTradeContext | null) {
    setBusy(true); setError(null);
    try {
      if (action === 'player-search') {
        const query = new URLSearchParams({ limit: '30', sort: 'our_projection' });
        if (searchText.trim()) query.set('q', searchText.trim());
        const data = await fetchBackend<{ players: PlayerSearchResult[] }>(`/players/search?${query}`);
        setPlayers(data.players);
        setFirstId(data.players[0]?.player_id ?? null);
        setSecondId(data.players[1]?.player_id ?? null);
        setResult({ title: 'Real ESPN players', lead: `${data.players.length} player results are ready to compare.`, sections: [{ title: 'Select two players below', lines: data.players.slice(0, 8).map(player => `${player.name} · ${player.position || '--'} · ${player.nfl_team || '--'} · ESPN ${points(player.projected_fantasy_points)}`) }] });
      } else if (action === 'player-compare') {
        if (!firstId || !secondId) throw new Error('Search for players and choose two different players to compare.');
        const [a, b] = await Promise.all([fetchBackend<Player>(`/players/${firstId}?week=${week || ''}`), fetchBackend<Player>(`/players/${secondId}?week=${week || ''}`)]);
        const lines = (player: Player) => [
          `Projection: ${points(canonicalProjection(player))} · ESPN: ${points(player.custom_projection?.espn_projection)}`,
          `Season average: ${points(player.season_fantasy_average)} · Recent 3: ${points(player.custom_projection?.recent_3_game_average)} · Recent 5: ${points(player.custom_projection?.recent_5_game_average)}`,
          `Status: ${player.injury_status || 'Unavailable'} · Matchup: ${player.nfl_opponent || 'Unavailable'}`,
          ...(player.custom_projection?.adjustments || []).slice(0, 4).map(item => `${item.label}: ${item.adjustment > 0 ? '+' : ''}${item.adjustment.toFixed(1)} · ${item.evidence}`),
        ];
        setResult({ title: 'Player comparison', lead: 'Side-by-side values from ESPN profiles and the custom projection service.', sections: [{ title: a.name, lines: lines(a) }, { title: b.name, lines: lines(b) }], advanced: [a.custom_projection?.model, b.custom_projection?.model].filter((item): item is string => !!item) });
      } else if (action === 'player-details') {
        const id = playerId || firstId;
        if (!id) throw new Error('Choose a player from search first, or open Analyzer from a player profile.');
        const player = await fetchBackend<Player>(`/players/${id}?week=${week || ''}`);
        const model = player.custom_projection;
        setResult({ title: `${player.name} · ${player.position || '--'} · ${player.nfl_team || '--'}`, lead: `Status: ${player.injury_status || 'Unavailable'} · Upcoming opponent: ${player.nfl_opponent || 'Unavailable'} · Kickoff: ${player.nfl_game_time || 'Unavailable'}`, sections: [{ title: 'Projection', lines: [`Projection ${points(model?.recommendation_projection)} · ESPN ${points(model?.espn_projection)}`, `Floor ${points(model?.floor)} · Median ${points(model?.median)} · Ceiling ${points(model?.ceiling)}`, `Projection confidence: ${model?.confidence || 'Unavailable'} · Season average: ${points(player.season_fantasy_average)}`] }, { title: 'Supported factors', lines: (model?.adjustments || []).slice(0, 6).map(item => `${item.label} ${item.adjustment > 0 ? '+' : ''}${item.adjustment.toFixed(1)} · ${item.evidence}`) }, { title: 'Recent production', lines: (player.last_5_games || []).slice(-5).map(game => `Week ${game.week}: ${points(game.fantasy_points)} fantasy points`) }], advanced: [model?.model].filter((item): item is string => !!item) });
      } else if (action === 'waivers') {
        const query = new URLSearchParams({ week: String(week || 1), limit: '100' });
        positions.forEach(position => query.append('positions', position));
        const data = await fetchBackend<WaiverResponse>(`/waiver-advice?${query}`);
        setResult({ title: 'Roster needs & available players', lead: data.move_note || `${data.eligible_free_agent_count} real ESPN free agents match the selected positions.`, sections: [
          { title: 'Roster needs', lines: Object.entries(data.roster_needs || {}).map(([position, need]) => `${position}: ${need.label} · ${need.basis}`) },
          { title: 'Top adds for your team', lines: data.best_overall_adds.slice(0, 5).map(player => `${player.name} (${player.position || '--'}) · our ${points(canonicalProjection(player))} · ESPN ${points(player.custom_projection?.espn_projection)} · ${player.recommendation_reason || 'No additional evidence available.'}`) },
          ...(data.personalized_move ? [{ title: 'Possible add/drop', lines: [`ADD ${data.personalized_move.add.name} · DROP ${data.personalized_move.drop.name}`, data.personalized_move.reason, `Weekly lineup change: ${value(data.personalized_move.weekly_lineup_change)} · Rest-of-season: ${value(data.personalized_move.rest_of_season_change)}`] }] : []),
        ], advanced: [data.ranking_model] });
      } else if (action === 'startsit') {
        const data = await fetchBackend<StartSitResponse>(`/start-sit?week=${week || ''}`);
        const starters = data.recommended_starters.map(player => `${player.recommended_slot_label || player.recommended_slot || player.position} · ${player.name} · recommendation ${points(canonicalProjection(player))} · ESPN ${points(player.custom_projection?.espn_projection)} · confidence ${player.recommendation_confidence || 'Unavailable'}`);
        const decisions = data.lineup_changes.decisions.slice(0, 5).map(item => `${item.recommendation}: ${item.start.name} over ${item.bench.name} · ${points(item.expected_advantage)} point edge · ${item.confidence} confidence`);
        const disagreements = [...data.recommended_starters, ...data.bench].filter(player => player.model_disagreement?.flagged).slice(0, 4).map(player => `${player.name}: our model ${points(canonicalProjection(player))} · ESPN ${points(player.custom_projection?.espn_projection)} · data confidence ${player.projection_confidence || 'Unavailable'}`);
        setResult({ title: 'Recommended lineup', lead: `Week ${data.week} · ${data.legal_lineup ? 'All ESPN starting spots are filled legally' : `Unfilled ESPN spots: ${data.unfilled_slots.join(', ') || 'Unavailable'}`} · current ${points(data.current_projected_total)} · best lineup ${points(data.recommended_projected_total)}`, sections: [{ title: 'Starters', lines: starters }, { title: 'Closest decisions', lines: decisions.length ? decisions : ['No lineup changes are recommended with the available evidence.'] }, { title: 'Projection disagreements', lines: disagreements.length ? disagreements : ['No material projection disagreements were returned.'] }] });
      } else if (action === 'trades' || action === 'manual-trade') {
        const context = explicitTradeContext || tradeContext;
        if (action === 'manual-trade' && context?.team_id && context.give_player_ids?.length && context.receive_player_ids?.length) {
          const analysis = await requestBackend<TradeAnalysis>('/trades/analyze', 'POST', { team_id: context.team_id, give_player_ids: context.give_player_ids, receive_player_ids: context.receive_player_ids, week: context.week || week });
          setResult({ title: 'Trade analysis', lead: `Worth it for you: ${analysis.verdict?.worth_it || 'Unavailable'} · Would they consider it: ${analysis.verdict?.acceptance_likelihood || 'Unavailable'}`, sections: [
            { title: 'You give', lines: [nameList(analysis.you_give)] }, { title: 'You receive', lines: [nameList(analysis.you_receive)] },
            { title: 'Why', lines: [analysis.verdict?.worth_it_reason || 'No supported explanation available.', analysis.verdict?.acceptance_reason || 'No supported explanation available.'] },
            { title: 'Weekly lineup impact', lines: [`You: ${value(analysis.weekly_lineup_change?.you)} · Other team: ${value(analysis.weekly_lineup_change?.other_team)}`, `Rest of season: you ${value(analysis.rest_of_season_change?.you)} · them ${value(analysis.rest_of_season_change?.other_team)}`] },
          ], advanced: [analysis.verdict?.method, analysis.plausibility_basis].filter((item): item is string => !!item) });
        } else {
          const query = new URLSearchParams({ week: String(week || 1), search_mode: context?.search_mode || 'league_wide', mode: 'balanced' });
          if (context?.search_mode === 'specific_team' && context.team_id) query.set('team_id', String(context.team_id));
          (context?.target_positions?.length ? context.target_positions : ['RB', 'WR']).forEach(position => query.append('positions', position));
          const data = await fetchBackend<TradeDiscovery>(`/trades/discovery?${query}`);
          const targets = (data.trade_targets || []).slice(0, 5).map(row => `${row.player.name} (${row.player.position || '--'}) · owner ${row.team_name} · ${row.reason} · your lineup +${points(row.analysis.weekly_lineup_change?.you)} · theirs +${points(row.analysis.weekly_lineup_change?.other_team)} · ${row.analysis.plausibility || 'Plausibility unavailable'} fit`);
          const packages = (data.suggestions || []).slice(0, 5).map(item => `${item.validation_type || item.trade_category || 'Trade idea'} · ${item.partner_team_name || 'Manager unavailable'} · give ${nameList(item.you_give)} for ${nameList(item.you_receive)} · your impact ${value(item.weekly_lineup_change?.you)} · their impact ${value(item.weekly_lineup_change?.other_team)} · ${item.plausibility || 'Plausibility unavailable'}`);
          setResult({ title: 'Trade targets & packages', lead: data.message || `Search: ${context?.search_mode === 'specific_team' ? 'selected manager' : 'league wide'} · Positions: ${(context?.target_positions || ['RB', 'WR']).join(' + ')}`, sections: [{ title: 'Targets', lines: targets.length ? targets : ['No targets passed the roster-fit checks.'] }, { title: 'Numerically checked packages', lines: packages.length ? packages : ['No packages passed the current checks.'] }] });
        }
      } else if (action === 'predictions') {
        const data = await fetchBackend<FantasyPredictions>(`/fantasy-predictions?week=${week || ''}`);
        const match = data.predictions.find(item => item.involves_my_team);
        if (!match) throw new Error('ESPN has not supplied a fantasy matchup prediction for your team in this week.');
        if (!match.team_a || !match.team_b) throw new Error(match.message || 'The simulator did not return both fantasy teams for this matchup.');
        const own = match.team_a.team_id === data.my_team_id ? match.team_a : match.team_b;
        const other = match.team_a.team_id === data.my_team_id ? match.team_b : match.team_a;
        const win = match.team_a.team_id === data.my_team_id ? match.team_a_win_probability : match.team_b_win_probability;
        setResult({ title: 'Your fantasy matchup outlook', lead: `${own.team_name} ${typeof win === 'number' ? `${(win * 100).toFixed(1)}%` : '--'} win probability vs ${other.team_name} · ${match.simulation_count.toLocaleString()} simulations`, sections: [
          { title: 'Projected scores', lines: [`Your current score ${points(own.current_score)} · simulated final ${points(own.expected_final_score)} · ESPN ${points(own.espn_projected_score)}`, `Opponent current ${points(other.current_score)} · simulated final ${points(other.expected_final_score)} · ESPN ${points(other.espn_projected_score)}`] },
          { title: 'Biggest swing players', lines: (match.biggest_remaining_swing_players || []).slice(0, 4).map(player => `${player.name} · remaining estimate ${points(player.remaining_projected_points)} · win-probability impact ${player.win_probability_swing == null ? 'Unavailable' : `${(player.win_probability_swing * 100).toFixed(1)}%`}`) },
        ], advanced: [match.model_confidence ? `Prediction confidence: ${match.model_confidence}` : 'Prediction confidence: Unavailable'] });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  return <>
    {open && <div className="analyzer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <aside className="analyzer-panel" role="dialog" aria-modal="true" aria-labelledby="analyzer-title">
        <header className="analyzer-header"><div><span className="eyebrow">CURRENT LEAGUE DATA</span><h2 id="analyzer-title">Insights</h2><p>{pageTitle(page)} · Week {week ?? '--'}</p></div><button className="icon-button" aria-label="Close Insights" onClick={() => setOpen(false)}><X size={18}/></button></header>
        <div className="analyzer-content">
          <p className="analyzer-intro">Choose an analysis. Results come from the app’s ESPN, projection, and matchup services.</p>
          <div className="analyzer-actions">{actions.map(([action, label]) => <button type="button" key={action} onClick={() => void run(action)} disabled={busy}><Activity size={14}/>{label}</button>)}</div>
          {(pageTitle(page) === 'Players') && <section className="analyzer-player-picker"><label>Find player<input value={searchText} onChange={event => setSearchText(event.target.value)} placeholder="Name (optional)" onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void run('player-search'); } }}/></label><button className="button" onClick={() => void run('player-search')} disabled={busy}><Search size={14}/> Search</button>{players.length > 0 && <div className="analyzer-selectors"><label>First player<select value={firstId ?? ''} onChange={event => setFirstId(Number(event.target.value) || null)}>{players.map(player => <option key={player.player_id} value={player.player_id}>{player.name} · {player.position || '--'}</option>)}</select></label><label>Second player<select value={secondId ?? ''} onChange={event => setSecondId(Number(event.target.value) || null)}>{players.map(player => <option key={player.player_id} value={player.player_id}>{player.name} · {player.position || '--'}</option>)}</select></label><button className="button primary-button" onClick={() => void run('player-compare')} disabled={busy || !firstId || !secondId || firstId === secondId}>Compare</button></div>}</section>}
          {busy && <p className="analyzer-status" role="status">{pageTitle(page) === 'Trades' ? 'Checking real rosters and trade packages…' : 'Loading current league analysis…'}</p>}
          {error && <div className="analyzer-error" role="alert">This analysis is unavailable right now. Please try again.</div>}
          {result && <section className="analyzer-result"><h3>{result.title}</h3><p>{result.lead}</p>{result.sections.map(section => <div className="analyzer-result-section" key={section.title}><h4>{section.title}</h4>{section.lines.length ? <ul>{section.lines.map((line, index) => <li key={`${section.title}-${index}`}>{line}</li>)}</ul> : <p>Unavailable from current league data.</p>}</div>)}{result.advanced?.length ? <details><summary>How this was calculated</summary><ul>{result.advanced.map((line, index) => <li key={index}>{line}</li>)}</ul></details> : null}</section>}
        </div>
      </aside>
    </div>}
  </>;
}
