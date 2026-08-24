/**
 * P6 driver tests (2026-08-08) — entry-driven BaseChatDriver adapters
 * (gemini / chatgpt / claude) exercised against the REAL captured + synthetic
 * fixtures via the jsdom harness (test/unit/p6-harness.ts).
 *
 * Covers (design doc §9 + Grok review additions):
 *  - full state machine per driver (idle/streaming/completed/login_required/
 *    blocked/degraded) through the actual in-page scripts;
 *  - P6 gate: completed with empty extraction is REJECTED — degrade instead;
 *  - submit ladders (click / enter-fallback / click-after-type, claude never Enter);
 *  - structured health: missing selector → degraded + named missing hook; login probe;
 *  - extraction: response, markdown, messageId anchors (chatgpt);
 *  - concurrent two-provider poll isolation.
 */

import assert from 'node:assert';
import { test, beforeEach, afterEach } from 'node:test';
import { sessionPool } from '../../dist/cdp-pool.js';
import { geminiDriver } from '../../dist/drivers/gemini.js';
import { chatgptDriver } from '../../dist/drivers/chatgpt.js';
import { claudeDriver } from '../../dist/drivers/claude.js';
import { makeHandle, testSession, fixture } from './p6-harness.ts';

let current: ReturnType<typeof makeHandle> | null = null;
const origGet = sessionPool.get.bind(sessionPool);

beforeEach(() => {
  // Route driver handleFor() to the fixture-backed fake handle.
  (sessionPool as any).get = (_targetId: string) => current;
});

afterEach(() => {
  (sessionPool as any).get = origGet;
  current = null;
});

const session = testSession('gemini');

async function pollWith(provider: string, name: string, extra?: { pressClearsComposer?: string }) {
  current = makeHandle(fixture(provider, name), extra);
  const driver = { gemini: geminiDriver, chatgpt: chatgptDriver, claude: claudeDriver }[provider as 'gemini' | 'chatgpt' | 'claude'];
  return driver.poll(testSession(provider));
}

// ---------------------------------------------------------------------------
// state machines
// ---------------------------------------------------------------------------

test('P6 gemini: streaming fixture → streaming + stop button observed', async () => {
  const r = await pollWith('gemini', 'streaming.html');
  assert.equal(r.state, 'streaming');
  assert.equal(r.hasStopButton, true);
  assert.equal(r.response, '');
});

test('P6 gemini: completed fixture → completed, real answer extracted', async () => {
  const r = await pollWith('gemini', 'completed.html');
  assert.equal(r.state, 'completed');
  assert.ok(r.response.includes('ALPHA'), `response missing ALPHA: "${r.response.slice(0, 120)}"`);
  assert.ok(r.contentHash, 'contentHash must be set');
  assert.ok(r.markdown && r.markdown.length > 0, 'markdown must be produced');
});

test('P6 gemini: login fixture → login_required', async () => {
  const r = await pollWith('gemini', 'login.html');
  assert.equal(r.state, 'login_required');
});

test('P6 gemini: blocked fixture → blocked', async () => {
  const r = await pollWith('gemini', 'blocked.html');
  assert.equal(r.state, 'blocked');
});

test('P6 gemini: idle fixture → idle', async () => {
  const r = await pollWith('gemini', 'idle.html');
  assert.equal(r.state, 'idle');
});

test('P6 chatgpt: streaming fixture → streaming + messageId anchor present', async () => {
  const r = await pollWith('chatgpt', 'streaming.html');
  assert.equal(r.state, 'streaming');
  assert.equal(r.hasStopButton, true);
  assert.equal(r.messageId, 'stream-abc-123');
});

test('P6 chatgpt: completed fixture → completed, OK + native messageId', async () => {
  const r = await pollWith('chatgpt', 'completed.html');
  assert.equal(r.state, 'completed');
  assert.ok(r.response.includes('OK'), `response missing OK: "${r.response.slice(0, 80)}"`);
  assert.equal(r.messageId, 'f70146d3-4e3f-465e-a948-74d6c913cf69');
  assert.ok(r.markdown && r.markdown.length > 0, 'markdown must be produced');
});

test('P6 chatgpt: login fixture → login_required', async () => {
  const r = await pollWith('chatgpt', 'login.html');
  assert.equal(r.state, 'login_required');
});

test('P6 chatgpt: blocked fixture (captcha wall) → blocked', async () => {
  const r = await pollWith('chatgpt', 'blocked.html');
  assert.equal(r.state, 'blocked');
});

test('P6 GATE: chatgpt empty response container → degraded, never silent-empty completed', async () => {
  const r = await pollWith('chatgpt', 'empty-container.html');
  assert.equal(r.state, 'degraded');
  assert.equal(r.response, '');
});

test('P6 claude: streaming fixture → streaming', async () => {
  const r = await pollWith('claude', 'streaming.html');
  assert.equal(r.state, 'streaming');
  assert.equal(r.hasStopButton, true);
});

test('P6 claude: completed fixture → completed, READY via loose responseSelector', async () => {
  const r = await pollWith('claude', 'completed.html');
  assert.equal(r.state, 'completed');
  assert.ok(r.response.includes('READY'), `response missing READY: "${r.response.slice(0, 80)}"`);
  assert.ok(r.contentHash, 'contentHash must be set');
  assert.ok(r.markdown && r.markdown.length > 0, 'markdown must be produced');
});

test('P6 claude: login fixture → login_required', async () => {
  const r = await pollWith('claude', 'login.html');
  assert.equal(r.state, 'login_required');
});

test('P6 claude: error fixture → degraded (never silent-empty)', async () => {
  const r = await pollWith('claude', 'error.html');
  assert.equal(r.state, 'degraded');
  assert.equal(r.response, '');
});

// ---------------------------------------------------------------------------
// submit ladders
// ---------------------------------------------------------------------------

test('P6 chatgpt: submit = click send button, no Enter fallback, receipt sent', async () => {
  current = makeHandle(fixture('chatgpt', 'typing-send.html'));
  const { receipt } = await chatgptDriver.ask(testSession('chatgpt'), 'Answer with one word: PONG');
  assert.equal(receipt.status, 'sent', JSON.stringify(receipt));
  assert.deepEqual(current!.pressCalls, [], 'click path must not press Enter');
});

test('P6 gemini: submit = click, Enter fallback when send button absent (verify gates sent)', async () => {
  current = makeHandle(fixture('gemini', 'idle.html')); // composer only — no send button
  const { receipt } = await geminiDriver.ask(testSession('gemini'), 'PONG');
  assert.equal(receipt.status, 'sent', JSON.stringify(receipt)); // empty composer verifies submit
  assert.deepEqual(current!.pressCalls, ['Enter'], 'fallback must press Enter exactly once');
});

test('P6 claude: submit = click-after-type, Enter NEVER pressed (774e875 contract)', async () => {
  current = makeHandle(fixture('claude', 'typing-send.html'));
  const { receipt } = await claudeDriver.ask(testSession('claude'), 'Answer with one word: PONG');
  assert.equal(receipt.status, 'sent', JSON.stringify(receipt));
  assert.deepEqual(current!.pressCalls, [], 'claude must never press Enter');
});

test('P6 claude: send button missing → receipt unknown, still no Enter', async () => {
  current = makeHandle(fixture('claude', 'idle.html')); // composer only — no send button
  const { receipt } = await claudeDriver.ask(testSession('claude'), 'PONG');
  assert.equal(receipt.status, 'unknown', JSON.stringify(receipt));
  assert.deepEqual(current!.pressCalls, [], 'claude must never press Enter, even on failure');
});

// ---------------------------------------------------------------------------
// structured health (P6 gate)
// ---------------------------------------------------------------------------

test('P6 health: missing modelPicker → healthy false, degraded, failing hook named', async () => {
  current = makeHandle(fixture('gemini', 'typing-send.html')); // no modelPicker / responseContainer
  const h = await geminiDriver.health(testSession('gemini'));
  assert.equal(h.healthy, false);
  assert.equal(h.degraded, true);
  const mp = h.hookResolution.find((c) => c.control === 'modelPicker');
  assert.ok(mp, 'modelPicker must be in hookResolution');
  // fingerprint-carrying control that failed resolve reports 'override';
  // a never-seen control reports 'missing' — both are failures, neither is
  // a silent known-selector hit.
  assert.ok(mp.source === 'missing' || mp.source === 'override', `modelPicker source: ${mp.source}`);
  assert.ok(h.lastVerifiedAt, 'lastVerifiedAt must be set');
  assert.ok(typeof h.workingSignal?.observed === 'boolean', 'workingSignal probe must be present');
});

test('P6 health: login wall → loginRequired true, healthy false', async () => {
  current = makeHandle(fixture('claude', 'login.html'));
  const h = await claudeDriver.health(testSession('claude'));
  assert.equal(h.loginRequired, true);
  assert.equal(h.healthy, false);
  assert.equal(h.degraded, true);
});

test('P6 health: healthy path — all gemini controls present', async () => {
  // full fixture: composer + sendButton + modelPicker + responseContainer
  const html = fixture('gemini', 'completed.html')
    + '<div class="ql-editor textarea new-input-ui" contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini"><p>x</p></div>'
    + '<button aria-label="Gemini Apps Activity"><svg><rect/></svg></button>'
    + '<button aria-label="Send message"><svg><rect/></svg></button>';
  current = makeHandle(html);
  const h = await geminiDriver.health(testSession('gemini'));
  assert.equal(h.healthy, true, JSON.stringify(h.hookResolution));
  assert.equal(h.loginRequired, false);
});

// ---------------------------------------------------------------------------
// extraction + anchors
// ---------------------------------------------------------------------------

test('P6 extraction: chatgpt completed — markdown converts the turn', async () => {
  const r = await pollWith('chatgpt', 'completed.html');
  assert.ok(r.markdown, 'markdown must exist');
  assert.ok((r.markdown || '').includes('OK') || (r.markdown || '').length > 0);
});

test('P6 extraction: gemini completed — disclaimer strip leaves the answer', async () => {
  const r = await pollWith('gemini', 'completed.html');
  assert.ok(r.response.includes('ALPHA'));
  assert.ok(!/Gemini can make mistakes/.test(r.response), 'disclaimer should be stripped');
});

// ---------------------------------------------------------------------------
// concurrency isolation (Grok review addition #2, unit level)
// ---------------------------------------------------------------------------

test('P6 isolation: gemini + chatgpt poll concurrently, no cross-talk', async () => {
  current = makeHandle(fixture('gemini', 'completed.html'));
  const g = geminiDriver.poll(testSession('gemini'));
  current = makeHandle(fixture('chatgpt', 'completed.html'));
  const c = chatgptDriver.poll(testSession('chatgpt'));
  const [gr, cr] = await Promise.all([g, c]);
  assert.equal(gr.state, 'completed');
  assert.equal(cr.state, 'completed');
  assert.ok(gr.response.includes('ALPHA'));
  assert.ok(cr.response.includes('OK'));
  assert.notEqual(gr.contentHash, cr.contentHash, 'distinct answers must hash differently');
});
