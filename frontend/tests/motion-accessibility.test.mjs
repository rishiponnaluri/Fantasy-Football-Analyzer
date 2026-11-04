import test from 'node:test';
import assert from 'node:assert/strict';
import { motionAllowed } from '../src/lib/motion.ts';

test('motion is disabled without a browser', () => {
  assert.equal(motionAllowed(), false);
});

test('motion responds immediately when the reduced-motion preference changes', t => {
  let reduced = false;
  globalThis.window = { matchMedia: query => {
    assert.equal(query, '(prefers-reduced-motion: reduce)');
    return { matches: reduced };
  } };
  t.after(() => { delete globalThis.window; });
  assert.equal(motionAllowed(), true);
  reduced = true;
  assert.equal(motionAllowed(), false);
  reduced = false;
  assert.equal(motionAllowed(), true);
});
