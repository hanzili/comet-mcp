/**
 * P4 R6 relay_send tests — hash binding re-validation, CAS single-use at send,
 * surface-gone pre-flight (approval NOT consumed), receipt on every attempt,
 * wire content (attribution header + markdown trust boundary).
 *
 * Run: node --test test/unit/relay-send.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-relay-send-'));
  process.env.COMET_DATA_DIR = dataDir;
});

const es = await import('../../dist/core/event-store.js');
const drv = await import('../../dist/drivers/index.js');
const { _resetForTests, _reloadMemoryForTests, eventsForCorrelation, receiptsForCorrelation, getRelayApproval } = es;
const { makeEnvelope } = drv;
const { prepareRelay, approveRelay, sendRelay, buildWireContent, casConsumeApproval } = await import('../../dist/core/relay.js');

const ANSWER = 'Deep research answer with a [link](https://evil.example/x) and `code` blocks.';
const SRC = 'perplexity';
const DEST = 'grok';

function completedSource(): string {
  const env = makeEnvelope(SRC, `src-${Math.random().toString(36).slice(2, 8)}`);
  es.recordEnvelopeCreated(env);
  es.recordSendEvent(env, 'send.accepted');
  es.recordResponseReceived(env, SRC, { messageId: 'pm-1', contentHash: 'ch-1', cursor: 'cur-1', state: 'completed', text: ANSWER, steps: ['s'] }, 'tab-1');
  es.recordDeliveryReceipt({ receiptId: 'rct-1', envelopeId: env.idempotencyKey, correlationId: env.correlationId, idempotencyKey: env.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString() });
  return env.correlationId;
}

const BASE_INPUT = { sourceCorrelationId: '', destination: DEST as any, attributionHeader: 'perplexity via relay to grok' };

async function preparedApprovedHash(corr: string): Promise<string> {
  const p = await prepareRelay({ ...BASE_INPUT, sourceCorrelationId: corr });
  assert.ok(p.ok, 'prepare ok');
  const hash = (p as any).envelopeHash;
  const ap = approveRelay({ approvalHash: hash, correlationId: corr, envelopeId: (p as any).idempotencyKey });
  assert.equal(ap.ok, true);
  return hash;
}

function fakeDeps(overrides: { preflightOk?: boolean; sendOk?: boolean; captureWire?: (w: string) => void } = {}) {
  const captured: string[] = [];
  return {
    deps: {
      preflight: async () => (overrides.preflightOk === false ? { ok: false, reason: 'tab closed' } : { ok: true }),
      send: async (wire: string) => {
        captured.push(wire);
        if (overrides.captureWire) overrides.captureWire(wire);
        return overrides.sendOk === false ? { ok: false, error: 'driver refused' } : { ok: true, correlationId: 'dest-corr-1', idempotencyKey: 'dest-key-1' };
      },
    } as any,
    captured,
  };
}

test('R6: happy path — hash binding ok, CAS consumed, wire sent with attribution header, receipt recorded', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await preparedApprovedHash(corr);
  const { deps, captured } = fakeDeps();
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash }, deps);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'sent');
  assert.equal(result.destinationCorrelationId, 'dest-corr-1');
  assert.ok(captured.length === 1);
  assert.ok(captured[0].includes('perplexity via relay to grok'), 'attribution header on wire');
  assert.ok(!captured[0].includes('](https://'), 'markdown neutralized (default)');
  // approval consumed
  assert.equal(getRelayApproval(hash)!.type, 'relay.approved');
  const consumed = eventsForCorrelation(corr).filter((e) => e.type === 'relay.approval_consumed');
  assert.equal(consumed.length, 1);
  // receipt recorded (append-only)
  const receipts = receiptsForCorrelation(corr).filter((r) => r.receiptStatus === 'sent');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].policyVersion, 1, 'receipt carries policyVersion');
});

test('R6: hash binding — altered destination/content/policy → mismatch, approval NOT consumed, no send', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await preparedApprovedHash(corr);
  const { deps, captured } = fakeDeps();
  // same source but different destination → different envelope → hash mismatch
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, destination: 'claude', approvalHash: hash }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'approval_failed');
  assert.match(result.error ?? '', /hash mismatch/);
  assert.equal(captured.length, 0, 'no destination contact on hash mismatch');
  const consumed = eventsForCorrelation(corr).filter((e) => e.type === 'relay.approval_consumed');
  assert.equal(consumed.length, 0, 'approval NOT consumed on mismatch');
});

test('R6: CAS single-use — second send of same hash refused (already_consumed), no second wire', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await preparedApprovedHash(corr);
  const first = fakeDeps();
  const second = fakeDeps();
  const r1 = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash }, first.deps);
  assert.equal(r1.ok, true);
  const r2 = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash }, second.deps);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 'approval_failed');
  assert.match(r2.error ?? '', /already_consumed|consumed/);
  assert.equal(second.captured.length, 0, 'no double send');
});

test('R6: surface-gone pre-flight — distinct terminal, approval NOT consumed, no send', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await preparedApprovedHash(corr);
  const { deps, captured } = fakeDeps({ preflightOk: false });
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'surface_gone');
  assert.equal(captured.length, 0, 'no destination contact when surface gone');
  const consumed = eventsForCorrelation(corr).filter((e) => e.type === 'relay.approval_consumed');
  assert.equal(consumed.length, 0, 'approval preserved — client may retry after fixing destination');
});

test('R6: expired approval → send refused before destination contact', async () => {
  _resetForTests();
  const corr = completedSource();
  const p = await prepareRelay({ ...BASE_INPUT, sourceCorrelationId: corr });
  const hash = (p as any).envelopeHash;
  approveRelay({ approvalHash: hash, correlationId: corr, expiresAt: new Date(Date.now() - 1000).toISOString() });
  const { deps, captured } = fakeDeps();
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'approval_failed');
  assert.match(result.error ?? '', /expired/);
  assert.equal(captured.length, 0);
});

test('R6: rejected (never approved) → send refused', async () => {
  _resetForTests();
  const corr = completedSource();
  const p = await prepareRelay({ ...BASE_INPUT, sourceCorrelationId: corr });
  const hash = (p as any).envelopeHash;
  const { rejectRelay } = await import('../../dist/core/relay.js');
  const rej = await Promise.resolve(rejectRelay({ approvalHash: hash, correlationId: corr }));
  assert.equal(rej.ok, true);
  const { deps, captured } = fakeDeps();
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'approval_failed');
  assert.equal(captured.length, 0);
});

test('R6: unapproved hash (never recorded) → refused', async () => {
  _resetForTests();
  const corr = completedSource();
  const { deps, captured } = fakeDeps();
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: 'f'.repeat(64) }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'approval_failed');
  assert.equal(captured.length, 0);
});

test('R6: send failure → blocked receipt recorded, approval already consumed (fresh approval needed for retry)', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await preparedApprovedHash(corr);
  const { deps, captured } = fakeDeps({ sendOk: false });
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(captured.length, 1, 'wire was attempted');
  // receipt with blocked status recorded
  const receipts = receiptsForCorrelation(corr).filter((r) => r.receiptStatus === 'blocked');
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0].response === undefined && receipts[0].receiptStatus === 'blocked');
});

test('R6: buildWireContent — rawMarkdown opt-in passes structure through', async () => {
  _resetForTests();
  const corr = completedSource();
  const p = await prepareRelay({ ...BASE_INPUT, sourceCorrelationId: corr, rawMarkdown: true });
  assert.ok(p.ok);
  const { envelope, evaluation } = p as any;
  const wire = buildWireContent(envelope, evaluation);
  assert.equal(evaluation.markdownAction, 'passthrough');
  assert.ok(wire.includes('](https://'), 'raw markdown preserved (opt-in)');
});

test('R6: buildWireContent — no attribution header → content still sent', async () => {
  const env = { relay: { attributionHeader: undefined }, content: 'plain answer' } as any;
  const evalNeutral = { markdownAction: 'neutralize' } as any;
  const wire = buildWireContent(env, evalNeutral);
  assert.equal(wire, 'plain answer', 'no header prefix, content preserved');
});

test('R6: policy re-validation at send — deadline passed since prepare blocks even with approval', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await preparedApprovedHash(corr);
  const { deps, captured } = fakeDeps();
  // deadline in the past → policy blocked at send (even though approved)
  const result = await sendRelay({ ...BASE_INPUT, sourceCorrelationId: corr, approvalHash: hash, deadlineMs: Date.now() - 100 }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(captured.length, 0);
});
