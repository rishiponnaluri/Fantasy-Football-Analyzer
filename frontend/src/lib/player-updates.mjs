/** Stored-record presentation only. No fetching, classification, or model inputs. */
const zones = { UTC: '+00:00', EDT: '-04:00', EST: '-05:00', CDT: '-05:00', CST: '-06:00', MDT: '-06:00', MST: '-07:00', PDT: '-07:00', PST: '-08:00' };
/** @param {string | null | undefined} value */
function parseTime(value) {
  if (!value) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([A-Z]+)$/);
  const normalized = match && zones[/** @type {keyof typeof zones} */ (match[3])]
    ? `${match[1]}T${match[2]}${zones[/** @type {keyof typeof zones} */ (match[3])]}` : value;
  const stamp = Date.parse(normalized);
  return Number.isFinite(stamp) ? stamp : null;
}
/** @param {import('./types').StoredPlayerUpdate} row */
export function updateTime(row) {
  for (const [label, raw] of [['Published', row.published_at], ['Source updated', row.source_updated_at], ['Retrieved', row.retrieved_at]]) {
    const millis = parseTime(raw);
    if (millis !== null) return { label, millis, iso: new Date(millis).toISOString() };
  }
  return { label: 'Time unavailable', millis: 0, iso: null };
}
/** @param {string | null | undefined} value */
export function safeUpdateUrl(value) {
  if (!value) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? value : null; }
  catch { return null; }
}
/** @param {string | null | undefined} value */
const normalize = value => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
/** @param {import('./types').StoredPlayerUpdate[] | undefined} rows @param {number} playerId */
export function usefulPlayerUpdates(rows, playerId) {
  const keys = new Set();
  const content = new Set();
  return (rows || []).filter(row => row.player_id === playerId && row.headline?.trim() && row.source?.trim())
    // A plain position listing is roster metadata, not a meaningful depth change.
    .filter(row => !(row.category === 'depth_chart' && /^(QB|RB|WR|TE|K|D\/ST|FB|LS|OL|DL|LB|DB)$/i.test(row.summary?.trim() || '')))
    // Opaque roster-status codes are not readable news; do not infer their meaning.
    .filter(row => !(row.category === 'availability' && /^[A-Z]\d{2}$/i.test(row.summary?.trim() || '')))
    .slice().sort((a, b) => updateTime(b).millis - updateTime(a).millis)
    .filter(row => {
      const category = ['availability', 'injury'].includes(row.category) ? 'status' : row.category;
      const identity = `${row.week}:${category}:${normalize(row.summary || row.headline)}`;
      if ((row.dedupe_key && keys.has(row.dedupe_key)) || content.has(identity)) return false;
      if (row.dedupe_key) keys.add(row.dedupe_key);
      content.add(identity);
      return true;
    });
}
