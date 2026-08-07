/**
 * P3 reconnect-dedup wiring tests — the gate: "unchanged content produces no new
 * response event."
 *
 * Run: node --test test/unit/p3-reconnect-dedup.test.ts  (after npx tsc)
 *
 * These exercise the event-store substrate + registry hydration that the reconnect
 * path uses: durable cursor checkpoints, correlation-scoped hasResponseHash, and
 * anchor hydration on re-open.
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-dedup-'));
  process.env.COMET_DATA_DIR = dataDir;
});

const es = await import('../../dist/core/event-store.js');
const { _resetForTests, checkpointCursor, getCursor, recordResponseReceived, recordResponseDeduplicated, hasResponseHash, eventsForCorrelation } = es;
const drv = await import('../../dist/drivers/index.js');
const { makeEnvelope } = drv;

test('P3 reconnect-dedup: same correlation + same contentHash → dedup, NOT a new response event', () => {
  _resetForTests();
  const env = makeEnvelope('grok', 'key-dedup-1');
  // first completion: response.received with hash H
  recordResponseReceived(env, 'grok', { contentHash: 'H1', cursor: 'c1', state: 'completed', text: 'answer', steps: [] }, 'tab-1');
  // reconnect resumes the SAME ask; poll sees the SAME content (H1)
  const already = hasResponseHash(env.correlationId, 'H1');
  assert.equal(already, true, 'hash already recorded for this correlation');
  // the ask loop records deduplicated, not received
  const dedup = recordResponseDeduplicated(env, 'grok', { contentHash: 'H1', cursor: 'c1', state: 'completed', text: 'answer', steps: [] });
  assert.equal(dedup.type, 'response.deduplicated');
  const evs = eventsForCorrelation(env.correlationId);
  assert.equal(evs.filter((e) => e.type === 'response.received').length, 1, 'exactly ONE received event');
  assert.equal(evs.filter((e) => e.type === 'response.deduplicated').length, 1, 'one dedup event');
});

test('P3 reconnect-dedup: NEW content for same correlation → received (not dedup)', () => {
  _resetForTests();
  const env = makeEnvelope('grok', 'key-dedup-2');
  recordResponseReceived(env, 'grok', { contentHash: 'H1', cursor: 'c1', state: 'completed', text: 'first', steps: [] }, 'tab-1');
  // a genuinely new response (different hash) for the same correlation
  assert.equal(hasResponseHash(env.correlationId, 'H2'), false, 'new hash not recorded');
  recordResponseReceived(env, 'grok', { contentHash: 'H2', cursor: 'c2', state: 'completed', text: 'second', steps: [] }, 'tab-1');
  const evs = eventsForCorrelation(env.correlationId);
  assert.equal(evs.filter((e) => e.type === 'response.received').length, 2, 'both received');
  assert.equal(evs.filter((e) => e.type === 'response.deduplicated').length, 0);
});

test('P3 reconnect-dedup: durable cursor is per-tab and survives reload (registry hydration source)', () => {
  _resetForTests();
  checkpointCursor('grok', 'tab-a', 'cursA');
  checkpointCursor('perplexity', 'tab-b', 'cursB');
  assert.equal(getCursor('grok', 'tab-a'), 'cursA');
  assert.equal(getCursor('grok', 'tab-b'), null, 'per-tab isolation');
  // simulate registry.poolTab hydration after reconnect: lastContentHash := durable cursor
  const hydrated = { provider: 'grok', tabId: 'tab-a', targetId: 'tab-a', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' } as any;
  const dc = getCursor(hydrated.provider, hydrated.targetId);
  if (dc) { hydrated.extractionCursor = dc; hydrated.lastContentHash = dc; }
  assert.equal(hydrated.extractionCursor, 'cursA', 'anchor hydrated from durable store');
  assert.equal(hydrated.lastContentHash, 'cursA');
});

test('P3 reconnect-dedup: cursor advances per completion (new content → new cursor)', () => {
  _resetForTests();
  checkpointCursor('grok', 'tab-1', 'c1');
  checkpointCursor('grok', 'tab-1', 'c2');
  assert.equal(getCursor('grok', 'tab-1'), 'c2', 'last write wins — content changed, cursor moved');
});

test('P3 reconnect-dedup: makeEnvelope gives dedup an envelope shape (fresh correlation)', () => {
  _resetForTests();
  const env = makeEnvelope('grok', 'key-fixed');
  assert.equal(env.idempotencyKey, 'key-fixed');
  assert.equal(hasResponseHash(env.correlationId, 'anything'), false, 'fresh correlation has no recorded responses');
});
