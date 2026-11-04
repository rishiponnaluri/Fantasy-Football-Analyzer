type SupportingFactor = { label?: string; evidence?: string; adjustment?: number; source?: string };
export type ProjectionDisagreement = { raw_custom: number; reference_anchor: number; recommendation_estimate?: number; espn_projection?: number | null; data_confidence?: string; difference?: number; flagged: boolean; supported_by_context: boolean; supporting_factors?: SupportingFactor[] };

export function ProjectionConfidenceNote({ confidence, basis }: { confidence?: string | null; basis?: { score?: number; components?: Record<string, number>; reasons?: string[] } }) {
  if (!confidence) return null;
  const label = confidence.toLowerCase();
  const reasons = basis?.reasons || [];
  const componentLabels: Record<string, string> = { history: 'Recent game history', role_stability: 'Role consistency', source_agreement: 'Projection agreement', status_certainty: 'Health clarity', matchup_information: 'Matchup information' };
  return <details className="confidence-explanation"><summary>Data confidence: <b className={`confidence-${label}`}>{label}</b> ⓘ</summary>
    <p>How much reliable information we have for this player&apos;s projection.</p>
    {reasons.length ? <ul>{reasons.slice(0, 4).map((reason, index) => <li key={index}>{reason}</li>)}</ul> : <p>Confidence reflects recent games, role consistency, agreement between projections, health clarity, and matchup information.</p>}
    <details className="projection-advanced"><summary>How this was calculated</summary><p>History, role consistency, and agreement among projections each count 25%; health clarity counts 15%; matchup information counts 10%. High is 80–100, Medium is 55–79, and Low is below 55. This describes information quality; it is not a guarantee of the result.</p>{typeof basis?.score === 'number' && <p>Evidence score: {basis.score}/100</p>}{basis?.components && <ul>{Object.entries(basis.components).map(([key, score]) => <li key={key}>{componentLabels[key] || key}: {score}/100</li>)}</ul>}</details>
  </details>;
}

export function MatchupConfidenceNote({ prediction }: { prediction?: { model_confidence?: string; model_confidence_score?: number; model_confidence_reasons?: string[]; model_confidence_components?: Record<string, number> } }) {
  if (!prediction?.model_confidence) return null;
  const labels: Record<string, string> = { win_probability_separation: 'How far apart the simulated chances are', completed_scoring: 'Scoring already locked in', remaining_score_uncertainty: 'Uncertainty still remaining', player_data_quality: 'Player projection data', health_clarity: 'Player availability clarity' };
  return <details className="confidence-explanation matchup-confidence-note"><summary>Matchup confidence: <b className={`confidence-${prediction.model_confidence}`}>{prediction.model_confidence}</b> ⓘ</summary>
    <p>This tells you how dependable the simulation looks. It is separate from either team&apos;s win probability.</p>
    {!!prediction.model_confidence_reasons?.length && <ul>{prediction.model_confidence_reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    <details className="projection-advanced"><summary>How this was calculated</summary><p>The estimate weighs win-chance separation (30%), finished scoring (15%), remaining scoring uncertainty (25%), player data quality (20%), and health clarity (10%).</p>{typeof prediction.model_confidence_score === 'number' && <p>Evidence score: {prediction.model_confidence_score}/100</p>}{prediction.model_confidence_components && <ul>{Object.entries(prediction.model_confidence_components).map(([key, score]) => <li key={key}>{labels[key] || key}: {score}/100</li>)}</ul>}</details>
  </details>;
}

function simpleEvidence(factor: SupportingFactor) {
  const evidence = factor.evidence || '';
  const snap = evidence.match(/snap share changed from ([\d.]+)% to ([\d.]+)%/i);
  if (snap) return `Recent snap share ${Number(snap[1]) > Number(snap[2]) ? 'fell' : Number(snap[1]) < Number(snap[2]) ? 'rose' : 'stayed steady'} (${snap[1]}% to ${snap[2]}%).`;
  const matchup = evidence.match(/allowed [\d.]+ .*?\(\s*([+-]?[\d.]+)%\)/i);
  if (matchup) return `This opponent allows ${Math.abs(Number(matchup[1])).toFixed(1)}% ${Number(matchup[1]) > 0 ? 'more' : 'fewer'} fantasy points to this position than average.`;
  const recent = evidence.match(/Last (\d+) prior games average ([\d.]+); season mean ([\d.]+)/i);
  if (recent) return `Last ${recent[1]} games: ${recent[2]} points per game; season average: ${recent[3]}.`;
  if (/opportunity rate/i.test(evidence)) return 'Recent workload is included in the estimate.';
  return factor.label ? `${factor.label} is included in the estimate.` : 'A supported player or matchup factor changed the estimate.';
}

export function ProjectionDisagreementNote({ value }: { value?: ProjectionDisagreement | null }) {
  if (!value?.flagged) return null;
  const factors = value.supporting_factors || [];
  const confidence = value.data_confidence || (value.supported_by_context ? 'medium' : 'low');
  return <details className="model-disagreement" aria-label="Projection disagreement">
    <summary>Projections disagree</summary>
    <div className="projection-disagreement-summary">
      <span>Raw model <b>{value.raw_custom.toFixed(1)}</b></span>
      <span>ESPN <b>{typeof value.espn_projection === 'number' ? value.espn_projection.toFixed(1) : '--'}</b></span>
      <span>Projection <b>{typeof value.recommendation_estimate === 'number' ? value.recommendation_estimate.toFixed(1) : '--'}</b></span>
    </div>
    <strong>Why are they different?</strong>
    {factors.length ? <ul>{factors.map((factor, index) => <li key={`${factor.label}-${index}`}>
      {simpleEvidence(factor)}{typeof factor.adjustment === 'number' ? ` (${factor.adjustment > 0 ? '+' : ''}${factor.adjustment.toFixed(1)} points)` : ''}
    </li>)}</ul> : <p>The available information does not explain the full gap.</p>}
    <strong>How much should I trust this?</strong><p>Data confidence: {confidence}. The lineup estimate also considers ESPN and recent results.</p>
    <details className="projection-advanced"><summary>Advanced details</summary><p>Raw model {value.raw_custom.toFixed(2)} · reference average {value.reference_anchor.toFixed(2)} · difference {value.difference?.toFixed(2) ?? '--'}.</p>
      {!!factors.length && <ul>{factors.map((factor, index) => <li key={`detail-${index}`}>{factor.label || 'Input'}: {factor.evidence || 'Unavailable'}{factor.source ? ` · Source: ${factor.source}` : ''}</li>)}</ul>}
    </details>
  </details>;
}

export function ConfidenceDefinitions() {
  return <p className="confidence-definitions"><span title="How much reliable information we have for this player's projection.">Data confidence ⓘ</span>
    <span title="How confident we are in the lineup recommendation after comparing both players and their available information.">Start/Sit confidence ⓘ</span>
    <span title="How dependable the matchup simulation is, based on the simulated edge, points already scored, remaining uncertainty, player data, and health clarity.">Matchup confidence ⓘ</span></p>;
}
