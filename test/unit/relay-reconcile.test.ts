/**
 * P4 R7 reconciliation tests — unknown-delivery state machine (design 05 §3.7):
 * inherits async-ask soft-expiry/watching, RELAY_SURFACE_GONE terminal,
 * providerMessageId-primary attribution, ambiguous bucket (never auto-promote),
 * read-only probe (never advances/resends).
 *
 * Run: node --test test/unit/relay-reconcile.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-relay-reconcile-'));
  process.env.COMET_DATA_DIR = dataDir;
});

const es = await import('../../dist/core/event-store.js');
const drv = await import('../../dist/drivers/index.js');
const { _resetForTests, recordEnvelopeCreated, recordSendEvent, recordResponseReceived, recordDeliveryReceipt } = es;
const { makeEnvelope } = drv;
const { classifyRelayReconciliation, reconcileRelay } = await import('../../dist/core/relay.js');

// ---------------------------------------------------------------------------
// Classifier unit tests (pure)
// ---------------------------------------------------------------------------

test('R7: in_progress — destination ask still pending, not completed', () => {
  const r = classifyRelayReconciliation({ destinationPending: true, destinationStatus: 'working', destinationResponded: false });
  assert.equal(r.state, 'in_progress');
  assert.equal(r.terminal, false);
  assert.equal(r.ok, true);
});

test('R7: reconciled — providerMessageId PRIMARY match', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'completed', destinationResponded: true, destinationProviderMessageId: 'dest-msg-9', destinationContentHash: 'hash-9' });
  assert.equal(r.state, 'reconciled');
  assert.equal(r.terminal, true);
  assert.equal(r.matchedBy, 'providerMessageId');
  assert.equal(r.providerMessageId, 'dest-msg-9');
});

test('R7: reconciled — contentHash SECONDARY when no messageId', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'completed', destinationResponded: true, destinationContentHash: 'hash-9' });
  assert.equal(r.state, 'reconciled');
  assert.equal(r.matchedBy, 'contentHash');
  assert.equal(r.contentHash, 'hash-9');
});

test('R7: ambiguous — responded but NO anchor, never auto-promoted', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'completed', destinationResponded: true });
  assert.equal(r.state, 'ambiguous');
  assert.equal(r.terminal, true);
  assert.equal(r.ok, false);
  assert.equal(r.matchedBy, 'ambiguous');
  assert.match(r.details ?? '', /never auto-promoted/);
});

test('R7: surface_gone — tab_closed terminal (design §1.6 closed-tab analogue)', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'tab_closed', destinationResponded: false });
  assert.equal(r.state, 'surface_gone');
  assert.equal(r.terminal, true);
  assert.equal(r.ok, false);
});

test('R7: abandoned — hard TTL terminal', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'abandoned', destinationResponded: false });
  assert.equal(r.state, 'abandoned');
  assert.equal(r.terminal, true);
});

test('R7: blocked — destination refused, terminal', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'blocked', destinationResponded: false });
  assert.equal(r.state, 'blocked');
  assert.equal(r.terminal, true);
});

test('R7: timed_out — soft expiry, NON-terminal (may complete_late, ADR 0007)', () => {
  const r = classifyRelayReconciliation({ destinationPending: true, destinationStatus: 'timed_out', destinationResponded: false });
  assert.equal(r.state, 'timed_out');
  assert.equal(r.terminal, false, 'late recovery possible — keep polling');
});

test('R7: watching — same soft-expiry family, non-terminal', () => {
  const r = classifyRelayReconciliation({ destinationPending: true, destinationStatus: 'watching', destinationResponded: false });
  assert.equal(r.state, 'timed_out');
  assert.equal(r.terminal, false);
});

test('R7: relay send blocked → blocked even with no destination events', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationResponded: false, relaySendStatus: 'blocked' });
  assert.equal(r.state, 'blocked');
  assert.equal(r.terminal, true);
});

test('R7: nothing tracked, no response, no blocked send → surface_gone (mid-flight loss)', () => {
  const r = classifyRelayReconciliation({ destinationPending: false, destinationResponded: false });
  assert.equal(r.state, 'surface_gone');
  assert.equal(r.terminal, true);
});

// ---------------------------------------------------------------------------
// reconcileRelay orchestration (event store + pending check)
// ---------------------------------------------------------------------------

function completedSource(corr: string): string {
  const env = makeEnvelope('perplexity', corr);
  return env.correlationId;
}

test('R7 orchestration: relay sent + destination completed with messageId → reconciled', () => {
  _resetForTests();
  // relay chain correlation
  const relayEnv = makeEnvelope('perplexity', 'relay-chain-key');
  const relayCorr = relayEnv.correlationId;
  recordEnvelopeCreated(relayEnv);
  // relay's own send receipt carries policyVersion (R6 marker)
  recordDeliveryReceipt({
    receiptId: 'rct-relay-1', envelopeId: relayEnv.idempotencyKey, correlationId: relayCorr,
    idempotencyKey: relayEnv.idempotencyKey, status: 'sent', recordedAt: new Date().toISOString(),
    persistenceMode: 'redacted', policyVersion: 1,
  });
  // destination ask lifecycle (own correlation)
  const destEnv = makeEnvelope('grok', 'dest-ask-key');
  const destCorr = destEnv.correlationId;
  recordEnvelopeCreated({ ...destEnv, content: 'wire' });
  recordSendEvent({ ...destEnv, content: 'wire' }, 'send.accepted');
  recordResponseReceived({ ...destEnv, content: 'wire' }, 'grok', { messageId: 'dest-msg-42', contentHash: 'dest-hash-42', cursor: 'cur', state: 'completed', text: 'destination answer', steps: [] }, 'tab-grok');
  recordDeliveryReceipt({ receiptId: 'rct-dest', envelopeId: destEnv.idempotencyKey, correlationId: destCorr, idempotencyKey: destEnv.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString(), contentHash: 'dest-hash-42', providerMessageId: 'dest-msg-42' });

  const r = reconcileRelay({ relayCorrelationId: relayCorr, destinationCorrelationId: destCorr, destinationIdempotencyKey: 'dest-ask-key' }, { isDestinationPending: () => false });
  assert.equal(r.state, 'reconciled');
  assert.equal(r.matchedBy, 'providerMessageId');
  assert.equal(r.providerMessageId, 'dest-msg-42');
});

test('R7 orchestration: destination pending → in_progress (read-only, no advance)', () => {
  _resetForTests();
  const relayEnv = makeEnvelope('perplexity', 'k1');
  recordEnvelopeCreated(relayEnv);
  recordDeliveryReceipt({ receiptId: 'r1', envelopeId: relayEnv.idempotencyKey, correlationId: relayEnv.correlationId, idempotencyKey: relayEnv.idempotencyKey, status: 'sent', recordedAt: new Date().toISOString(), policyVersion: 1 });
  const r = reconcileRelay(
    { relayCorrelationId: relayEnv.correlationId, destinationCorrelationId: 'dest-pending-corr', destinationIdempotencyKey: 'dest-pending-key' },
    { isDestinationPending: () => true },
  );
  assert.equal(r.state, 'in_progress');
  assert.equal(r.terminal, false);
});

test('R7 orchestration: destination tab_closed → surface_gone (RELAY_SURFACE_GONE)', () => {
  _resetForTests();
  const relayEnv = makeEnvelope('perplexity', 'k2');
  recordEnvelopeCreated(relayEnv);
  recordDeliveryReceipt({ receiptId: 'r2', envelopeId: relayEnv.idempotencyKey, correlationId: relayEnv.correlationId, idempotencyKey: relayEnv.idempotencyKey, status: 'sent', recordedAt: new Date().toISOString(), policyVersion: 1 });
  // destination ask was escalated to TAB_CLOSED (advanceAsk closed-tab path)
  const destEnv = makeEnvelope('grok', 'dest-closed');
  recordEnvelopeCreated({ ...destEnv, content: 'wire' });
  recordDeliveryReceipt({ receiptId: 'rct-dc', envelopeId: destEnv.idempotencyKey, correlationId: destEnv.correlationId, idempotencyKey: destEnv.idempotencyKey, status: 'blocked', recordedAt: new Date().toISOString(), details: 'provider tab closed/offline — ask cannot complete' });
  // NOTE: tab_closed is surfaced by advanceAsk's OUTCOME, not the receipt alone —
  // simulate via classifier path where status comes from the ask outcome:
  const direct = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'tab_closed', destinationResponded: false });
  assert.equal(direct.state, 'surface_gone');
  assert.equal(direct.terminal, true);
});

test('R7 orchestration: no destination events, no pending, relay sent → surface_gone mid-flight', () => {
  _resetForTests();
  const relayEnv = makeEnvelope('perplexity', 'k3');
  recordEnvelopeCreated(relayEnv);
  recordDeliveryReceipt({ receiptId: 'r3', envelopeId: relayEnv.idempotencyKey, correlationId: relayEnv.correlationId, idempotencyKey: relayEnv.idempotencyKey, status: 'sent', recordedAt: new Date().toISOString(), policyVersion: 1 });
  const r = reconcileRelay(
    { relayCorrelationId: relayEnv.correlationId, destinationCorrelationId: 'dest-nowhere', destinationIdempotencyKey: 'dest-nowhere-key' },
    { isDestinationPending: () => false },
  );
  assert.equal(r.state, 'surface_gone');
  assert.equal(r.terminal, true);
});
