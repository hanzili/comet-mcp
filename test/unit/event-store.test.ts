/**
 * P1 Half 2 event-store tests — append-only log, idempotency index, durable cursors,
 * receipt stream, and the P1 gate's replay-safety criterion.
 *
 * Run: node --test test/unit/event-store.test.ts  (after npx tsc)
 *
 * These run against a temp COMET_DATA_DIR so the repo's data/ stays untouched.
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-event-store-'));
  process.env.COMET_DATA_DIR = dataDir;
  // force fresh module state (re-import after env set)
});

const es = await import('../../dist/core/event-store.js');
const drv = await import('../../dist/drivers/index.js');
const { _resetForTests, _reloadMemoryForTests, appendEvent, nextSequence, hasIdempotencyKey, getIdempotencyEvent, checkpointCursor, getCursor, listCursors, eventsForCorrelation, receiptsForCorrelation, allEvents, currentSeq, hasResponseHash, recordEnvelopeCreated, recordSendEvent, recordResponseReceived, recordResponseDeduplicated, recordDeliveryReceipt } = es;
const { makeEnvelope, replayOutcomeIfRecorded } = drv;

test('P1 H2: append-only log — seq monotonic across events, eventId/at materialized', () => {
  _resetForTests();
  const a = appendEvent({ type: 'send.queued', correlationId: 'c1' });
  const b = appendEvent({ type: 'response.received', correlationId: 'c1' });
  assert.ok(a.seq < b.seq, 'seq must be monotonic');
  assert.equal(b.seq, a.seq + 1);
  assert.ok(a.eventId.length > 0);
  assert.ok(a.at.length > 0);
  assert.equal(a.persistenceMode, 'full');
  assert.equal(currentSeq(), b.seq);
});

test('P1 H2: log is a real file — appends are durable and replayable', () => {
  _resetForTests();
  appendEvent({ type: 'envelope.created', correlationId: 'c-durable', idempotencyKey: 'k-durable' });
  appendEvent({ type: 'delivery.receipt', correlationId: 'c-durable', idempotencyKey: 'k-durable', receiptStatus: 'completed' });
  const raw = readFileSync(join(dataDir, 'event-log.jsonl'), 'utf8');
  const lines = raw.trim().split('\n');
  assert.equal(lines.length, 2, 'two JSONL rows on disk');
  const first = JSON.parse(lines[0]);
  assert.equal(first.type, 'envelope.created');
  assert.equal(first.idempotencyKey, 'k-durable');
});

test('P1 H2: idempotency index — replay with same key detected, no duplicate send', () => {
  _resetForTests();
  assert.equal(hasIdempotencyKey('k-ask-1'), false);
  appendEvent({ type: 'envelope.created', correlationId: 'c-ask', idempotencyKey: 'k-ask-1' });
  assert.equal(hasIdempotencyKey('k-ask-1'), true, 'key indexed after first envelope');
  const ev = getIdempotencyEvent('k-ask-1');
  assert.equal(ev?.idempotencyKey, 'k-ask-1');
  // a second envelope with the same key must NOT re-index / re-send — index keeps the first
  appendEvent({ type: 'envelope.created', correlationId: 'c-ask', idempotencyKey: 'k-ask-1' });
  const evs = eventsForCorrelation('c-ask');
  assert.equal(evs.filter((e) => e.type === 'envelope.created').length, 2, 'log records both (append-only), but…');
  assert.equal(getIdempotencyEvent('k-ask-1')?.seq, ev?.seq, '…the index still points at the FIRST envelope (replay returns prior outcome)');
});

test('P1 H2: response dedup — same contentHash twice → hasResponseHash true, dedup event records', () => {
  _resetForTests();
  const env = { correlationId: 'c-hash', idempotencyKey: 'k-hash' };
  const fullEnv = { ...env, source: 'grok', content: 'hi', provenance: { sourceProvider: 'grok', attributedTo: 'grok', safetyClaimed: false }, relay: { mode: 'disabled', approved: false, destinationEnabled: false }, budget: { maxTurns: 1, wallClockDeadlineMs: 0 }, createdAt: '' };
  recordEnvelopeCreated(fullEnv as any);
  assert.equal(hasResponseHash('c-hash', 'abc123'), false);
  recordResponseReceived(fullEnv as any, 'grok', { contentHash: 'abc123', cursor: 'cur-1', state: 'completed', text: 'answer', steps: [] }, 'tab-1');
  assert.equal(hasResponseHash('c-hash', 'abc123'), true, 'hash recorded');
  const dedup = recordResponseDeduplicated(fullEnv as any, 'grok', { contentHash: 'abc123', cursor: 'cur-1', state: 'completed', text: 'answer', steps: [] });
  assert.equal(dedup.type, 'response.deduplicated');
  assert.equal(eventsForCorrelation('c-hash').filter((e) => e.type === 'response.received').length, 1, 'no second received event');
});

test('P1 H2: durable cursor checkpoints — per tab, atomic rewrite, survives reload', () => {
  _resetForTests();
  assert.equal(getCursor('grok', 'tab-1'), null);
  checkpointCursor('grok', 'tab-1', 'cursor-77');
  checkpointCursor('perplexity', 'tab-9', 'cursor-99');
  assert.equal(getCursor('grok', 'tab-1'), 'cursor-77');
  assert.equal(getCursor('perplexity', 'tab-9'), 'cursor-99');
  const cursors = listCursors();
  assert.equal(Object.keys(cursors).length, 2);
  // survives a "restart": reset MEMORY only, reload indexes from disk
  _reloadMemoryForTests();
  assert.equal(getCursor('grok', 'tab-1'), 'cursor-77', 'cursor durable across store reload');
  // last write wins per tab
  checkpointCursor('grok', 'tab-1', 'cursor-78');
  assert.equal(getCursor('grok', 'tab-1'), 'cursor-78');
});

test('P1 H2: receipt stream — append-only, one row per attempt, statuses recorded', () => {
  _resetForTests();
  const r1 = recordDeliveryReceipt({ receiptId: 'r-1', envelopeId: 'e', correlationId: 'c-receipt', idempotencyKey: 'k', status: 'queued', recordedAt: '', attempt: 1 });
  const r2 = recordDeliveryReceipt({ receiptId: 'r-2', envelopeId: 'e', correlationId: 'c-receipt', idempotencyKey: 'k', status: 'completed', recordedAt: '', attempt: 2 });
  const stream = receiptsForCorrelation('c-receipt');
  assert.equal(stream.length, 2, 'receipts accumulate — never mutated in place');
  assert.equal(stream[0].receiptStatus, 'queued');
  assert.equal(stream[1].receiptStatus, 'completed');
  assert.equal(r1.seq < r2.seq, true);
});

test('P1 H2: full lifecycle — envelope.created → queued → accepted → received → receipt', () => {
  _resetForTests();
  const env = {
    correlationId: 'c-life', idempotencyKey: 'k-life', source: 'perplexity', content: 'hello',
    provenance: { sourceProvider: 'perplexity', attributedTo: 'perplexity', safetyClaimed: false },
    relay: { mode: 'disabled', approved: false, destinationEnabled: false },
    budget: { maxTurns: 1, wallClockDeadlineMs: 0 }, createdAt: '',
  } as any;
  recordEnvelopeCreated(env);
  recordSendEvent(env, 'send.queued');
  recordSendEvent(env, 'send.accepted');
  recordResponseReceived(env, 'perplexity', { contentHash: 'h1', cursor: 'c1', state: 'completed', text: 'answer', steps: ['step'] }, 'tab-x');
  recordDeliveryReceipt({ receiptId: 'r', envelopeId: 'k-life', correlationId: 'c-life', idempotencyKey: 'k-life', status: 'completed', recordedAt: '', attempt: 1, contentHash: 'h1' });
  const types = eventsForCorrelation('c-life').map((e) => e.type);
  assert.deepEqual(types, ['envelope.created', 'send.queued', 'send.accepted', 'response.received', 'delivery.receipt']);
  assert.equal(getCursor('perplexity', 'tab-x'), 'c1', 'cursor checkpointed by response.received');
  assert.equal(currentSeq(), 4);
});

test('P1 H2: corrupt log lines are skipped, not fatal (append-only integrity)', () => {
  _resetForTests();
  appendEvent({ type: 'send.queued', correlationId: 'c-ok' });
  // corrupt the last line on disk, then read — must skip it, not throw
  const log = join(dataDir, 'event-log.jsonl');
  const raw = readFileSync(log, 'utf8');
  const lines = raw.trim().split('\n');
  lines.push('{this is not json');
  writeFileSync(log, lines.join('\n') + '\n', 'utf8');
  const all = allEvents();
  assert.ok(all.length >= 1, 'corrupt tail line skipped');
  assert.equal(typeof all[0].seq, 'number');
});

test('P1 GATE: replay with same idempotencyKey returns prior outcome — NO duplicate send', () => {
  _resetForTests();
  // first send: full lifecycle, completed with a response
  const env = makeEnvelope('grok', 'key-replay-1');
  assert.equal(replayOutcomeIfRecorded(env.idempotencyKey), null, 'not recorded yet → no replay');
  recordEnvelopeCreated(env);
  recordSendEvent(env, 'send.queued');
  recordSendEvent(env, 'send.accepted');
  recordResponseReceived(env, 'grok', { contentHash: 'h-replay', cursor: 'c-replay', state: 'completed', text: 'PONG answer', steps: ['s'] }, 'tab-r');
  recordDeliveryReceipt({ receiptId: 'r', envelopeId: env.idempotencyKey, correlationId: env.correlationId, idempotencyKey: env.idempotencyKey, status: 'completed', recordedAt: '', attempt: 1, contentHash: 'h-replay' });
  // replay: same key, askAndWaitOn calls replayOutcomeIfRecorded BEFORE any send
  const replayed = replayOutcomeIfRecorded(env.idempotencyKey);
  assert.ok(replayed !== null, 'prior outcome returned');
  assert.equal(replayed?.completed, true);
  assert.equal(replayed?.response, 'PONG answer');
  assert.equal(replayed?.replayed, true);
  assert.equal(replayed?.status, 'completed');
  // no new send events were appended for the replay
  const types = eventsForCorrelation(env.correlationId).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'send.queued').length, 1, 'exactly ONE queued — replay did not re-send');
  assert.equal(types.filter((t) => t === 'response.received').length, 1, 'exactly ONE received — no duplicate response event');
  // a fresh key is NOT a replay
  const fresh = makeEnvelope('grok');
  assert.equal(replayOutcomeIfRecorded(fresh.idempotencyKey), null, 'fresh key proceeds to send');
});

test('P1 H2: makeEnvelope — distinct keys/correlations, replay-safe defaults', () => {
  _resetForTests();
  const a = makeEnvelope('perplexity');
  const b = makeEnvelope('perplexity');
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.correlationId, b.correlationId);
  const c = makeEnvelope('perplexity', 'fixed-key');
  assert.equal(c.idempotencyKey, 'fixed-key', 'explicit key respected');
  assert.equal(a.relay.mode, 'approval-required');
  assert.equal(a.provenance.safetyClaimed, false);
  assert.ok(a.budget.wallClockDeadlineMs > 0, 'deadline set');
});
