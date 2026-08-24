/**
 * P3 unit tests — circuit breaker + poll backoff + tab cap + last-tab decision.
 * Run: node --test test/unit/p3-pool.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import {
  pollDelayFor, recordPollSuccess, recordPollFailure, isCircuitOpen,
  completionStability, MIN_COMPLETION_STABILITY_MS,
} from '../../dist/drivers/index.js';
import { TabCapExceededError, DEFAULT_TAB_CAP, sessionPool } from '../../dist/cdp-pool.js';
import { tabRegistry } from '../../dist/tab-registry.js';

test('P3 backoff: base delay 2s, doubles per failure, caps at 15s', () => {
  assert.equal(pollDelayFor('tab-a'), 2000);
  // simulate failures to grow the backoff via the breaker's failure counter
  for (let i = 0; i < 3; i++) recordPollFailure('tab-b');
  assert.equal(pollDelayFor('tab-b'), 15000); // 2s * 2^3 = 16s, capped at 15s
  assert.ok(pollDelayFor('tab-b') <= 15000, 'never exceeds the 15s cap');
});

test('P3 breaker: 5 consecutive failures opens the circuit; success resets it', () => {
  // fresh tab — failures below threshold keep the circuit closed
  for (let i = 0; i < 4; i++) {
    assert.equal(recordPollFailure('tab-c'), 0, `failure ${i + 1} must not open the circuit`);
    assert.equal(isCircuitOpen('tab-c'), false);
  }
  // 5th failure opens it (cooldown active)
  const cooldown = recordPollFailure('tab-c');
  assert.ok(cooldown > 0, '5th failure opens the circuit');
  assert.equal(isCircuitOpen('tab-c'), true);
  // success closes the breaker (half-open retry path)
  recordPollSuccess('tab-c');
  assert.equal(isCircuitOpen('tab-c'), false);
  assert.equal(pollDelayFor('tab-c'), 2000, 'backoff resets to base after success');
});

test('P3 cap: TabCapExceededError carries the cap and a clear code', () => {
  const err = new TabCapExceededError(DEFAULT_TAB_CAP);
  assert.equal(err.name, 'TabCapExceededError');
  assert.equal(err.cap, DEFAULT_TAB_CAP);
  assert.ok(err.message.includes('tab_cap_exceeded'), 'message carries the machine-readable code');
  assert.ok(err.message.includes(String(DEFAULT_TAB_CAP)), 'message carries the cap value');
});

test('P3 cap default is 5 (P0 measured safe limit)', () => {
  assert.equal(DEFAULT_TAB_CAP, 5);
});

test('fix 2026-08-07: completion requires stability window, not two readings (Grok early-latch)', () => {
  const t0 = 1_000_000;
  // NEW semantics (async-ask fix): the FIRST reading of a hash starts the clock
  // (previously it was discarded — that cost an extra poll and falsely reported
  // 'in progress' for an already-complete response).
  const r1 = completionStability('hashA', null, null, t0);
  assert.equal(r1.complete, false, 'first reading starts the clock, not complete yet');
  assert.equal(r1.stableSince, t0, 'clock starts on the FIRST reading');
  // still held the 8s window? only then complete
  const r2 = completionStability('hashA', 'hashA', r1.stableSince, t0 + 2000);
  assert.equal(r2.complete, false, '2s of stability is not enough');
  assert.equal(r2.stableSince, t0, 'clock continues from the first reading');
  // hash changed mid-window → clock restarts
  const r3 = completionStability('hashB', 'hashA', r2.stableSince, t0 + 4000);
  assert.equal(r3.complete, false);
  assert.equal(r3.stableSince, null, 'hash change restarts the stability clock');
  // stability held the full window from the first reading → complete
  const r4 = completionStability('hashB', null, null, t0 + 6000);
  const r5 = completionStability('hashB', 'hashB', r4.stableSince, t0 + 6000 + MIN_COMPLETION_STABILITY_MS + 1);
  assert.equal(r5.complete, true, 'stable for the full window → complete');
});

test('fix 2026-08-07: stability window constant is 8s (covers Grok mid-stream pauses)', () => {
  assert.equal(MIN_COMPLETION_STABILITY_MS, 8000);
});

test('P3 cap guard: open() at cap throws BEFORE creating a browser tab (no orphan leak)', async () => {
  // registry.open() checks sessionPool.size >= cap BEFORE openNewProviderTab;
  // simulating a full pool must therefore throw without any browser side effect.
  // (Found live 2026-08-07: the 6th open created an orphan claude tab before the
  // pool acquire threw — fixed by moving the cap guard before tab creation.)
  assert.ok(sessionPool.size <= sessionPool.cap, 'test precondition: pool not over cap');
  // monkeypatch the pool to report full — open() must reject on the guard alone
  const origDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sessionPool), 'size') ??
    Object.getOwnPropertyDescriptor(sessionPool, 'size');
  Object.defineProperty(sessionPool, 'size', { get: () => sessionPool.cap, configurable: true });
  try {
    await assert.rejects(
      () => tabRegistry.open('grok', { newTab: true }),
      (err: unknown) => err instanceof TabCapExceededError && err.message.includes('tab_cap_exceeded'),
      'open() at cap must throw TabCapExceededError before tab creation',
    );
  } finally {
    if (origDesc) Object.defineProperty(sessionPool, 'size', origDesc);
  }
});
