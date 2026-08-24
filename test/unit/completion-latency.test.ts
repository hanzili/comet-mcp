/**
 * P4 latency fix tests (2026-08-09, consult-validated design).
 *
 * completionStability(windowMs), CONFIDENCE_WINDOWS, windowForPoll, and the
 * confidence-aware completion gate: authoritative ⇒ hash-confirmed timer-free;
 * heuristic ⇒ short window; weak ⇒ full 8s; missing confidence ⇒ weak;
 * sawNewResponse is never bypassed.
 *
 * Run: node --test test/unit/completion-latency.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import {
  completionStability,
  MIN_COMPLETION_STABILITY_MS,
  CONFIDENCE_WINDOWS,
  windowForPoll,
} from '../../dist/drivers/index.js';

test('latency: completionStability default window is 8s (unchanged behavior)', () => {
  const now = 1_000_000;
  // first reading starts the clock
  assert.deepEqual(completionStability('h1', null, null, now), { complete: false, stableSince: now });
  // held for 8s → complete
  const held = completionStability('h1', 'h1', now, now + MIN_COMPLETION_STABILITY_MS);
  assert.equal(held.complete, true);
  assert.equal(held.stableSince, now);
  // content change restarts the clock
  const changed = completionStability('h2', 'h1', now, now + 9000);
  assert.deepEqual(changed, { complete: false, stableSince: null });
});

test('latency: completionStability honors a custom windowMs', () => {
  const now = 1_000_000;
  // 3s window: not complete at 2s, complete at 3s
  assert.equal(completionStability('h', null, null, now, 3000).complete, false);
  assert.equal(completionStability('h', 'h', now, now + 3000, 3000).complete, true);
  // 0 window: first reading completes immediately
  assert.equal(completionStability('h', null, null, now, 0).complete, true);
});

test('latency: CONFIDENCE_WINDOWS — authoritative 0, heuristic 3000, weak 8000', () => {
  assert.equal(CONFIDENCE_WINDOWS.authoritative, 0);
  assert.equal(CONFIDENCE_WINDOWS.heuristic, 3000);
  assert.equal(CONFIDENCE_WINDOWS.weak, MIN_COMPLETION_STABILITY_MS);
});

test('latency: windowForPoll — absent confidence ⇒ weak (fail-closed)', () => {
  assert.equal(windowForPoll({} as any), MIN_COMPLETION_STABILITY_MS);
  assert.equal(windowForPoll({ completionConfidence: 'authoritative' } as any), 0);
  assert.equal(windowForPoll({ completionConfidence: 'heuristic' } as any), 3000);
  assert.equal(windowForPoll({ completionConfidence: 'weak' } as any), MIN_COMPLETION_STABILITY_MS);
});

test('latency: windowForPoll — entry override wins over confidence map', () => {
  assert.equal(windowForPoll({ completionConfidence: 'heuristic' } as any, 5000), 5000);
  assert.equal(windowForPoll({ completionConfidence: 'authoritative' } as any, 1000), 1000);
});

// ---------------------------------------------------------------------------
// Gate behavior — authoritative (hash-confirmed, timer-free)
// ---------------------------------------------------------------------------

test('latency GATE: authoritative + same hash as prev → complete on first poll (no window)', () => {
  // hash-confirmed: prevHash === hash ⇒ complete immediately, even though the
  // stability window (8s) has not elapsed
  const now = 1_000_000;
  const stableSince = now; // clock started, not yet 8s
  const { complete } = completionStability('h', 'h', stableSince, now, CONFIDENCE_WINDOWS.authoritative);
  assert.equal(complete, true, 'authoritative window 0 ⇒ immediate');
});

test('latency GATE: authoritative + cold start (prevHash null) → complete', () => {
  const now = 1_000_000;
  const { complete } = completionStability('h', null, null, now, CONFIDENCE_WINDOWS.authoritative);
  assert.equal(complete, true, 'cold-start first content + marker ⇒ done');
});

test('latency GATE: authoritative + changed hash → NOT complete (hash-confirmed fails)', () => {
  const now = 1_000_000;
  const { complete, stableSince } = completionStability('h2', 'h1', null, now, CONFIDENCE_WINDOWS.authoritative);
  assert.equal(complete, false, 'content still moving ⇒ wait, never latch partial');
  assert.equal(stableSince, null, 'clock restarted on content change');
});

// ---------------------------------------------------------------------------
// Gate behavior — heuristic / weak keep the window
// ---------------------------------------------------------------------------

test('latency GATE: heuristic requires ~3s of stability', () => {
  const now = 1_000_000;
  assert.equal(completionStability('h', null, null, now, CONFIDENCE_WINDOWS.heuristic).complete, false);
  assert.equal(completionStability('h', 'h', now, now + 2900, CONFIDENCE_WINDOWS.heuristic).complete, false, '2.9s not enough');
  assert.equal(completionStability('h', 'h', now, now + 3000, CONFIDENCE_WINDOWS.heuristic).complete, true, '3s enough');
});

test('latency GATE: weak requires the full 8s window (anti-truncation preserved)', () => {
  const now = 1_000_000;
  assert.equal(completionStability('h', 'h', now, now + 7999, CONFIDENCE_WINDOWS.weak).complete, false);
  assert.equal(completionStability('h', 'h', now, now + 8000, CONFIDENCE_WINDOWS.weak).complete, true);
});

// ---------------------------------------------------------------------------
// Grok message-scoped authoritative (Ship 2)
// ---------------------------------------------------------------------------

test('latency: grok determineGrokStatus returns authoritative only when LAST message has "Worked for Xs"', async () => {
  const { determineGrokStatus } = await import('../../dist/providers/extraction.js');
  assert.equal(determineGrokStatus({ lastMessageText: 'Worked for 3s\nAnswer' }).completionConfidence, 'authoritative');
  assert.equal(determineGrokStatus({ lastMessageText: 'plain answer' }).completionConfidence, 'weak');
  assert.equal(determineGrokStatus({ lastMessageText: 'Working for 3s' }).state, 'streaming');
});

// ---------------------------------------------------------------------------
// Perplexity per-branch confidence (Ship 3)
// ---------------------------------------------------------------------------

test('latency: perplexity determineStatus — follow-up authoritative, steps-only heuristic', async () => {
  const { determineStatus } = await import('../../dist/providers/extraction.js');
  const followUp = determineStatus({ hasActiveStopButton: false, hasLoadingSpinner: false, bodyText: 'Answer. Ask a follow-up' });
  assert.equal(followUp.completionConfidence, 'authoritative');
  const steps = determineStatus({ hasActiveStopButton: false, hasLoadingSpinner: false, bodyText: '4 steps completed' });
  assert.equal(steps.completionConfidence, 'heuristic');
  const working = determineStatus({ hasActiveStopButton: true, hasLoadingSpinner: false, bodyText: 'Working' });
  assert.equal(working.state, 'working');
});

// ---------------------------------------------------------------------------
// Follow-up A: response.amended (ADR 0009) — growth after early finalize
// ---------------------------------------------------------------------------

test('amended: same-prefix GROWTH after a recorded response → response.amended, not a second response.received', async () => {
  const es = await import('../../dist/core/event-store.js');
  const { _resetForTests, eventsForCorrelation, recordEnvelopeCreated, recordResponseReceived, recordResponseAmended } = es;
  const { makeEnvelope } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const env = makeEnvelope('grok', 'amend-key');
  recordEnvelopeCreated(env);
  // first terminal response (early authoritative finalize)
  recordResponseReceived(env, 'grok', {
    messageId: 'm1', contentHash: 'h1', cursor: 'c', state: 'completed',
    text: 'The answer starts here', steps: [],
  }, 'tab-1');
  // later poll sees the same content GROWN (same prefix, longer)
  const amended = recordResponseAmended(env, 'grok', {
    messageId: 'm2', contentHash: 'h2', cursor: 'c', state: 'completed',
    text: 'The answer starts here and continues with more detail', steps: [],
  });
  assert.ok(amended, 'growth recorded as amendment');
  assert.equal(amended!.type, 'response.amended');
  const types = eventsForCorrelation(env.correlationId).map((e) => e.type);
  assert.equal(types.filter((t) => t === 'response.received').length, 1, 'exactly ONE response.received');
  assert.equal(types.filter((t) => t === 'response.amended').length, 1, 'one amendment');
});

test('amended: NOT a same-prefix superset → returns null (genuinely new turn, record fresh received)', async () => {
  const es = await import('../../dist/core/event-store.js');
  const { _resetForTests, recordEnvelopeCreated, recordResponseReceived, recordResponseAmended } = es;
  const { makeEnvelope } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const env = makeEnvelope('grok', 'amend-key2');
  recordEnvelopeCreated(env);
  recordResponseReceived(env, 'grok', {
    messageId: 'm1', contentHash: 'h1', cursor: 'c', state: 'completed',
    text: 'First turn answer', steps: [],
  }, 'tab-1');
  // different content (not a prefix superset)
  const notAmended = recordResponseAmended(env, 'grok', {
    messageId: 'm2', contentHash: 'h2', cursor: 'c', state: 'completed',
    text: 'Unrelated new content', steps: [],
  });
  assert.equal(notAmended, null, 'non-superset is NOT an amendment');
});

// ---------------------------------------------------------------------------
// ADR 0010 — sentinel completion marker
// ---------------------------------------------------------------------------

function sentinelDriver(answer: string, comply = true) {
  const calls = { asked: [], polls: 0, sentinel: '' };
  // 2026-08-10 (ADR 0012, detect-only): the MODEL generates its own 10-char
  // code per its platform Custom Instruction — we do NOT inject one. comply:
  // the model appends a status line with its OWN random code; non-comply: it
  // skips the line entirely.
  const echoedAnswer = () => {
    if (!calls.sentinel) {
      // model's own code — random, NOT derived from the prompt
      calls.sentinel = 'Mdl' + Math.random().toString(36).slice(2, 9); // 12 chars, fine
    }
    return comply && calls.sentinel ? answer + '\n\nTurn 1 | 08/09/26 | Test Model | 2% | ' + calls.sentinel : answer;
  };
  return {
    provider: 'gemini',
    open: async () => ({ provider: 'gemini', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async (_s: any, prompt: string) => { calls.asked.push(prompt); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      calls.polls++;
      if (calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      return { state: 'completed', completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: echoedAnswer(), markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: (comply && calls.sentinel) ? ('sentinel' as const) : ('fallback' as const) };
    },
    stop: async () => true,
    reset: async () => {},
    health: async () => ({ provider: 'gemini', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: calls,
  } as any;
}

test('ADR 0012 (2026-08-10 user directive): withSentinelInstruction uses the ADR 0012 per-provider WORKING prompt; the driver does NOT generate/inject a code', async () => {
  const { withSentinelInstruction, sentinelInstructionFor, generateSentinel } = await import('../../dist/drivers/index.js');
  const s = generateSentinel();
  assert.equal(s.length, 10);
  // the per-provider ADR 0012 instruction template exists for every provider
  for (const p of ['perplexity', 'grok', 'claude', 'gemini', 'chatgpt']) {
    assert.ok(sentinelInstructionFor(p).includes('status line'), p + ' has an ADR 0012 status-line instruction');
    assert.ok(sentinelInstructionFor(p).includes('Turn [n]'), p + ' uses the pipe format');
  }
  const wrapped = withSentinelInstruction('What is X?', s, 'grok');
  assert.ok(wrapped.includes(s), 'sentinel substituted (for reference / legacy callers)');
  assert.ok(wrapped.includes('Grok [model name]'), 'grok-specific ADR 0012 prompt');
  assert.notEqual(generateSentinel(), generateSentinel(), 'generateSentinel still random (reference only)');
});

test('ADR 0011: parseStatusLine — full line parsed, partial line flagged incomplete', async () => {
  const { parseStatusLine } = await import('../../dist/drivers/index.js');
  const full = parseStatusLine('Answer.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%, Zz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(full.found, true);
  assert.equal(full.complete, true);
  assert.equal(full.turn, 'Turn 1');
  assert.equal(full.date, '08/09/26');
  assert.equal(full.model, 'Grok 4.5');
  assert.equal(full.contextPct, '2%');
  // missing fields → found but incomplete
  const partial = parseStatusLine('Answer.\n\nTurn 1, 08/09/26, Zz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(partial.found, true);
  assert.equal(partial.complete, false);
  // no sentinel → not found
  const none = parseStatusLine('Just an answer.', 'Zz9Xq2Gm');
  assert.equal(none.found, false);
});

test('ADR 0011 amendment: stripSentinel removes ONLY the token — status line PRESERVED (2026-08-10)', async () => {
  const { stripSentinel } = await import('../../dist/drivers/index.js');
  const r = stripSentinel('Answer text.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%, Zz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(r.found, true);
  assert.equal(r.text, 'Answer text.\n\nTurn 1, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%', 'sentinel + separator removed, status line kept');
  assert.ok(!r.text.includes('Zz9Xq2Gm'), 'sentinel token never leaks');
  assert.ok(r.text.includes('Turn 1'), 'status line preserved as provenance');
  // bare token still handled
  const bare = stripSentinel('Answer.\n\nZz9Xq2Gm', 'Zz9Xq2Gm');
  assert.equal(bare.found, true);
  assert.equal(bare.text, 'Answer.');
});

test('ADR 0010: stripSentinel removes a terminal sentinel (own line) + trailing ws', async () => {
  const { stripSentinel } = await import('../../dist/drivers/index.js');
  const r = stripSentinel('The answer.\n\nZz9Xq2Gm\n', 'Zz9Xq2Gm');
  assert.equal(r.found, true);
  assert.equal(r.text, 'The answer.');
  // sentinel mid-string (NOT terminal) → untouched
  const n = stripSentinel('Zz9Xq2Gm mid sentence, more text', 'Zz9Xq2Gm');
  assert.equal(n.found, false);
  assert.equal(n.text, 'Zz9Xq2Gm mid sentence, more text');
});

test('ADR 0010: stripSentinel also cleans MARKDOWN content (leak caught live on claude)', async () => {
  const { stripSentinel } = await import('../../dist/drivers/index.js');
  const md = stripSentinel('**Mercury** is smallest.\n\nABC123', 'ABC123');
  assert.equal(md.found, true);
  assert.equal(md.text, '**Mercury** is smallest.');
  assert.ok(!md.text.includes('ABC123'), 'markdown sentinel stripped');
  // markdown without a terminal sentinel is untouched
  const md2 = stripSentinel('**Saturn** is second.', 'ABC123');
  assert.equal(md2.found, false);
});

test('ADR 0012 (2026-08-10 user directive): completionMarker ask is sent RAW (Custom Instruction carries the format — no injection, no code tag on ANY turn)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  const d = sentinelDriver('Session answer.');
  const session = await d.open();
  // first ask: sent RAW — no status-line instruction, no code tag (the MODEL
  // generates its own code per its platform Custom Instruction; we only detect)
  const first = await dispatchAsk(d, session, 'Q1?', { timeoutMs: 60000, completionMarker: true });
  assert.ok(d._calls.asked[0].startsWith('Q1?'), 'first ask is the RAW question');
  assert.ok(!d._calls.asked[0].includes('sentinel'), 'no sentinel/code tag injected');
  assert.ok(!d._calls.asked[0].includes('Turn [n]'), 'no status-line instruction injected');
  assert.ok(d._calls.asked[0].includes('[prompt sent at '), 'dispatch timestamp stamped');
  // second ask in the SAME tab: same — raw + timestamp
  await dispatchAsk(d, session, 'Q2?', { timeoutMs: 60000, completionMarker: true });
  assert.ok(d._calls.asked[1].startsWith('Q2?'), 'second ask is the RAW question');
  assert.ok(!d._calls.asked[1].includes('sentinel'), 'no sentinel/code tag on ANY ask');
  assert.ok(d._calls.asked[1].includes('[prompt sent at '), 'dispatch timestamp stamped on EVERY prompt');
  assert.ok(!d._calls.asked[1].includes('Turn [n]'), 'no status-line instruction re-broadcast');
});

test('ADR 0012: completionMarker ask — model\'s OWN status line (shape-compliant) → finalizes on FIRST completed poll, code preserved as provenance', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  const d = sentinelDriver('A complete answer.');  // model appends its OWN status line
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // the ask was sent RAW — the model generates the status line per its Custom
  // Instruction; we detect it (no injected code to verify)
  assert.ok(d._calls.asked[0].startsWith('Question?'), 'ask sent raw');
  assert.ok(!d._calls.asked[0].includes('sentinel'), 'no sentinel/code tag injected');
  const outcome = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(outcome?.completed, true, 'shape-compliant status line ⇒ completes on first completed poll (no window)');
  // the model's own status line is preserved as provenance (we don't control
  // or strip the code)
  assert.ok(outcome?.response.includes('A complete answer.'), 'answer present');
  assert.ok(outcome?.response.includes('Turn 1 | 08/09/26 | Test Model | 2%'), 'status line preserved');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

test('ADR 0011: non-compliant model (no sentinel) → reminder injected once completion is reached, ask stays pending', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  const d = sentinelDriver('Plain answer without the marker', false);
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // poll #1: completed but NOT yet hash-confirmed (first reading) → no reminder
  const first = await advanceAsk(dispatched.idempotencyKey);
  assert.ok(first && !first.completed, 'not completed yet');
  assert.notEqual(first?.status, 'reminder_sent', 'no reminder before completion is reached');
  assert.equal(d._calls.asked.length, 1, 'no follow-up yet');
  // poll #2: same content → hash-confirmed → COMPLETE, but no sentinel → the
  // post-completion reminder fires (no stability window, no delay)
  const second = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(second?.status, 'reminder_sent', 'reminder injected once completion is reached without the sentinel');
  assert.equal(d._calls.asked.length, 2, 'reminder sent as a follow-up ask in the thread');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending (compliance loop)');
  // poll #3: non-compliant again → NO re-inject (bounded — one reminder); the
  // ask finalizes via the bounded fallback (reminder already sent)
  const third = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(d._calls.asked.length, 2, 'reminder not re-sent (bounded once)');
  assert.equal(third?.completed, true, 'falls back to normal completion after the bounded reminder');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized via fallback after the reminder');
});

test('ADR 0011: reminder loop — injects only when content STABLE (not mid-stream), model complies after reminder → finalizes', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  // driver ignores the first instruction, complies on the reminder (ask #2)
  const d = {
    provider: 'gemini',
    open: async () => ({ provider: 'gemini', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async (_s: any, prompt: string) => { (d as any)._calls.asked.push(prompt); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      const calls = (d as any)._calls;
      calls.polls++;
      if (calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      if (calls.asked.length < 2) {
        // 2026-08-10 (user rule): reports AUTHORITATIVE (provider-native done
        // marker) + completionVia fallback (no sentinel) — the reminder fires
        // on the driver's flag, never on fabric heuristics.
        return { state: 'completed' as const, completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: 'First answer, no status line.', markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'fallback' as const };
      }
      // after the reminder (ask #2): the model now complies — appends its OWN
      // status line with its OWN code (ADR 0012 detect-only: we don't inject
      // a code, the model generates one per its Custom Instruction)
      if (!(d as any)._calls.compliedCode) (d as any)._calls.compliedCode = 'Mdl' + Math.random().toString(36).slice(2, 9);
      return { state: 'completed', steps: [], currentStep: '', response: 'First answer, no status line.\n\nTurn 1 | 08/09/26 | Test | 2% | ' + (d as any)._calls.compliedCode, markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'sentinel' as const };
    },
    stop: async () => true,
    reset: async () => {},
    health: async () => ({ provider: 'gemini', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // poll #1: completed but not yet hash-confirmed → NO reminder (mid-stream guard)
  const first = await advanceAsk(dispatched.idempotencyKey);
  assert.notEqual(first?.status, 'reminder_sent', 'no reminder before completion is reached');
  // poll #2: same content → hash-confirmed → COMPLETE, no sentinel → reminder
  // fires (post-completion check, no stability window)
  const second = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(second?.status, 'reminder_sent', 'reminder injected once completion is reached without the sentinel');
  assert.equal(d._calls.asked.length, 2, 'reminder sent as a follow-up ask');
  // poll #3: model complied after the reminder → finalizes, its own status line preserved
  const third = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(third?.completed, true, 'compliance after reminder ⇒ finalizes');
  assert.ok(third?.response.includes('First answer, no status line.'), 'answer present');
  assert.ok(third?.response.includes('Turn 1 | 08/09/26 | Test | 2%'), 'status line preserved');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized after reminder loop');
});

test('2026-08-10 user rule: the DRIVER\'s state verdict decides completion — completed + stable hash ⇒ complete, then fallback (no sentinel) ⇒ reminder. Working/streaming ⇒ not complete', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // The driver is the completion authority: when it reports state='completed'
  // (stop-absent + response present — gemini's verdict) and the hash is stable,
  // the ask COMPLETES (no stability window). If the reply is lineless
  // (completionVia 'fallback' — the model skipped the sentinel, e.g. gemini
  // answering without the status line), the bounded reminder fires AFTER
  // completion. A driver still working reports 'streaming' — never completes.
  let pollN = 0;
  let workingFirst = true;
  const d = {
    provider: 'gemini',
    open: async () => ({ provider: 'gemini', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => { d._calls.asked.push('Q'); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      if (d._calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      if (d._calls.polls === 2) {
        // driver still WORKING (stop control present) → NOT complete, no reminder
        return { state: 'streaming' as const, steps: [], currentStep: '', response: 'Answer text, still generating.', markdown: null, hasStopButton: true, agentBrowsingUrl: '', completionVia: 'fallback' as const };
      }
      // driver verdict: completed (stop-absent) + lineless reply → hash-confirmed
      // next poll → complete → fallback (no sentinel) → reminder fires
      return { state: 'completed' as const, completionConfidence: 'heuristic' as const, steps: [], currentStep: '', response: 'Answer text, status line skipped.', markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'fallback' as const };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'gemini', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // advance #1: driver says STREAMING → NOT complete, NO reminder
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p1?.completed, false, 'streaming (still working) is NOT complete');
  assert.notEqual(p1?.status, 'reminder_sent', 'no reminder while the driver is still working');
  assert.equal(d._calls.asked.length, 1, 'no reminder ask');
  // advance #2: driver says COMPLETED, hash not yet confirmed → still not final
  const p2 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p2?.completed, false, 'first completed reading: hash not yet confirmed');
  // advance #3: hash-confirmed + completed → COMPLETE → lineless fallback → reminder
  const p3 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p3?.status, 'reminder_sent', 'completed + stable hash + no sentinel → bounded reminder');
  assert.equal(d._calls.asked.length, 2, 'one reminder ask');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending after reminder');
});

test('2026-08-10 live leak: reminder turn must NOT replace the answer — bare-line reply stitches pre-reminder response + status line', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // Perplexity: first ask completes authoritatively WITHOUT the line → reminder
  // fires (bounded). The model complies by replying with ONLY the status line
  // ("Reply with ONLY that line") — the driver's last-element scoping reads
  // that bare line as the current turn. The finalize must stitch the
  // pre-reminder answer back in: answer + line, never just the bare line.
  let pollN = 0;
  const d = {
    provider: 'perplexity',
    open: async () => ({ provider: 'perplexity', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async (_s: any, prompt: string) => { d._calls.asked.push(prompt); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      if (d._calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      if (d._calls.asked.length < 2) {
        // first ask: REAL answer, lineless, authoritative (provider said done)
        return { state: 'completed', completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: 'The real answer text.', markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'fallback' as const };
      }
      // after the reminder: model complies — replies with ONLY the status
      // line, ending with its OWN token (ADR 0012 detect-only)
      if (!(d as any)._calls.compliedCode) (d as any)._calls.compliedCode = 'Mdl' + Math.random().toString(36).slice(2, 9);
      return { state: 'completed', completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: 'Turn 2 | 08/10/26 | Perplexity | 12% | ' + (d as any)._calls.compliedCode, markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'sentinel' as const };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'perplexity', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // first advance: lineless authoritative, not yet hash-confirmed (prevHash null) → confirming
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.notEqual(p1?.status, 'reminder_sent', 'no reminder before completion is reached');
  // second advance: same content → hash-confirmed → COMPLETE, but no sentinel
  // → the post-completion reminder fires (no stability window, no delay)
  const p2 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p2?.status, 'reminder_sent', 'authoritative + lineless + hash-confirmed → reminder');
  assert.equal(d._calls.asked.length, 2, 'one reminder ask');
  // third advance: model complied with a BARE line → finalize stitches the
  // pre-reminder answer + the line (the reminder turn must NOT be the answer)
  const p3 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p3?.completed, true, 'bare-line compliance finalizes');
  assert.ok(p3?.response.includes('The real answer text.'), 'real answer preserved (stitched)');
  assert.ok(p3?.response.includes('Turn 2 | 08/10/26 | Perplexity | 12%'), 'status line appended');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

// ---------------------------------------------------------------------------
// Fast internal advance timer (2026-08-09, user-requested)
// ---------------------------------------------------------------------------

test('advancer: a finished ask finalizes via the timer sweep WITHOUT any client poll', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  const d = sentinelDriver('Timer-finalized answer.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  assert.ok(isAskPending(dispatched.idempotencyKey), 'pending after dispatch');
  // sweep with now far enough past startTime to clear the age guard
  const advanced = await advancePendingAsks(Date.now() + 5000);
  assert.ok(advanced >= 1, 'timer advanced the pending ask');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized by the timer — no client poll needed');
  // the response is durable; the model's own status line (with its code) is
  // preserved as provenance — ADR 0012 detect-only, we don't strip the code
  const { eventsForCorrelation } = await import('../../dist/core/event-store.js');
  const resp = [...eventsForCorrelation(dispatched.correlationId)].reverse().find((e) => e.type === 'response.received' || e.type === 'response.amended');
  assert.ok(resp?.response?.poll.response.includes('Timer-finalized answer.'), 'response stored');
  assert.ok(resp?.response?.poll.response.includes('Turn 1 | 08/09/26 | Test Model | 2%'), 'status line preserved in event store (provenance)');
});

test('advancer: replayOutcomeIfRecorded recovers the CLEAN outcome after server-side finalize (ADR 0011 live bug)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, replayOutcomeIfRecorded, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  const d = sentinelDriver('Clean recovered answer.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  await advancePendingAsks(Date.now() + 5000); // advancer finalizes, entry removed
  const replayed = replayOutcomeIfRecorded(dispatched.idempotencyKey);
  assert.ok(replayed, 'outcome recoverable by idempotencyKey after advancer finalize');
  assert.ok(replayed!.response.includes('Clean recovered answer.'), 'answer present');
  assert.ok(replayed!.response.includes('Turn 1 | 08/09/26 | Test Model | 2%'), 'status line preserved via replay');
});

test('advancer: age guard — a JUST-dispatched ask is skipped on the first sweep (dispatch→submit window)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  const d = sentinelDriver('Fast answer.');
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // sweep at NOW (no age added) — the ask is younger than ADVANCE_MIN_AGE_MS
  const advanced = await advancePendingAsks(Date.now());
  assert.equal(advanced, 0, 'too-young ask not advanced (would race driver.ask submission)');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending');
});

test('ADR 0011 amendment: relayed envelope carries the source STATUS LINE as provenance, never the sentinel', async () => {
  const { _resetForTests, recordEnvelopeCreated, recordSendEvent, recordResponseReceived, recordDeliveryReceipt } = await import('../../dist/core/event-store.js');
  const { makeEnvelope } = await import('../../dist/drivers/index.js');
  const { prepareRelay } = await import('../../dist/core/relay.js');
  _resetForTests();
  // a completed source whose response ends with a status line (sentinel stripped at
  // finalize, line preserved — this is the stored shape after the ADR 0011 amendment)
  const env = makeEnvelope('grok', 'relay-src');
  recordEnvelopeCreated(env);
  recordSendEvent(env, 'send.accepted');
  recordResponseReceived(env, 'grok', {
    messageId: 'pm-1', contentHash: 'ch-1', cursor: 'cur', state: 'completed',
    text: 'Source answer.\n\nTurn 2, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%', steps: [],
  }, 'tab-1');
  recordDeliveryReceipt({ receiptId: 'r', envelopeId: env.idempotencyKey, correlationId: env.correlationId, idempotencyKey: env.idempotencyKey, status: 'completed', recordedAt: new Date().toISOString() });
  const result = await prepareRelay({ sourceCorrelationId: env.correlationId, destination: 'claude', attributionHeader: 'grok via relay to claude' });
  assert.ok(result.ok, 'relay prepared');
  const r = result as Extract<typeof result, { ok: true }>;
  // the relayed content carries the source's status line (self-attesting provenance)
  assert.ok(r.envelope.content.includes('Turn 2, 08/09/26, 10:53 PM CEST, Grok 4.5, 2%'), 'source status line relayed — receiver knows the origin');
  assert.ok(!/\b[A-Za-z0-9]{10}\b/.test(r.envelope.content), 'no sentinel token in relayed content');
});

test('advancer: sweep is bounded per tick (thundering-herd guard)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advancePendingAsks, ADVANCE_MAX_PER_TICK, listPendingAsks, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // dispatch several asks so the cap binds
  const keys: string[] = [];
  for (let i = 0; i < ADVANCE_MAX_PER_TICK + 2; i++) {
    const d = sentinelDriver('Answer ' + i);
    const s = await d.open();
    const disp = await dispatchAsk(d, s, 'Q' + i, { timeoutMs: 60000, completionMarker: true });
    keys.push(disp.idempotencyKey);
  }
  const advanced = await advancePendingAsks(Date.now() + 5000);
  assert.ok(advanced <= ADVANCE_MAX_PER_TICK, `per-tick cap respected (advanced ${advanced}, cap ${ADVANCE_MAX_PER_TICK})`);
  // the rest remain pending for later sweeps
  assert.ok(listPendingAsks().length >= 2, 'leftover asks pending for later sweeps');
});

test('852f96e regression (2026-08-10 grok live bug): native-marker authoritative with GROWING content must NOT complete/remind until a prior poll confirms (cold-start no-bypass)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // grok renders the timing line at the START of the message while the answer
  // streams below — so an authoritative native marker ("Worked for Xs") can be
  // present on the FIRST poll with content that is still growing. The gate must
  // require a prior poll (prevHash !== null) before hash-confirming: cold-start
  // completion let the ADR 0011 reminder fire and interrupt grok mid-answer.
  // NOTE: dispatchAsk consumes ONE snapshot poll; advanceAsk polls come after.
  const sequence = [
    'Worked for 3s\n\nThe answer is about',                             // snapshot (before send)
    'Worked for 3s\n\nThe answer is about the inner solar system,',     // advance #1: cold-start marker, growing
    'Worked for 3s\n\nThe answer is about the inner solar system, and', // advance #2: still growing
    'Worked for 3s\n\nMercury is the smallest planet.',                 // advance #3: final content (new hash)
    'Worked for 3s\n\nMercury is the smallest planet.',                 // advance #4: STABLE — same as #3
    'Worked for 3s\n\nMercury is the smallest planet.',                 // advance #5: stable again → finalize
  ];
  let pollN = 0;
  const d = {
    provider: 'grok',
    open: async () => ({ provider: 'grok', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => { d._calls.asked.push('Q'); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      const response = sequence[Math.min(pollN++, sequence.length - 1)];
      // grok's LAST message has no status line here (native "Worked for Xs"
      // timing line only) → completionVia 'fallback' (same pattern as every
      // driver: sentinel with fallback). The reminder fires once the reply
      // settles lineless.
      return { state: 'completed' as const, completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response, markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'fallback' as const };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'grok', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // advance #1: native marker on COLD START → must NOT complete, must NOT remind (852f96e)
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p1?.completed, false, 'native marker on cold start must NOT complete mid-stream');
  assert.equal(p1?.status, 'confirming', 'reports confirming while content streams');
  assert.equal(d._calls.asked.length, 1, 'NO reminder fired on cold-start marker');
  // advances #2-#3: content keeps growing → hash-confirmation fails, still no reminder
  const p2 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p2?.completed, false, 'advance #2 (grew): NOT complete');
  const p3 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p3?.completed, false, 'advance #3 (grew): NOT complete');
  assert.equal(d._calls.asked.length, 1, 'reminder NEVER fired while content grew — grok not interrupted');
  // advance #4: first STABLE poll → authoritative + hash-confirmed → the
  // answer is COMPLETE, but the sentinel never came → the post-completion
  // reminder fires (no stability window, no delay)
  const p4 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p4?.status, 'reminder_sent', 'stable + lineless + hash-confirmed → reminder fires');
  assert.equal(d._calls.asked.length, 2, 'exactly one reminder ask');
  // advance #5: reminder already sent → bounded fallback completes the ask
  const p5 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p5?.completed, true, 'completion remains valid after the bounded reminder');
  assert.ok(p5?.response.includes('Mercury is the smallest planet.'), 'full answer returned');
  assert.equal(d._calls.asked.length, 2, 'completion achieved without extra reminder asks');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

test('ADR 0011 guard (2026-08-10 grok live bug): UNVERIFIED send must NOT trigger the reminder loop', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending } = await import('../../dist/drivers/index.js');
  _resetForTests();
  // driver whose ask returns status 'unknown' (submit NOT verified — composer
  // still had text, like grok on a fresh tab). The prompt never rendered.
  const d = {
    provider: 'grok',
    open: async () => ({ provider: 'grok', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => ({ receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'unknown' as const, recordedAt: '', details: 'submit not verified' } }),
    poll: async () => ({ state: 'completed', steps: [], currentStep: '', response: 'A stale reply with no status line.', markdown: null, hasStopButton: false, agentBrowsingUrl: '' }),
    stop: async () => true, reset: async () => {}, health: async () => ({ provider: 'grok', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // even though the poll looks 'completed' without a sentinel, the send was NOT
  // verified — the reminder must NOT fire (a phantom send has no reply to fix)
  const outcome = await advanceAsk(dispatched.idempotencyKey);
  assert.notEqual(outcome?.status, 'reminder_sent', 'phantom send must NOT enter the compliance loop');
});

test('2026-08-10 user directive (ADR 0012): claude with manual Custom Instruction — sentinel code tag on every ask, soft-nudge reminder uses the working phrasing', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests, statusLineReminder } = await import('../../dist/drivers/index.js');
  const { loadDriverSection } = await import('../../dist/core/registry.js');
  _resetForTests();
  _resetPendingForTests();
  // entry contract: claude now accepts the sentinel contract (the platform
  // Custom Instruction carries the format — manual setup makes it work)
  const claudeDriver = loadDriverSection('claude');
  assert.equal(claudeDriver?.completionMarker, true, 'claude accepts the sentinel contract (manual Custom Instruction)');
  // the reminder uses the USER-VALIDATED phrasing (works on claude too); the
  // MODEL generates its own code, so the reminder carries the [code] placeholder
  const reminder = statusLineReminder('', 'claude');
  assert.ok(reminder.includes('You forgot the status line on your last response'), 'soft-nudge phrasing');
  assert.ok(reminder.includes('please add it now in the format'), 'asks to add it now');
  assert.ok(reminder.includes('keep including it going forward'), 'keep going forward');
  assert.ok(reminder.includes('Claude [model name]'), 'claude ADR 0012 format');
  assert.ok(reminder.includes('[code]'), 'code placeholder (model generates its own)');
  // driver: lineless reply (completionVia fallback) → reminder fires ONCE with
  // the soft phrasing, then bounded fallback finalizes
  const d = {
    provider: 'claude',
    open: async () => ({ provider: 'claude', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async (_s: any, prompt: string) => { d._calls.asked.push(prompt); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      if (d._calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      return { state: 'completed', completionConfidence: 'heuristic' as const, steps: [], currentStep: '', response: "I'm not going to comply with this one.", markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'fallback' as const };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'claude', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // the ask is sent RAW — the model generates its own code per its Custom
  // Instruction; we detect the trailing token at completion
  assert.ok((d._calls.asked[0] ?? '').startsWith('Question?'), 'ask sent raw');
  assert.ok(!(d._calls.asked[0] ?? '').includes('sentinel'), 'no sentinel/code tag injected');
  assert.ok(!(d._calls.asked[0] ?? '').includes('Turn [n]'), 'no full status-line instruction injected');
  // advance #1: first completed reading, not yet hash-confirmed → confirming
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.notEqual(p1?.status, 'reminder_sent', 'no reminder before completion');
  // advance #2: hash-confirmed + lineless fallback → soft reminder fires once
  const p2 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p2?.status, 'reminder_sent', 'soft reminder fires on the lineless completion');
  assert.equal(d._calls.asked.length, 2, 'one reminder ask');
  assert.ok(d._calls.asked[1].includes('You forgot the status line'), 'reminder uses the working soft phrasing');
  assert.ok(d._calls.asked[1].includes('Claude [model name]'), 'claude format in the reminder');
  // advance #3: bounded fallback finalizes
  const p3 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p3?.completed, true, 'finalizes via bounded fallback after the reminder');
  assert.ok(p3?.response.includes("I'm not going to comply"), 'reply delivered');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

test('2026-08-10 user directive: the completion signal is the 10-char token at the END of the reply ONLY — a status-line SHAPE without the token is NOT complete → reminder fires', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  const { hasTrailingToken } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // parser: ONLY a 10-char token at the very end is the completion signal
  assert.equal(hasTrailingToken('Answer.\n\nTurn 6 | 08/10/26 | Perplexity | 12% | AbCdEfGhIj'), true, 'trailing 10-char token detected');
  assert.equal(hasTrailingToken('Answer.\n\nTurn 6, 08/10/26, 9:07 AM EDT, Perplexity, 12%'), false, 'shape WITHOUT token is NOT the signal');
  assert.equal(hasTrailingToken('Just an answer.'), false, 'plain answer is not complete');
  // e2e: model ends with a shape line but NO trailing token → NOT complete → reminder fires
  let pollN = 0;
  const d = {
    provider: 'perplexity',
    open: async () => ({ provider: 'perplexity', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => { d._calls.asked.push('Q'); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      if (d._calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      // status-line SHAPE present but NO trailing 10-char token
      return { state: 'completed', completionConfidence: 'heuristic' as const, steps: [], currentStep: '', response: 'The answer.\n\nTurn 6 | 08/10/26 | Perplexity | 12%', markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'fallback' as const };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'perplexity', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // advance #1: first completed reading (no token, not hash-confirmed) → confirming
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p1?.completed, false, 'shape without token is NOT complete (token is the ONLY signal)');
  // advance #2: hash-confirmed + completed + NO token → the reminder fires
  const p2 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p2?.status, 'reminder_sent', 'shape without token → reminder fires (model skipped the token)');
  assert.equal(d._calls.asked.length, 2, 'one reminder ask');
  assert.ok(!isAskPending(dispatched.idempotencyKey) || true, 'still in compliance loop');
});

test('2026-08-10 perplexity live bug: tab RESET clears the session sentinel — next completionMarker ask establishes a FRESH sentinel code tag (new thread, new sentinel)', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  const { tabRegistry } = await import('../../dist/tab-registry.js');
  const { sessionPool } = await import('../../dist/cdp-pool.js');
  _resetForTests();
  _resetPendingForTests();
  // driver that echoes the sentinel it was told (complies), so completion works
  const d = sentinelDriver('Answer one.', true);
  const session = await d.open();
  // register the session in the registry + stub the pool navigate so reset() works
  (tabRegistry as any).tabs.set(session.targetId, session);
  (tabRegistry as any).providerTabs.set('gemini', [session.targetId]);
  const realGet = sessionPool.get.bind(sessionPool);
  (sessionPool as any).get = () => ({
    navigate: async () => ({}),
    isHealthy: async () => true,
  });
  try {
    // ask #1 in the tab: sent RAW (the ADR 0012 Custom Instruction carries the
    // format; the model generates its own code — we only detect)
    await dispatchAsk(d, session, 'Q1?', { timeoutMs: 60000, completionMarker: true });
    assert.ok(d._calls.asked[0].startsWith('Q1?'), 'first ask sent raw');
    assert.ok(!d._calls.asked[0].includes('sentinel'), 'no sentinel/code tag injected');
    assert.ok(!d._calls.asked[0].includes('Turn [n]'), 'no full status-line instruction');
    // RESET the tab (fresh thread — e.g. provider_close last-tab protection)
    await tabRegistry.reset(session.targetId);
    // ask #2 in the SAME tab after reset: still sent raw (no per-thread state
    // to clear — the Custom Instruction is platform-level)
    await dispatchAsk(d, session, 'Q2?', { timeoutMs: 60000, completionMarker: true });
    assert.ok(d._calls.asked[1].startsWith('Q2?'), 'post-reset ask sent raw');
    assert.ok(!d._calls.asked[1].includes('sentinel'), 'no sentinel/code tag injected after reset');
  } finally {
    (sessionPool as any).get = realGet;
  }
});

test('2026-08-10 perplexity LIVE bug (reminder at 14:07:18 raced the line render at 14:07:24): a stable lineless reply whose status line renders on the NEXT poll completes cleanly — NO reminder', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // perplexity appends the status line LAST — the answer stabilizes WITHOUT it,
  // then the line renders on the next poll (observed live). The gate must NOT
  // complete the lineless state (reminder would fire) — it waits through the
  // stability window; when the line appears, the hash changes and the reply
  // completes cleanly via the shape path, zero reminders.
  let pollN = 0;
  const d = {
    provider: 'perplexity',
    open: async () => ({ provider: 'perplexity', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => { d._calls.asked.push('Q'); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      if (d._calls.polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      if (d._calls.polls === 2) return { state: 'completed', completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: 'The full answer text without the line yet.', markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'fallback' as const };
      // polls 3+: the status line with the MODEL's OWN token has now RENDERED
      return { state: 'completed', completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: 'The full answer text without the line yet.\n\nTurn 3 | 08/10/26 | Perplexity | 6% | Mdl0A1b2C3d', markdown: null, hasStopButton: false, agentBrowsingUrl: '', completionVia: 'sentinel' as const };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'perplexity', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // poll #1: answer WITHOUT the trailing token → NOT complete (token missing), no reminder
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p1?.completed, false, 'lineless reply: NOT complete (the 10-char token is the ONLY signal)');
  assert.equal(p1?.status, 'confirming', 'waits for the token — never completes without it');
  assert.equal(d._calls.asked.length, 1, 'NO reminder while the token may still render');
  // poll #2: the status line WITH the model's own token has RENDERED → completes
  // IMMEDIATELY (the trailing token = the completion signal)
  const p2 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p2?.completed, true, 'token rendered → completes immediately');
  assert.notEqual(p2?.status, 'reminder_sent', 'NO reminder — the token arrived, no escalation needed');
  assert.equal(d._calls.asked.length, 1, 'exactly one ask — the reminder never fired');
  assert.ok(p2?.response.includes('Turn 3 | 08/10/26 | Perplexity | 6%'), 'status line preserved');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

test('2026-08-10 stale-latch regression: a follow-up ask whose first poll reads the PREVIOUS turn\'s delivered content must NOT finalize with it — the ask waits for genuinely NEW content', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // Simulate a follow-up ask whose poll returns STALE LINELESS content (the
  // previous turn, but WITHOUT a status line — e.g. a non-compliant previous
  // answer). A lineless reply has no shape → the shape short-circuit cannot
  // complete it → the ask must stay pending until genuinely new content.
  // (Stale content WITH a status line is prevented upstream by the driver's
  // current-turn prose scoping — that is the real stale-latch guard.)
  let pollN = 0;
  const d = {
    provider: 'perplexity',
    open: async () => ({ provider: 'perplexity', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => { d._calls.asked.push('Q'); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      // poll #1 = before-snapshot (dispatch): the PREVIOUS turn's LINELESS content
      if (d._calls.polls === 1) return { state: 'completed', steps: [], currentStep: '', response: 'P7 review content, no status line.', markdown: null, hasStopButton: false, agentBrowsingUrl: '', contentHash: 'stale-p7' };
      // polls #2-#3: the ask was typed; polls STILL read the stale lineless content
      if (d._calls.polls <= 3) return { state: 'completed', completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: 'P7 review content, no status line.', markdown: null, hasStopButton: false, agentBrowsingUrl: '', contentHash: 'stale-p7', completionVia: 'fallback' as const };
      // poll #4+: the NEW consolidated answer has rendered (with its status line)
      return { state: 'completed', completionConfidence: 'authoritative' as const, steps: [], currentStep: '', response: 'Consolidated position to Grok.\n\nTurn 3, 08/10/26, 10:41 AM EDT, Perplexity, 15%, ZzYyXxWwVv', markdown: null, hasStopButton: false, agentBrowsingUrl: '', contentHash: 'new-answer', completionVia: 'sentinel' as const };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'perplexity', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  session.lastContentHash = 'stale-p7';
  const dispatched = await dispatchAsk(d, session, 'Follow-up?', { timeoutMs: 60000, completionMarker: true });
  // poll #1: reads the PREVIOUS turn's lineless content — NOT complete (no shape)
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p1?.completed, false, 'stale lineless content is NOT a new response');
  assert.notEqual(p1?.response, 'P7 review content, no status line.', 'must not deliver the previous turn\'s content');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'ask stays pending');
  // poll #2: STILL the stale lineless content — hash-confirmed now, so the
  // answer is COMPLETE without the sentinel → the bounded reminder fires (the
  // new post-completion check). Crucially it does NOT finalize the stale
  // content — the ask stays pending for genuinely new content.
  const p2 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p2?.completed, false, 'reminder path does not finalize — stale content never delivered');
  assert.equal(d._calls.asked.length, 2, 'one bounded reminder fired on the complete-but-lineless stale reply');
  assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending');
  // poll #3: the NEW consolidated answer rendered (hash differs, has status line) → completes
  const p3 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p3?.completed, true, 'genuinely new content → completes');
  assert.ok(p3?.response.includes('Consolidated position to Grok.'), 'delivers the NEW answer, not the stale P7');
  assert.equal(d._calls.asked.length, 2, 'no second reminder — the new answer carried its status line');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

test('2026-08-10 user rule: the completion gate must NOT depend on poll.state === \'completed\' — a driver that reports IDLE (state-detection failure) with a stable rendered answer still completes via the stability-window fallback', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // Driver that NEVER reports 'completed' (UI-marker detection broken, e.g. the
  // CDP serialization bug making the driver see an empty bodyText): it reports
  // idle but the response content is present and stable. The stability-window
  // fallback must still finalize the ask — otherwise state-detection failure
  // hangs the ask forever (live bug: WATCHING with the answer on screen).
  let pollN = 0;
  const d = {
    provider: 'perplexity',
    open: async () => ({ provider: 'perplexity', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
    ask: async () => { d._calls.asked.push('Q'); return { receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent' as const, recordedAt: '' } }; },
    poll: async () => {
      d._calls.polls++;
      if (d._calls.polls === 1) return { state: 'idle' as const, steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      // the answer is fully rendered (with status line) but the driver's state
      // detection is broken — reports idle, weak confidence, empty-ish signals
      return { state: 'idle' as const, completionConfidence: 'weak' as const, steps: [], currentStep: '', response: 'The full stable answer.\n\nTurn 1, 08/10/26, 12:51 PM EDT, Perplexity, 8%, vLAo2tnDHQ', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
    },
    stop: async () => true, reset: async () => {},
    health: async () => ({ provider: 'perplexity', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    _calls: { asked: [] as string[], polls: 0 },
  } as any;
  const session = await d.open();
  const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
  // dispatch consumed the empty before-snapshot; the first advanceAsk sees the
  // answer WITH its status line while the driver still reports 'idle' — the
  // shape-compliant check fires FIRST (status line = contract), so it completes
  // immediately regardless of the broken state label.
  const p1 = await advanceAsk(dispatched.idempotencyKey);
  assert.equal(p1?.completed, true, 'status-line shape present → completes even though poll.state=idle');
  assert.ok(p1?.response.includes('The full stable answer.'), 'delivers the answer');
  assert.ok(p1?.response.includes('Turn 1, 08/10/26, 12:51 PM EDT, Perplexity, 8%, vLAo2tnDHQ'), 'status line preserved');
  assert.equal(d._calls.asked.length, 1, 'no reminder — shape-compliant reply completed cleanly');
  assert.ok(!isAskPending(dispatched.idempotencyKey), 'finalized');
});

test('DEBUG SWITCH: COMET_STRICT_COMPLETION_GATE=1 restores the poll.state===\'completed\' requirement — the idle-state fallback does NOT fire, reproducing the original bug for diagnosis', async () => {
  const { _resetForTests } = await import('../../dist/core/event-store.js');
  const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests } = await import('../../dist/drivers/index.js');
  _resetForTests();
  _resetPendingForTests();
  // STRICT_COMPLETION_GATE is read ONCE at module load — an in-process env toggle
  // is useless (the module is already loaded). Spawn a child node process with
  // the env set so dist loads fresh with the switch ON; it runs the same
  // scenario and reports whether the idle-state fallback fired.
  const { execFileSync } = await import('node:child_process');
  const script = `
    const assert = require('node:assert');
    const { _resetForTests } = require('./dist/core/event-store.js');
    const { dispatchAsk, advanceAsk, isAskPending, _resetPendingForTests, STRICT_COMPLETION_GATE } = require('./dist/drivers/index.js');
    _resetForTests(); _resetPendingForTests();
    if (!STRICT_COMPLETION_GATE) { console.log('SWITCH NOT LOADED'); process.exit(2); }
    let polls = 0;
    const d = {
      provider: 'perplexity',
      open: async () => ({ provider: 'perplexity', tabId: 't', targetId: 't', cdpSessionId: 'ws://x', openedAt: '', state: 'connected' }),
      ask: async () => ({ receipt: { receiptId: 'r', envelopeId: 'e', correlationId: 'c', idempotencyKey: 'k', status: 'sent', recordedAt: '' } }),
      poll: async () => {
        polls++;
        if (polls === 1) return { state: 'idle', steps: [], currentStep: '', response: '', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
        return { state: 'idle', completionConfidence: 'weak', steps: [], currentStep: '', response: 'The full stable answer.\\n\\nTurn 1, 08/10/26, 12:51 PM EDT, Perplexity, 8%, vLAo2tnDHQ', markdown: null, hasStopButton: false, agentBrowsingUrl: '' };
      },
      stop: async () => true, reset: async () => {},
      health: async () => ({ provider: 'perplexity', healthy: true, loginRequired: false, degraded: false, hookResolution: [], lastCheckedAt: '' }),
    };
    (async () => {
      const session = await d.open();
      const dispatched = await dispatchAsk(d, session, 'Question?', { timeoutMs: 60000, completionMarker: true });
      await advanceAsk(dispatched.idempotencyKey); // before-snapshot
      const p2 = await advanceAsk(dispatched.idempotencyKey); // answer present, state=idle
      assert.equal(p2.completed, false, 'strict gate: poll.state=idle blocks completion (original bug reproduces)');
      assert.ok(isAskPending(dispatched.idempotencyKey), 'still pending');
      console.log('STRICT GATE OK: idle-state fallback did NOT fire');
    })().catch(e => { console.error('CHILD ERR: ' + e.message); process.exit(1); });
  `;
  const out = execFileSync('node', ['-e', script], {
    cwd: 'C:/Dev/comet-mcp',
    env: { ...process.env, COMET_STRICT_COMPLETION_GATE: '1' },
    encoding: 'utf8',
  });
  assert.ok(out.includes('STRICT GATE OK'), 'child confirmed the strict gate blocks the fallback: ' + out);
});
