/**
 * P4 R2 ContentPersistenceMode tests — per-destination mode contract + write-path
 * wiring (design 05 §2, §3.2) + no-leak escalation audit (§3.8: all three modes
 * exercised; no full-content leak under redacted/none).
 *
 * Run: node --test test/unit/persistence-modes.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-persistence-'));
  process.env.COMET_DATA_DIR = dataDir;
});

const es = await import('../../dist/core/event-store.js');
const drv = await import('../../dist/drivers/index.js');
const {
  _resetForTests, appendEvent, resolveContentPersistenceMode, redactResponseForMode,
  recordEnvelopeCreated, recordResponseReceived, recordResponseDeduplicated, recordDeliveryReceipt,
} = es;
const { makeEnvelope } = drv;

const SECRET_TEXT = 'super-secret-relay-content-do-not-persist-42';

function relayEnvelope(opts: { mode?: 'disabled' | 'approval-required' | 'enabled'; cpm?: 'full' | 'redacted' | 'none' } = {}) {
  const env = makeEnvelope('grok', `r2-${Math.random().toString(36).slice(2, 8)}`);
  return {
    ...env,
    destination: 'perplexity',
    content: SECRET_TEXT,
    relay: {
      ...env.relay,
      mode: opts.mode ?? 'approval-required',
      ...(opts.cpm ? { contentPersistenceMode: opts.cpm } : {}),
    },
  } as ReturnType<typeof makeEnvelope> & { destination: string };
}

const SAMPLE_RESPONSE = {
  messageId: 'msg-9',
  contentHash: 'abc123',
  cursor: 'cur-7',
  state: 'completed',
  text: SECRET_TEXT,
  steps: ['searching', 'synthesizing'],
};

test('R2: resolveContentPersistenceMode — relay ⇒ redacted default, disabled ⇒ full, override wins', () => {
  assert.equal(resolveContentPersistenceMode(relayEnvelope({ mode: 'approval-required' })), 'redacted');
  assert.equal(resolveContentPersistenceMode(relayEnvelope({ mode: 'enabled' })), 'redacted');
  assert.equal(resolveContentPersistenceMode(relayEnvelope({ mode: 'disabled' })), 'full');
  assert.equal(resolveContentPersistenceMode(relayEnvelope({ mode: 'approval-required', cpm: 'full' })), 'full');
  assert.equal(resolveContentPersistenceMode(relayEnvelope({ mode: 'approval-required', cpm: 'none' })), 'none');
});

test('R2 REGRESSION GUARD: native ask (no destination, conservative defaults) ⇒ full — replay-safe', () => {
  // makeEnvelope() builds native-ask envelopes with CONSERVATIVE_RELAY_DEFAULTS
  // (mode approval-required, NO destination). These are the provider_ask path —
  // they must persist FULL content so replayOutcomeIfRecorded() returns the real
  // answer after restart. Keying on destination (not mode) preserves this.
  const env = makeEnvelope('grok', 'native-replay-guard');
  assert.equal(env.destination, undefined, 'native ask has no destination');
  assert.equal(env.relay.mode, 'approval-required', 'conservative defaults used');
  assert.equal(resolveContentPersistenceMode(env), 'full', 'native ask must resolve to full');
  // and the full write path must keep content for that envelope
  _resetForTests();
  const ev = recordResponseReceived(
    { ...env, content: SECRET_TEXT } as ReturnType<typeof makeEnvelope>,
    'grok',
    { ...SAMPLE_RESPONSE, text: SECRET_TEXT },
    'tab-native',
  );
  assert.equal(ev.persistenceMode, 'full');
  assert.equal(ev.response?.poll.response, SECRET_TEXT, 'native ask content persisted for replay');
});

test('R2: appendEvent full mode — content persisted verbatim', () => {
  _resetForTests();
  const ev = appendEvent({
    type: 'response.received', correlationId: 'c-full',
    persistenceMode: 'full',
    response: { provider: 'grok', messageId: 'm', contentHash: 'h', cursor: 'c', poll: { state: 'completed', response: SECRET_TEXT, steps: ['s'] } },
  });
  assert.equal(ev.response?.poll.response, SECRET_TEXT, 'full mode keeps content');
  assert.equal(ev.response?.contentLength, undefined);
  assert.equal(ev.persistenceMode, 'full');
});

test('R2: appendEvent redacted — metadata only, no content, length present', () => {
  _resetForTests();
  const ev = appendEvent({
    type: 'response.received', correlationId: 'c-red',
    persistenceMode: 'redacted',
    response: { provider: 'grok', messageId: 'm', contentHash: 'h', cursor: 'c', poll: { state: 'completed', response: SECRET_TEXT, steps: ['s1', 's2'] } },
  });
  assert.equal(ev.response?.poll.response, '', 'redacted drops content');
  assert.deepEqual(ev.response?.poll.steps, [], 'redacted drops steps');
  assert.equal(ev.response?.messageId, 'm', 'metadata kept');
  assert.equal(ev.response?.contentHash, 'h', 'hash kept');
  assert.equal(ev.response?.cursor, 'c', 'cursor kept');
  assert.equal(ev.response?.contentLength, SECRET_TEXT.length, 'length kept as metadata');
  assert.equal(ev.persistenceMode, 'redacted');
});

test('R2: appendEvent none — control plane only, no length either', () => {
  _resetForTests();
  const ev = appendEvent({
    type: 'response.received', correlationId: 'c-none',
    persistenceMode: 'none',
    response: { provider: 'grok', messageId: 'm', contentHash: 'h', cursor: 'c', poll: { state: 'completed', response: SECRET_TEXT, steps: ['s1'] } },
  });
  assert.equal(ev.response?.poll.response, '', 'none drops content');
  assert.equal(ev.response?.poll.state, 'completed', 'status kept (control plane)');
  assert.equal(ev.response?.contentHash, 'h', 'hash kept');
  assert.equal(ev.response?.messageId, 'm', 'id kept');
  assert.equal(ev.response?.contentLength, undefined, 'none omits length');
  assert.equal(ev.persistenceMode, 'none');
});

test('R2: recordResponseReceived inherits envelope mode (redacted) — no leak', () => {
  _resetForTests();
  const env = relayEnvelope({ mode: 'approval-required' }); // default redacted
  const ev = recordResponseReceived(env, 'perplexity', SAMPLE_RESPONSE, 'tab-1');
  assert.equal(ev.persistenceMode, 'redacted');
  assert.equal(ev.response?.poll.response, '', 'no content under default relay mode');
  assert.equal(ev.response?.contentLength, SECRET_TEXT.length);
  assert.equal(ev.response?.contentHash, 'abc123');
});

test('R2: recordResponseReceived none mode — explicit override honored', () => {
  _resetForTests();
  const env = relayEnvelope({ mode: 'approval-required', cpm: 'none' });
  const ev = recordResponseReceived(env, 'perplexity', SAMPLE_RESPONSE, 'tab-1');
  assert.equal(ev.persistenceMode, 'none');
  assert.equal(ev.response?.poll.response, '');
  assert.equal(ev.response?.contentLength, undefined);
  assert.equal(ev.response?.contentHash, 'abc123');
});

test('R2: deduplicated response also redacted under relay mode', () => {
  _resetForTests();
  const env = relayEnvelope({ mode: 'approval-required' });
  const ev = recordResponseDeduplicated(env, 'perplexity', SAMPLE_RESPONSE);
  assert.equal(ev.persistenceMode, 'redacted');
  assert.equal(ev.response?.poll.response, '');
});

test('R2: receipts carry the mode', () => {
  _resetForTests();
  const receipt = {
    receiptId: 'r1', envelopeId: 'e1', correlationId: 'c-receipt', idempotencyKey: 'k1',
    status: 'completed' as const, recordedAt: new Date().toISOString(),
    persistenceMode: 'none' as const,
  };
  const ev = recordDeliveryReceipt(receipt);
  assert.equal(ev.persistenceMode, 'none');
  // default when not carried
  const ev2 = recordDeliveryReceipt({ ...receipt, receiptId: 'r2', persistenceMode: undefined });
  assert.equal(ev2.persistenceMode, 'full');
});

test('R2 ESCALATION AUDIT (§3.8): no full-content leak in the log under redacted/none', () => {
  _resetForTests();
  // full lifecycle under default relay mode (redacted): envelope + send + response + receipt
  const env = relayEnvelope({ mode: 'approval-required' });
  recordEnvelopeCreated(env);
  recordResponseReceived(env, 'perplexity', SAMPLE_RESPONSE, 'tab-1');
  recordDeliveryReceipt({
    receiptId: 'r1', envelopeId: env.idempotencyKey, correlationId: env.correlationId,
    idempotencyKey: env.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString(),
    persistenceMode: 'redacted',
  });
  // explicit none mode lifecycle
  const envNone = relayEnvelope({ mode: 'approval-required', cpm: 'none' });
  recordEnvelopeCreated(envNone);
  recordResponseReceived(envNone, 'perplexity', SAMPLE_RESPONSE, 'tab-2');
  // THE audit: the secret must not appear anywhere in the raw log file
  const raw = readFileSync(join(dataDir, 'event-log.jsonl'), 'utf8');
  assert.ok(!raw.includes(SECRET_TEXT), 'secret text must NOT appear in the append-only log');
  // but dedup anchors survive (reconciliation works via hashes/ids — design §2)
  assert.ok(raw.includes('abc123'), 'contentHash survives for reconciliation');
  assert.ok(raw.includes('msg-9'), 'providerMessageId survives');
  // markers present
  assert.ok(raw.includes('"persistenceMode":"redacted"'));
  assert.ok(raw.includes('"persistenceMode":"none"'));
});

test('R2: redactResponseForMode unit — full passthrough, redacted/none shapes', () => {
  const response = { provider: 'grok' as const, messageId: 'm', contentHash: 'h', cursor: 'c', poll: { state: 'completed', response: SECRET_TEXT, steps: ['x'] } };
  const full = redactResponseForMode(response, 'full');
  assert.equal(full?.poll.response, SECRET_TEXT);
  const red = redactResponseForMode(response, 'redacted');
  assert.equal(red?.poll.response, '');
  assert.equal(red?.contentLength, SECRET_TEXT.length);
  assert.equal(red?.poll.steps?.length, 0);
  const none = redactResponseForMode(response, 'none');
  assert.equal(none?.poll.response, '');
  assert.equal(none?.contentLength, undefined);
  assert.equal(none?.contentHash, 'h');
});
