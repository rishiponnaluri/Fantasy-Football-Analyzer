import test from 'node:test';
import assert from 'node:assert/strict';
import { usefulPlayerUpdates, updateTime, safeUpdateUrl } from '../src/lib/player-updates.mjs';

const row = (patch = {}) => ({ player_id: 1, player_name: 'Player One', week: 7, headline: 'Player One: availability — Questionable', summary: 'Questionable', source: 'Provider', category: 'availability', retrieved_at: '2026-10-21T12:00:00Z', published_at: null, source_updated_at: null, impact: 'MEDIUM', url: null, dedupe_key: 'one', ...patch });
test('stored updates are player-specific, recent-first and deduplicated across sources', () => {
  const result = usefulPlayerUpdates([
    row(), row({ dedupe_key: 'same-content', category: 'injury', source: 'Other source' }),
    row({ player_id: 2, dedupe_key: 'foreign' }),
    row({ dedupe_key: 'newer', headline: 'Player One: practice — Limited', summary: 'Limited', category: 'practice', published_at: '2026-10-21T14:00:00Z' }),
    row({ dedupe_key: 'slot-only', category: 'depth_chart', summary: 'WR' }),
  ], 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].dedupe_key, 'newer');
  assert.equal(result[1].source, 'Provider');
});
test('source time and retrieval time are never presented as invented publication', () => {
  assert.equal(updateTime(row()).label, 'Retrieved');
  const stamp = updateTime(row({ source_updated_at: '2026-10-21 08:30:00 EDT' }));
  assert.equal(stamp.label, 'Source updated');
  assert.equal(stamp.iso, '2026-10-21T12:30:00.000Z');
  assert.equal(updateTime(row({ published_at: '2026-10-21T13:00:00Z' })).label, 'Published');
});
test('links only use supplied real HTTP URLs', () => {
  assert.equal(safeUpdateUrl(null), null);
  assert.equal(safeUpdateUrl('javascript:alert(1)'), null);
  assert.equal(safeUpdateUrl('/invented/article'), null);
  assert.equal(safeUpdateUrl('https://example.org/actual-feed'), 'https://example.org/actual-feed');
});
test('update selection does not rewrite supported headlines or impact', () => {
  const high = row({ impact: 'HIGH', headline: 'Exact provider-supported update' });
  assert.deepEqual(usefulPlayerUpdates([high], 1), [high]);
  assert.deepEqual(usefulPlayerUpdates(undefined, 1), []);
});
