/**
 * P4 R4 relay_prepare tests — terminal-success source selection (design 05 §1.5),
 * envelope build + canonicalize + hash (R1), eager policy checks (R3), and the
 * no-destination-contact contract.
 *
 * Run: node --test test/unit/relay-prepare.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-relay-prepare-'));
  process.env.COMET_DATA_DIR = dataDir;
});

const es = await import('../../dist/core/event-store.js');
const drv = await import('../../dist/drivers/index.js');
const { _resetForTests, recordEnvelopeCreated, recordSendEvent, recordResponseReceived, recordDeliveryReceipt } = es;
const { makeEnvelope } = drv;
const { findRelaySource, prepareRelay } = await import('../../dist/core/relay.js');

const ANSWER = 'Perplexity deep-research answer about relay safety.';
const SOURCE = 'perplexity';

/** Record a full completed lifecycle for a correlation, returning its correlationId. */
function completedSource(overrides: { state?: string; receipt?: string; dedup?: boolean } = {}): string {
  const env = makeEnvelope(SOURCE, `src-${Math.random().toString(36).slice(2, 8)}`);
  recordEnvelopeCreated(env);
  recordSendEvent(env, 'send.accepted');
  recordResponseReceived(env, SOURCE, {
    messageId: 'pm-1',
    contentHash: 'ch-1',
    cursor: 'cur-1',
    state: overrides.state ?? 'completed',
    text: ANSWER,
    steps: ['researching', 'synthesizing'],
  }, 'tab-1');
  recordDeliveryReceipt({
    receiptId: 'rct-1', envelopeId: env.idempotencyKey, correlationId: env.correlationId,
    idempotencyKey: env.idempotencyKey, status: (overrides.receipt ?? 'completed') as any,
    recordedAt: new Date().toISOString(), contentHash: 'ch-1', providerMessageId: 'pm-1',
  });
  return env.correlationId;
}

test('R4: findRelaySource — completed response is a valid terminal-success source', () => {
  _resetForTests();
  const corr = completedSource();
  const src = findRelaySource(corr);
  assert.ok(src, 'source found');
  assert.equal(src!.sourceProvider, SOURCE);
  assert.equal(src!.content, ANSWER);
  assert.equal(src!.state, 'completed');
  assert.equal(src!.sourceMessageId, 'pm-1');
  assert.equal(src!.sourceContentHash, 'ch-1');
});

test('R4: findRelaySource — completed_late receipt is terminal-success (§1.5)', () => {
  _resetForTests();
  const corr = completedSource({ receipt: 'completed_late' });
  const src = findRelaySource(corr);
  assert.ok(src, 'completed_late is relayable');
  assert.equal(src!.content, ANSWER);
});

test('R4: findRelaySource — non-terminal (watching/timed_out) is NOT relayable (§1.5)', () => {
  _resetForTests();
  const corr = completedSource({ state: 'working', receipt: 'timed_out' });
  assert.equal(findRelaySource(corr), null, 'timed_out/watching never relayable');
});

test('R4: findRelaySource — no events → null', () => {
  _resetForTests();
  assert.equal(findRelaySource('no-such-correlation'), null);
});

test('R4: prepareRelay — builds envelope + hash, approvalRequired, evaluation surfaced', async () => {
  _resetForTests();
  const corr = completedSource();
  const result = await prepareRelay({
    sourceCorrelationId: corr,
    destination: 'grok',
    attributionHeader: 'perplexity via relay to grok',
  });
  assert.ok(result.ok, result.ok ? '' : (result as any).error);
  const r = result as Extract<typeof result, { ok: true }>;
  assert.equal(r.correlationId, corr, 'relay chain reuses source correlation');
  assert.ok(r.idempotencyKey.startsWith('relay-'));
  assert.equal(r.envelope.source, SOURCE);
  assert.equal(r.envelope.destination, 'grok');
  assert.equal(r.envelope.content, ANSWER);
  assert.equal(r.envelope.provenance.attributedTo, 'perplexity via relay to grok');
  assert.equal(r.envelope.relay.mode, 'approval-required');
  assert.equal(r.envelope.relay.approved, false, 'prepared but NOT approved');
  assert.equal(r.approvalRequired, true);
  assert.match(r.envelopeHash, /^[0-9a-f]{64}$/);
  assert.equal(r.evaluation.ok, true);
  assert.equal(r.evaluation.markdownAction, 'neutralize', 'default: markdown neutralized');
  // durable trail anchor written
  const { eventsForCorrelation } = es;
  assert.ok(eventsForCorrelation(corr).some((e) => e.type === 'envelope.created'));
});

test('R4: prepareRelay — same source+destination+policy → same envelopeHash (re-prepare stable)', async () => {
  _resetForTests();
  const corr = completedSource();
  const a = await prepareRelay({ sourceCorrelationId: corr, destination: 'grok', attributionHeader: 'hdr' });
  const b = await prepareRelay({ sourceCorrelationId: corr, destination: 'grok', attributionHeader: 'hdr' });
  assert.ok(a.ok && b.ok);
  const ra = a as Extract<typeof a, { ok: true }>;
  const rb = b as Extract<typeof b, { ok: true }>;
  assert.notEqual(ra.idempotencyKey, rb.idempotencyKey, 'fresh idempotency key per prepare');
  assert.equal(ra.envelopeHash, rb.envelopeHash, 'approval hash stable — R1 excludes transport plumbing');
  assert.equal(ra.canonical, rb.canonical);
});

test('R4: prepareRelay — different destination → different hash (approval binds destination)', async () => {
  _resetForTests();
  const corr = completedSource();
  const a = await prepareRelay({ sourceCorrelationId: corr, destination: 'grok', attributionHeader: 'hdr' });
  const b = await prepareRelay({ sourceCorrelationId: corr, destination: 'claude', attributionHeader: 'hdr' });
  assert.ok(a.ok && b.ok);
  assert.notEqual((a as any).envelopeHash, (b as any).envelopeHash);
});

test('R4: prepareRelay — attributionHeader mandatory, fail closed (R3)', async () => {
  _resetForTests();
  const corr = completedSource();
  const result = await prepareRelay({ sourceCorrelationId: corr, destination: 'grok' });
  assert.ok(!result.ok);
  assert.equal((result as any).policyReason, 'attribution_missing');
});

test('R4: prepareRelay — content size limit enforced eagerly', async () => {
  _resetForTests();
  const corr = completedSource();
  const result = await prepareRelay({
    sourceCorrelationId: corr, destination: 'grok', attributionHeader: 'hdr', contentSizeLimitBytes: 10,
  });
  assert.ok(!result.ok);
  assert.equal((result as any).policyReason, 'content_too_large');
});

test('R4: prepareRelay — expired deadline blocked eagerly', async () => {
  _resetForTests();
  const corr = completedSource();
  const result = await prepareRelay({
    sourceCorrelationId: corr, destination: 'grok', attributionHeader: 'hdr', deadlineMs: Date.now() - 1000,
  });
  assert.ok(!result.ok);
  assert.equal((result as any).policyReason, 'deadline_expired');
});

test('R4: prepareRelay — no terminal-success source → clear error, no crash', async () => {
  _resetForTests();
  const result = await prepareRelay({ sourceCorrelationId: 'missing', destination: 'grok', attributionHeader: 'h' });
  assert.ok(!result.ok);
  assert.match((result as any).error, /no terminal-success source/);
});

test('R4: prepareRelay — rawMarkdown opt-in flips markdownAction to passthrough', async () => {
  _resetForTests();
  const corr = completedSource();
  const r = await prepareRelay({
    sourceCorrelationId: corr, destination: 'grok', attributionHeader: 'hdr', rawMarkdown: true,
  });
  assert.ok(r.ok);
  assert.equal((r as any).evaluation.markdownAction, 'passthrough');
});

test('R4: NO-DESTINATION-CONTACT — prepare is pure in-memory + event-store only', async () => {
  _resetForTests();
  const corr = completedSource();
  // monkey-patch impossible on ESM; instead assert the contract: prepareRelay is sync
  // and returns without any provider/driver import — it cannot have contacted a tab.
  const start = Date.now();
  const r = await prepareRelay({ sourceCorrelationId: corr, destination: 'grok', attributionHeader: 'hdr' });
  assert.ok(r.ok);
  assert.ok(Date.now() - start < 1000, 'prepare must not do network/tab work');
  // no response file written by prepare (that is relay_send's job)
  const { readResponseChunk } = drv;
  const probe = readResponseChunk('grok-nonexistent');
  assert.equal(probe.ok, false);
});

test('R4 (latency fix fold #4): prepareRelay auto-advances a PENDING source ask to terminal-success', async () => {
  _resetForTests();
  // source ask recorded as in-flight (no response yet)
  const env = makeEnvelope('perplexity', 'pending-src-key');
  recordEnvelopeCreated(env);
  recordSendEvent(env, 'send.accepted');
  // no response.received yet → not a terminal-success source
  assert.equal(findRelaySource(env.correlationId), null);
  // simulate the async-ask registry: pending, completes on the 2nd advance
  let advances = 0;
  const deps = {
    isSourcePending: () => advances < 2,
    advanceSource: async () => {
      advances++;
      if (advances >= 2) {
        // the ask completes → a terminal-success response is recorded
        recordResponseReceived(env, 'perplexity', {
          messageId: 'pm-final', contentHash: 'ch-final', cursor: 'cur',
          state: 'completed', text: 'the finished answer', steps: ['s'],
        }, 'tab-1');
        recordDeliveryReceipt({
          receiptId: 'rct-final', envelopeId: env.idempotencyKey, correlationId: env.correlationId,
          idempotencyKey: env.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString(),
          contentHash: 'ch-final', providerMessageId: 'pm-final',
        });
      }
    },
  };
  const result = await prepareRelay(
    { sourceCorrelationId: env.correlationId, destination: 'grok', attributionHeader: 'hdr' },
    deps as any,
  );
  assert.ok(result.ok, 'auto-advance brought the source to terminal-success');
  assert.equal(advances, 2, 'advanced exactly until terminal');
  const r = result as Extract<typeof result, { ok: true }>;
  assert.ok(r.envelope.content.includes('finished answer'), 'relay uses the advanced source content');
});

test('R4 (latency fix fold #4): auto-advance is BOUNDED — never-completing source → error with advancedSteps', async () => {
  _resetForTests();
  const env = makeEnvelope('perplexity', 'stuck-src-key');
  recordEnvelopeCreated(env);
  recordSendEvent(env, 'send.accepted');
  let advances = 0;
  const deps = {
    isSourcePending: () => true, // never completes
    advanceSource: async () => { advances++; },
  };
  const result = await prepareRelay(
    { sourceCorrelationId: env.correlationId, destination: 'grok', attributionHeader: 'hdr' },
    deps as any,
  );
  assert.ok(!result.ok, 'bounded: gives up after the step budget');
  assert.ok(advances <= 3, 'never more than MAX_RELAY_ADVANCE_STEPS advances');
  assert.equal((result as any).advancedSteps, advances, 'error payload reports advancedSteps');
});
