// P3 reconnect-dedup live gate:
// 1. Ask grok with a fixed idempotency key → completes, response.received recorded,
//    durable extraction cursor checkpointed per tab.
// 2. Simulate a session drop: tabRegistry.reconnect('grok') → fresh pooled CDP
//    session, dedup anchors re-hydrated from the durable store.
// 3. Retry with the SAME key → replay guard returns the prior outcome (replayed=true):
//    NO duplicate send, NO duplicate response event.
// 4. Verify the event log: exactly ONE response.received for the correlation, and the
//    re-hydrated session carries the durable cursor (unchanged content → no new event).
// Run: node test/integration/p3-reconnect-dedup.mjs
import { getDriver, askAndWaitOn } from '../../dist/drivers/index.js';
import { openTab } from '../../dist/drivers/index.js';
import { tabRegistry } from '../../dist/tab-registry.js';
import { eventsForCorrelation, getCursor } from '../../dist/core/event-store.js';

const KEY = `rd-${Date.now().toString(36)}`;
// unique token per run: the tab may already hold an identical old answer, and the
// before/after hash comparison treats identical content as "no new response" (dedup
// by design) — so the prompt must produce content distinct from any prior run.
const TOKEN = `PONG-${Date.now().toString(36)}`;
const PROMPT = `Say only: ${TOKEN}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const driver = getDriver('grok');
const session = await openTab('grok');

// scoped reset first: reconnect-dedup matters for a fresh session, and a stale
// completed chat would make the before/after comparison see "no new response"
await driver.reset(session);

// 1. first ask — completes, response recorded + cursor checkpointed
const first = await askAndWaitOn(driver, session, PROMPT, 90000, { idempotencyKey: KEY });
check('first ask completed', first.completed, `status=${first.status}`);
check('not marked deduped on first run', first.deduped !== true);
check('answer contains token', first.response.includes(TOKEN), `"${first.response.slice(0, 40)}"`);
const corr = first.correlationId;
const evs1 = eventsForCorrelation(corr);
check('response.received recorded', evs1.filter(e => e.type === 'response.received').length === 1);

// durable cursor must exist for this tab now
const durableBefore = getCursor('grok', session.targetId);
check('durable cursor checkpointed', !!durableBefore, `cursor=${durableBefore}`);

// 2. simulate a session drop + reconnect
const reconnected = await tabRegistry.reconnect('grok');
check('reconnect returns a session', !!reconnected.targetId, `tabId=${reconnected.targetId.slice(0, 12)}…`);
check('anchors re-hydrated from durable store', reconnected.extractionCursor === durableBefore, `cursor=${reconnected.extractionCursor}`);
check('session state connected', reconnected.state === 'connected');

// 3. retry with the SAME key — replay guard must return prior outcome, no re-send
const second = await askAndWaitOn(driver, reconnected, PROMPT, 90000, { idempotencyKey: KEY });
check('retry marked replayed', second.replayed === true, `replayed=${second.replayed}`);
check('retry returns same answer', second.response === first.response, `"${first.response.slice(0, 30)}"`);

// 4. event-log proof: still exactly ONE response.received, no duplicate
const evs2 = eventsForCorrelation(corr);
const received = evs2.filter(e => e.type === 'response.received').length;
const queued = evs2.filter(e => e.type === 'send.queued').length;
check('exactly ONE response.received after reconnect+retry', received === 1, `received=${received}`);
check('exactly ONE send.queued after reconnect+retry', queued === 1, `queued=${queued}`);

const pass = results.every(r => r.ok);
console.log(pass ? '\nP3 RECONNECT-DEDUP LIVE GATE: PASS' : `\nP3 RECONNECT-DEDUP LIVE GATE: FAIL (${results.filter(r => !r.ok).length})`);
process.exit(pass ? 0 : 1);
