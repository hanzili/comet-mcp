/**
 * Async-ask registry tests (2026-08-07) — the gateway-timeout survival fix.
 *
 * Problem: provider_ask used to block the whole RPC window; the pi gateway
 * abandons long calls (-32001) mid-ask, stranding the prompt in the composer.
 * Fix: dispatchAsk returns immediately; advanceAsk (driven by provider_poll)
 * advances one poll step and completes when the 8s stability window holds.
 *
 * 2026-08-08 (four-opinion design): soft expiry is NON-destructive — a budget
 * breach transitions the entry to 'watching' (retained) instead of deleting it,
 * so a late CDP answer is still recovered and recorded as completed_late. The
 * poll-independent reaper bounds the registry (HARD_TTL).
 *
 * Run: node --test test/unit/async-ask.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import {
  dispatchAsk, advanceAsk, isAskPending, lastDispatchedFor,
  completionStability, MIN_COMPLETION_STABILITY_MS,
  reapExpired, HARD_TTL_MS,
} from '../../dist/drivers/index.js';
import { eventsForCorrelation } from '../../dist/core/event-store.js';
import { sessionPool } from '../../dist/cdp-pool.js';

// fake driver: first poll (before-snapshot) is empty; subsequent polls return the
// completed answer — so sawNewResponse becomes true, then the stability window holds.
function fakeDriver(responseText, state = 'completed') {
  const calls = { asked: [], polls: 0 };
  return {
    provider: 'grok',
    open: async () => ({ provider: 'grok', tabId: 't1', targetId: 't1', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async (session, prompt) => { calls.asked.push(prompt); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent', recordedAt: '' } }; },
    poll: async () => {
      calls.polls++;
      if (calls.polls === 1) {
        // the pre-send snapshot: no response yet
        return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '', contentHash: undefined };
      }
      return { state, steps: [], currentStep: '', response: responseText, markdown: null, hasStopButton: false, agentBrowsingUrl: '', contentHash: 'h' };
    },
    stop: async () => true,
    reset: async () => {},
    health: async () => ({ provider: 'grok', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: calls,
  };
}

test('async ask: dispatch returns immediately (does not block), poll advances to completed', async () => {
  const d = fakeDriver('A real answer worth reading.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Explain leases in distributed systems', { timeoutMs: 60000 });
  assert.equal(dispatched.status, 'in_progress', 'dispatch is fire-and-forget');
  assert.ok(dispatched.idempotencyKey.length > 0);
  assert.ok(dispatched.correlationId.length > 0);
  assert.equal(d._calls.asked.length, 1, 'prompt was dispatched to the driver');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'ask registered as pending');
  assert.equal(lastDispatchedFor('grok'), dispatched.idempotencyKey, 'provider poll can find it');

  // advance once: clock starts on the FIRST completed reading but the 8s window
  // has not held → still in progress (status should be 'confirming', not 'completed')
  const first = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(first?.completed, false, 'one advance: not complete (stability window)');
  assert.equal(first?.status, 'confirming', 'completed-but-confirming is reported as confirming, not leaking completed');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending after one advance');

  // advance repeatedly (with real wall-clock waits) until the stability window holds
  let outcome = null;
  for (let i = 0; i < 25 && isAskPending(dispatched.idempotencyKey); i++) {
    await new Promise((r) => setTimeout(r, 450)); // ~450ms per step → 8s window needs ~18 steps
    outcome = await advanceAsk(dispatched.idempotencyKey);
    if (outcome?.completed) break;
  }
  assert.equal(outcome?.completed, true, 'completed after the stability window');
  assert.equal(outcome?.response, 'A real answer worth reading.', 'full response returned');
});

test('async ask: unknown key → advance returns null (no crash)', async () => {
  const r = await advanceAsk('nonexistent-key');
  assert.equal(r, null);
});

test('stability window constant is 8s (shared with blocking ask path)', () => {
  assert.equal(MIN_COMPLETION_STABILITY_MS, 8000);
});

test('completionStability: window must hold, not just two readings', () => {
  const t0 = 1_000_000;
  const r1 = completionStability('h', 'h', null, t0);
  const r2 = completionStability('h', 'h', r1.stableSince, t0 + 2000);
  assert.equal(r2.complete, false, '2s of stability is not enough (old bug)');
  const r3 = completionStability('h', 'h', r2.stableSince, t0 + 2000 + MIN_COMPLETION_STABILITY_MS + 1);
  assert.equal(r3.complete, true, '8s window held → complete');
});

// ---------------------------------------------------------------------------
// 2026-08-08: late reconciliation (four-opinion design)
// ---------------------------------------------------------------------------

/** Count delivery receipts / received events for a correlation (audit truth). */
function receiptCounts(correlationId: string) {
  const evs = eventsForCorrelation(correlationId);
  const receipts = evs.filter((e) => e.type === 'delivery.receipt');
  return {
    timed_out: receipts.filter((r: any) => r.receiptStatus === 'timed_out').length,
    completed: receipts.filter((r: any) => r.receiptStatus === 'completed').length,
    completed_late: receipts.filter((r: any) => r.receiptStatus === 'completed_late').length,
    abandoned: receipts.filter((r: any) => r.receiptStatus === 'abandoned').length,
    blocked: receipts.filter((r: any) => r.receiptStatus === 'blocked').length,
    received: evs.filter((e) => e.type === 'response.received').length,
  };
}

test('2026-08-08: soft expiry — timed_out outcome, entry RETAINED (watching), single receipt', async () => {
  const d = fakeDriver('partial answer...', 'streaming'); // stays streaming → no accidental finalize
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'PONG?', { timeoutMs: 0 });
  const key = dispatched.idempotencyKey;

  const first = await advanceAsk(key); // observes elapsed >= 1ms → soft transition
  assert.equal(first?.completed, false);
  assert.equal(first?.status, 'timed_out', 'transition poll reports the deadline once');
  assert.equal(first?.timedOut, true);
  assert.ok(isAskPending(key), 'entry RETAINED after soft expiry (was hard-deleted)');

  // repeated polls: still watching, and the timed_out receipt fires exactly once
  for (let i = 0; i < 4; i++) {
    const r = await advanceAsk(key);
    assert.equal(r?.status, 'watching', 'distinct watching status on later polls');
    assert.ok(isAskPending(key), 'still pending while watching');
  }
  const counts = receiptCounts(dispatched.correlationId);
  assert.equal(counts.timed_out, 1, 'timed_out receipt fires exactly once (no duplicate audit rows)');
});

test('2026-08-08: late recovery — completed_late after soft expiry, both receipts coexist', async () => {
  const d = fakeDriver('A real answer worth reading.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'PONG?', { timeoutMs: 0 });
  const key = dispatched.idempotencyKey;
  await advanceAsk(key); // soft transition (tab already shows the answer → confirming)

  let outcome = null;
  for (let i = 0; i < 25 && isAskPending(key); i++) {
    await new Promise((r) => setTimeout(r, 450)); // 8s stability window needs ~18 steps
    outcome = await advanceAsk(key);
    if (outcome?.completed) break;
  }
  assert.equal(outcome?.completed, true, 'completed after the stability window');
  assert.equal(outcome?.late, true, 'flagged as recovered after soft expiry');
  assert.equal(outcome?.response, 'A real answer worth reading.');
  const counts = receiptCounts(dispatched.correlationId);
  assert.equal(counts.timed_out, 1, 'timed_out receipt kept (truthful)')
  assert.equal(counts.completed_late, 1, 'completed_late receipt recorded');
  assert.equal(counts.completed, 0, 'no plain completed receipt for a late recovery');
  assert.equal(counts.received, 1, 'response.received recorded — durable linkage survived soft expiry');
  assert.ok(!isAskPending(key), 'finalized after late recovery');
});

test('2026-08-08: watching — soft-expired ask still streaming reports WATCHING, never completed', async () => {
  const d = fakeDriver('partial answer...', 'streaming');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'PONG?', { timeoutMs: 0 });
  const key = dispatched.idempotencyKey;
  const first = await advanceAsk(key);
  assert.equal(first?.status, 'timed_out', 'transition poll reports the deadline');
  const second = await advanceAsk(key);
  assert.equal(second?.status, 'watching', 'distinct watching status while streaming');
  assert.equal(second?.completed, false);
  assert.ok(isAskPending(key), 'kept watching');
});

test('2026-08-08: reaper — purges entries past HARD_TTL regardless of polling, abandoned receipt', async () => {
  const d = fakeDriver('A real answer worth reading.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'PONG?', { timeoutMs: 0 });
  const key = dispatched.idempotencyKey;
  await advanceAsk(key); // → watching
  assert.ok(isAskPending(key));

  // inject the clock 31 min ahead: the reaper sweep must purge WITHOUT any poll
  const purged = reapExpired(Date.now() + HARD_TTL_MS + 1000);
  assert.ok(purged >= 1, `reaper purged ${purged} abandoned entr(ies)`);
  assert.ok(!isAskPending(key), 'purged entry no longer pending');
  assert.equal(receiptCounts(dispatched.correlationId).abandoned, 1, 'abandoned receipt recorded');
});

test('2026-08-08: closed tab — advance escalates to TAB_CLOSED, never watches forever (user-reported hang)', async () => {
  // driver whose poll throws AFTER the before-snapshot (target died mid-ask)
  let polls = 0;
  const d = {
    provider: 'grok',
    open: async () => ({ provider: 'grok', tabId: 't2', targetId: 't2', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => ({ receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent', recordedAt: '' } }),
    poll: async () => {
      polls++;
      if (polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '', contentHash: undefined };
      throw new Error('CDP session unhealthy (target closed)');
    },
    stop: async () => true,
    reset: async () => {},
    health: async () => ({ provider: 'grok', healthy: false, loginRequired: false, degraded: true, hookResolution: [], lastCheckedAt: '' }),
  };
  const session = await d.open();
  const origGet = sessionPool.get.bind(sessionPool);
  (sessionPool as any).get = () => ({ isHealthy: async () => false }); // dead session
  try {
    const dispatched = await dispatchAsk(d, session, 'PONG?', { timeoutMs: 60000 });
    const r = await advanceAsk(dispatched.idempotencyKey);
    assert.equal(r?.status, 'tab_closed', 'terminal TAB_CLOSED escalation');
    assert.equal(r?.completed, false);
    assert.ok(!isAskPending(dispatched.idempotencyKey), 'terminal — entry removed, no watching');
    assert.equal(receiptCounts(dispatched.correlationId).blocked, 1, 'blocked receipt recorded');
  } finally {
    (sessionPool as any).get = origGet;
  }
});
