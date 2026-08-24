/**
 * P4 R5 relay_approve tests — append-only approval records, single-use via CAS
 * (design 05 §1.2/§2: compare-and-swap against the append-only store, not a
 * boolean flag), expiry, rejection terminality, and durability across reload.
 *
 * Run: node --test test/unit/relay-approve.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dataDir: string;
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'comet-relay-approve-'));
  process.env.COMET_DATA_DIR = dataDir;
});

const es = await import('../../dist/core/event-store.js');
const { _resetForTests, _reloadMemoryForTests, recordRelayApproval, getRelayApproval, consumeRelayApproval, eventsForCorrelation, appendEvent } = es;
const { approveRelay, rejectRelay, casConsumeApproval } = await import('../../dist/core/relay.js');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('R5: approve — records relay.approved append-only with expiry, indexed by hash', () => {
  _resetForTests();
  const expiry = new Date(Date.now() + 300000).toISOString();
  const result = approveRelay({ approvalHash: HASH_A, correlationId: 'c-1', envelopeId: 'e-1', expiresAt: expiry });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'approved');
  assert.equal(result.expiresAt, expiry);
  const approval = getRelayApproval(HASH_A);
  assert.equal(approval?.type, 'relay.approved');
  assert.equal(approval?.approvalExpiresAt, expiry);
  assert.equal(approval?.correlationId, 'c-1');
  assert.equal(approval?.envelopeId, 'e-1');
  // raw log row exists
  const raw = readFileSync(join(dataDir, 'event-log.jsonl'), 'utf8');
  assert.ok(raw.includes('"type":"relay.approved"'));
  assert.ok(raw.includes(HASH_A));
});

test('R5: approve — default expiry +5min when not provided', () => {
  _resetForTests();
  const before = Date.now();
  const result = approveRelay({ approvalHash: HASH_A, correlationId: 'c-1' });
  const after = Date.now();
  assert.ok(result.expiresAt);
  const t = new Date(result.expiresAt!).getTime();
  assert.ok(t >= before + 5 * 60 * 1000 - 2000 && t <= after + 5 * 60 * 1000 + 2000, '≈5min default');
});

test('R5: single-use — same hash cannot be recorded twice (approve then approve)', () => {
  _resetForTests();
  assert.equal(approveRelay({ approvalHash: HASH_A, correlationId: 'c-1' }).ok, true);
  const second = approveRelay({ approvalHash: HASH_A, correlationId: 'c-1' });
  assert.equal(second.ok, false);
  assert.equal(second.status, 'already_recorded');
  // and the log has exactly ONE approval row for the hash
  const raw = readFileSync(join(dataDir, 'event-log.jsonl'), 'utf8');
  assert.equal((raw.match(/relay\.approved/g) ?? []).length, 1);
});

test('R5: reject — records relay.rejected, terminal, never consumable', () => {
  _resetForTests();
  const result = rejectRelay({ approvalHash: HASH_A, correlationId: 'c-1' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'rejected');
  assert.equal(getRelayApproval(HASH_A)?.type, 'relay.rejected');
  const consume = consumeRelayApproval(HASH_A, 'c-1', 'e-1');
  assert.equal(consume.ok, false);
  assert.equal(consume.ok === false && consume.reason, 'not_approved');
});

test('R5: reject after approve → already_recorded (first record wins)', () => {
  _resetForTests();
  approveRelay({ approvalHash: HASH_A, correlationId: 'c-1' });
  const rej = rejectRelay({ approvalHash: HASH_A, correlationId: 'c-1' });
  assert.equal(rej.ok, false);
  assert.equal(rej.status, 'already_recorded');
  assert.equal(getRelayApproval(HASH_A)?.type, 'relay.approved', 'approval stands');
});

test('R5: CAS consume — success appends relay.approval_consumed, marks single use', () => {
  _resetForTests();
  approveRelay({ approvalHash: HASH_A, correlationId: 'c-1', envelopeId: 'e-1' });
  const consume = casConsumeApproval(HASH_A, 'c-1', 'e-1');
  assert.equal(consume.ok, true);
  const ev = (consume as { event: any }).event;
  assert.equal(ev.type, 'relay.approval_consumed');
  assert.equal(ev.approvalHash, HASH_A);
  const consumed = eventsForCorrelation('c-1').filter((e) => e.type === 'relay.approval_consumed');
  assert.equal(consumed.length, 1);
});

test('R5: CAS — second consume of same hash FAILS (already_consumed) — no double send', () => {
  _resetForTests();
  approveRelay({ approvalHash: HASH_A, correlationId: 'c-1', envelopeId: 'e-1' });
  assert.equal(casConsumeApproval(HASH_A, 'c-1', 'e-1').ok, true);
  const second = casConsumeApproval(HASH_A, 'c-1', 'e-1');
  assert.equal(second.ok, false);
  assert.equal((second as { reason: string }).reason, 'already_consumed');
});

test('R5: CAS — unknown hash fails', () => {
  _resetForTests();
  const r = casConsumeApproval(HASH_B, 'c-9', 'e-9');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'unknown_approval');
});

test('R5: CAS — expired approval fails (relay_send must refuse)', () => {
  _resetForTests();
  approveRelay({ approvalHash: HASH_A, correlationId: 'c-1', expiresAt: new Date(Date.now() - 1000).toISOString() });
  const r = casConsumeApproval(HASH_A, 'c-1', 'e-1');
  assert.equal(r.ok, false);
  assert.equal((r as { reason: string }).reason, 'expired');
});

test('R5: DURABILITY — approval + consumption survive memory reload (rebuilt from log)', () => {
  _resetForTests();
  approveRelay({ approvalHash: HASH_A, correlationId: 'c-1', envelopeId: 'e-1' });
  casConsumeApproval(HASH_A, 'c-1', 'e-1');
  _reloadMemoryForTests(); // simulates process restart — indexes rebuilt from disk
  const approval = getRelayApproval(HASH_A);
  assert.equal(approval?.type, 'relay.approved', 'approval rebuilt from log');
  // single-use survives restart: a fresh consume attempt is rejected
  const again = casConsumeApproval(HASH_A, 'c-1', 'e-1');
  assert.equal(again.ok, false);
  assert.equal((again as { reason: string }).reason, 'already_consumed', 'consumption durable across restart');
});

test('R5: approvals persist as control-plane only (persistenceMode none — no content)', () => {
  _resetForTests();
  approveRelay({ approvalHash: HASH_A, correlationId: 'c-1' });
  const ev = getRelayApproval(HASH_A)!;
  assert.equal(ev.persistenceMode, 'none');
  const raw = readFileSync(join(dataDir, 'event-log.jsonl'), 'utf8');
  assert.ok(!raw.includes('"response"'), 'no response content on approval rows');
});

test('R5: recordRelayApproval direct API — same first-wins + index semantics', () => {
  _resetForTests();
  const first = recordRelayApproval({ approvalHash: HASH_B, correlationId: 'c-2', approved: true, expiresAt: '2026-08-09T13:00:00.000Z' });
  assert.ok(first);
  assert.equal(recordRelayApproval({ approvalHash: HASH_B, correlationId: 'c-2', approved: true }), null, 'duplicate returns null');
  assert.equal(getRelayApproval(HASH_B)?.approvalExpiresAt, '2026-08-09T13:00:00.000Z');
});
