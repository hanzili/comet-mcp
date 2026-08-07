/**
 * Async-ask registry tests (2026-08-07) — the gateway-timeout survival fix.
 *
 * Problem: provider_ask used to block the whole RPC window; the pi gateway
 * abandons long calls (-32001) mid-ask, stranding the prompt in the composer.
 * Fix: dispatchAsk returns immediately; advanceAsk (driven by provider_poll)
 * advances one poll step and completes when the 8s stability window holds.
 *
 * Run: node --test test/unit/async-ask.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import {
  dispatchAsk, advanceAsk, isAskPending, lastDispatchedFor,
  completionStability, MIN_COMPLETION_STABILITY_MS,
} from '../../dist/drivers/index.js';

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

  // advance once: stability window not yet held → still in progress
  const first = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(first?.completed, false, 'one advance: not complete (stability window)');
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
