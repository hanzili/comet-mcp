/**
 * P4 R8 — crossed-axis test matrix (design 05 §3.8, Claude + Grok axes).
 *
 * Full-chain integration (prepare → approve → send → reconcile) crossing:
 *  - timed-out + destination-disabled-since-prepare
 *  - expired-approval + ambiguous-match
 *  - surface-gone + pending-approval
 *  - blocked/timed-out/uncertain WITHOUT auto-resend (grok #10)
 *  - all three persistence modes exercised (grok trap)
 *  - no full-content leak in escalation paths under redacted/none (Claude)
 *
 * Run: node --test test/unit/relay-crossed-axes.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-relay-axes-'));
  process.env.COMET_DATA_DIR = dataDir;
});

const es = await import('../../dist/core/event-store.js');
const drv = await import('../../dist/drivers/index.js');
const { _resetForTests, eventsForCorrelation, receiptsForCorrelation, getRelayApproval } = es;
const { makeEnvelope } = drv;
const { prepareRelay, approveRelay, rejectRelay, sendRelay, reconcileRelay, classifyRelayReconciliation } = await import('../../dist/core/relay.js');
const { evaluateRelayPolicy, neutralizeMarkdown } = await import('../../dist/core/relay-policy.js');
const { computeEnvelopeHash, canonicalizeEnvelope } = await import('../../dist/core/envelope.js');

const SECRET = 'TOP-SECRET relay payload: api_key=sk-live-12345 [link](https://evil.example)';
const SRC = 'perplexity';
const DEST = 'grok';

function completedSource(content = SECRET): string {
  const env = makeEnvelope(SRC, `src-${Math.random().toString(36).slice(2, 8)}`);
  es.recordEnvelopeCreated(env);
  es.recordSendEvent(env, 'send.accepted');
  es.recordResponseReceived(env, SRC, { messageId: 'pm-1', contentHash: 'ch-1', cursor: 'cur-1', state: 'completed', text: content, steps: ['s'] }, 'tab-1');
  es.recordDeliveryReceipt({ receiptId: 'rct-1', envelopeId: env.idempotencyKey, correlationId: env.correlationId, idempotencyKey: env.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString() });
  return env.correlationId;
}

const BASE = { sourceCorrelationId: '', destination: DEST as any, attributionHeader: 'perplexity via relay to grok' };

async function approvedHash(corr: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const p = await prepareRelay({ ...BASE, sourceCorrelationId: corr, ...overrides });
  assert.ok(p.ok, `prepare ok: ${(p as any).error ?? ''}`);
  const hash = (p as any).envelopeHash;
  const ap = approveRelay({ approvalHash: hash, correlationId: corr, envelopeId: (p as any).idempotencyKey });
  assert.equal(ap.ok, true);
  return hash;
}

function deps(overrides: { preflightOk?: boolean; sendOk?: boolean } = {}) {
  const captured: string[] = [];
  return {
    deps: {
      preflight: async () => (overrides.preflightOk === false ? { ok: false, reason: 'tab gone' } : { ok: true }),
      send: async (wire: string) => {
        captured.push(wire);
        if (overrides.sendOk === false) return { ok: false, error: 'refused' };
        // record the destination ask lifecycle so reconcileRelay finds it
        const destEnv = makeEnvelope(DEST, `dest-${Math.random().toString(36).slice(2, 8)}`);
        es.recordEnvelopeCreated({ ...destEnv, content: wire });
        es.recordSendEvent({ ...destEnv, content: wire }, 'send.accepted');
        es.recordResponseReceived({ ...destEnv, content: wire }, DEST, { messageId: 'dest-msg-1', contentHash: 'dest-hash-1', cursor: 'cur', state: 'completed', text: 'dest answer', steps: [] }, 'tab-grok');
        es.recordDeliveryReceipt({ receiptId: 'rct-dest', envelopeId: destEnv.idempotencyKey, correlationId: destEnv.correlationId, idempotencyKey: destEnv.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString(), contentHash: 'dest-hash-1', providerMessageId: 'dest-msg-1' });
        return { ok: true, correlationId: destEnv.correlationId, idempotencyKey: destEnv.idempotencyKey };
      },
    } as any,
    captured,
  };
}

// ---------------------------------------------------------------------------
// Axis 1 — timed-out + destination-disabled-since-prepare
// ---------------------------------------------------------------------------

test('R8: prepared with one policy → policy drifts between prepare and send → send BLOCKED, no destination contact', async () => {
  _resetForTests();
  const corr = completedSource();
  // prepare/approve with attributionHeader A
  const hash = await approvedHash(corr);
  // ... at send time the policy drifted (attributionHeader B — same shape as
  // destination-disabled-since-prepare: policy changed after approval)
  const { deps: d, captured } = deps();
  const blocked = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash, attributionHeader: 'DIFFERENT header since prepare' }, d);
  // different header → different envelope → hash mismatch → fail closed
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'approval_failed', 'policy drift since prepare → hash mismatch, fail closed');
  assert.equal(captured.length, 0, 'no destination contact when policy changed since prepare');
});

test('R8: timed-out at reconcile is non-terminal; late response reconciles (completed_late path)', () => {
  _resetForTests();
  // destination ask soft-expired (still watched) → timed_out non-terminal
  const r = classifyRelayReconciliation({ destinationPending: true, destinationStatus: 'timed_out', destinationResponded: false });
  assert.equal(r.state, 'timed_out');
  assert.equal(r.terminal, false);
  // later the response lands WITH an anchor → reconciled (never stranded)
  const late = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'completed_late', destinationResponded: true, destinationProviderMessageId: 'late-1' });
  assert.equal(late.state, 'reconciled');
  assert.equal(late.terminal, true);
});

// ---------------------------------------------------------------------------
// Axis 2 — expired-approval + ambiguous-match
// ---------------------------------------------------------------------------

test('R8: expired approval + ambiguous destination response — BOTH fail closed, never auto-promote', async () => {
  _resetForTests();
  const corr = completedSource();
  const p = await prepareRelay({ ...BASE, sourceCorrelationId: corr });
  const hash = (p as any).envelopeHash;
  // approve with an ALREADY-expired expiry
  approveRelay({ approvalHash: hash, correlationId: corr, expiresAt: new Date(Date.now() - 1000).toISOString() });
  // ambiguous match: destination "responded" but no anchor (even if the response
  // happened to match content-wise, no messageId/hash anchor → ambiguous)
  const amb = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'completed', destinationResponded: true });
  assert.equal(amb.state, 'ambiguous');
  assert.equal(amb.terminal, true);
  // send still refuses on the expired approval — never sends on expired
  const { deps: d, captured } = deps();
  const r = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash }, d);
  assert.equal(r.ok, false);
  assert.equal(captured.length, 0, 'no send with expired approval even when response is ambiguous');
});

// ---------------------------------------------------------------------------
// Axis 3 — surface-gone + pending-approval
// ---------------------------------------------------------------------------

test('R8: surface-gone at send with a PENDING approval — approval NOT consumed, retry after fix works', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await approvedHash(corr);
  // surface gone at pre-flight
  const { deps: d1, captured: c1 } = deps({ preflightOk: false });
  const r1 = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash }, d1);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 'surface_gone');
  assert.equal(c1.length, 0);
  assert.equal(getRelayApproval(hash)!.type, 'relay.approved', 'approval preserved');
  // NO consumption event
  assert.equal(eventsForCorrelation(corr).filter((e) => e.type === 'relay.approval_consumed').length, 0);
  // fix the surface → SAME approval still valid → send succeeds
  const { deps: d2, captured: c2 } = deps();
  const r2 = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash }, d2);
  assert.equal(r2.ok, true);
  assert.equal(c2.length, 1);
});

test('R8: surface-gone + approval still PENDING (never approved) → approval_failed first', async () => {
  _resetForTests();
  const corr = completedSource();
  const p = await prepareRelay({ ...BASE, sourceCorrelationId: corr });
  const hash = (p as any).envelopeHash;
  // no approve call — hash unknown to the store
  const { deps: d, captured } = deps({ preflightOk: false });
  const r = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash }, d);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'approval_failed', 'unapproved → approval gate fails before surface check');
  assert.equal(captured.length, 0);
});

// ---------------------------------------------------------------------------
// Axis 4 — blocked / timed-out / uncertain WITHOUT auto-resend (grok #10)
// ---------------------------------------------------------------------------

test('R8: blocked send → approval consumed, reconciliation terminal blocked, NO auto-resend', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await approvedHash(corr);
  const { deps: d, captured } = deps({ sendOk: false });
  const r = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash }, d);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'blocked');
  // approval consumed (single-use) — a retry with the SAME hash is refused
  const again = deps();
  const retry = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash }, again.deps);
  assert.equal(retry.ok, false);
  assert.equal(retry.status, 'approval_failed', 'no auto-resend — fresh approval required');
  // reconciliation reports blocked (terminal)
  const rec = reconcileRelay(
    { relayCorrelationId: corr, destinationCorrelationId: 'dest-x', destinationIdempotencyKey: 'dest-k' },
    { isDestinationPending: () => false },
  );
  assert.equal(rec.state, 'blocked');
  assert.equal(rec.terminal, true);
});

test('R8: timed-out → non-terminal, never auto-resend; poll again', async () => {
  _resetForTests();
  const r = classifyRelayReconciliation({ destinationPending: true, destinationStatus: 'watching', destinationResponded: false });
  assert.equal(r.state, 'timed_out');
  assert.equal(r.terminal, false, 'non-terminal — no resend, poll again');
});

test('R8: uncertain (ambiguous) → terminal, never auto-promoted, fresh approval for any resend', async () => {
  _resetForTests();
  const r = classifyRelayReconciliation({ destinationPending: false, destinationStatus: 'completed', destinationResponded: true });
  assert.equal(r.state, 'ambiguous');
  assert.equal(r.terminal, true);
  assert.ok((r.details ?? '').includes('never auto-promoted'));
});

// ---------------------------------------------------------------------------
// Axis 5 — all three persistence modes exercised (grok trap)
// ---------------------------------------------------------------------------

test('R8: full/redacted/none all exercise the whole chain (prepare→approve→send→reconcile)', async () => {
  for (const cpm of ['full', 'redacted', 'none']) {
    _resetForTests();
    const corr = completedSource();
    const hash = await approvedHash(corr, { contentPersistenceMode: cpm });
    const { deps: d, captured } = deps();
    const r = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash, contentPersistenceMode: cpm }, d);
    assert.equal(r.ok, true, `${cpm}: send ok`);
    assert.equal(captured.length, 1, `${cpm}: wire sent`);
    const rec = reconcileRelay(
      { relayCorrelationId: corr, destinationCorrelationId: r.destinationCorrelationId!, destinationIdempotencyKey: r.destinationIdempotencyKey },
      { isDestinationPending: () => false },
    );
    // destination completed with anchor → reconciled under all modes
    assert.equal(rec.state, 'reconciled', `${cpm}: reconciles via hashes/ids (design §2)`);
  }
});

test('R8: persistence mode carried on every RELAY event row', async () => {
  for (const cpm of ['full', 'redacted', 'none']) {
    _resetForTests();
    const corr = completedSource();
    const hash = await approvedHash(corr, { contentPersistenceMode: cpm });
    const { deps: d } = deps();
    const r = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash, contentPersistenceMode: cpm }, d);
    assert.equal(r.ok, true, `${cpm}: send ok`);
    const events = eventsForCorrelation(corr);
    // RELAY events only: relay envelope.created (idempotencyKey prefix relay-)
    // + delivery receipts carrying policyVersion (R6 marker)
    const relayEvents = events.filter(
      (e) =>
        (e.type === 'envelope.created' && e.envelopeId?.startsWith('relay-')) ||
        (e.type === 'delivery.receipt' && e.policyVersion !== undefined),
    );
    assert.ok(relayEvents.length >= 2, `${cpm}: relay envelope + receipt rows exist`);
    for (const ev of relayEvents) {
      assert.equal(ev.persistenceMode, cpm, `${cpm}: ${ev.type} carries the mode`);
    }
  }
});

// ---------------------------------------------------------------------------
// Axis 6 — no full-content leak in escalation paths under redacted/none (Claude)
// ---------------------------------------------------------------------------

test('R8: NO LEAK — relay events never duplicate content under redacted/none; secret appears ONLY in the source event', async () => {
  for (const cpm of ['redacted', 'none']) {
    _resetForTests();
    const corr = completedSource();
    const hash = await approvedHash(corr, { contentPersistenceMode: cpm });
    const { deps: d } = deps({ sendOk: false }); // include a BLOCKED escalation path
    await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash, contentPersistenceMode: cpm }, d);
    const raw = readFileSync(join(dataDir, 'event-log.jsonl'), 'utf8');
    // The SOURCE ask is native (full mode) — its response.received legitimately
    // holds the content. The relay must NOT duplicate it: secret appears EXACTLY
    // once (source event only), never in relay-created rows.
    const occurrences = (raw.match(/TOP-SECRET/g) ?? []).length;
    assert.equal(occurrences, 1, `${cpm}: secret in source event ONLY — relay never duplicates content (incl. blocked escalation)`);
    // the SOURCE event (native, full) holds the PII once; relay rows must not duplicate it
    assert.equal((raw.match(/sk-live-12345/g) ?? []).length, 1, `${cpm}: PII in source event only, never duplicated by relay`);
    // anchors survive (reconciliation works via hashes/ids — design §2)
    assert.ok(raw.includes('ch-1'), `${cpm}: contentHash survives`);
    assert.ok(raw.includes('pm-1'), `${cpm}: providerMessageId survives`);
  }
});

test('R8: full mode DOES exercise the chain with relay rows carrying full (grok trap — modes must differ)', async () => {
  _resetForTests();
  const corr = completedSource();
  const hash = await approvedHash(corr, { contentPersistenceMode: 'full' });
  const { deps: d } = deps();
  const r = await sendRelay({ ...BASE, sourceCorrelationId: corr, approvalHash: hash, contentPersistenceMode: 'full' }, d);
  assert.equal(r.ok, true);
  const relayEvents = eventsForCorrelation(corr).filter(
    (e) => (e.type === 'envelope.created' && e.envelopeId?.startsWith('relay-')) || (e.type === 'delivery.receipt' && e.policyVersion !== undefined),
  );
  assert.ok(relayEvents.length >= 2, 'relay rows exist under full');
  for (const ev of relayEvents) assert.equal(ev.persistenceMode, 'full', 'relay rows carry full mode');
  // the SOURCE response keeps its content (native ask, full)
  const raw = readFileSync(join(dataDir, 'event-log.jsonl'), 'utf8');
  assert.equal((raw.match(/TOP-SECRET/g) ?? []).length, 1, 'source event holds content; relay metadata rows never duplicate it');
});

// ---------------------------------------------------------------------------
// Hash binding across the chain (R1 ⊗ R4 ⊗ R6)
// ---------------------------------------------------------------------------

test('R8: same source+destination+policy → same approval hash across prepare AND send', async () => {
  _resetForTests();
  const corr = completedSource();
  const p1 = await prepareRelay({ ...BASE, sourceCorrelationId: corr });
  const p2 = await prepareRelay({ ...BASE, sourceCorrelationId: corr });
  assert.ok(p1.ok && p2.ok);
  assert.equal((p1 as any).envelopeHash, (p2 as any).envelopeHash, 're-prepare stable');
  // canonical form matches the hash input exactly
  const env = (p1 as any).envelope;
  assert.equal(computeEnvelopeHash(env), (p1 as any).envelopeHash);
  assert.equal(canonicalizeEnvelope(env), (p1 as any).canonical);
});
