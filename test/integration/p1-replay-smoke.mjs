// P1 Half 2 live smoke: replay safety end-to-end.
// 1. Ask grok with a FIXED idempotency key → send happens, response recorded.
// 2. Replay the SAME key → askAndWaitOn returns the prior outcome (replayed=true),
//    and the event log shows exactly ONE send.queued / response.received for that correlation.
// Run: node test/integration/p1-replay-smoke.mjs
import { getDriver, askAndWaitOn, makeEnvelope } from '../../dist/drivers/index.js';
import { openTab } from '../../dist/drivers/index.js';
import { eventsForCorrelation } from '../../dist/core/event-store.js';
import { _resetForTests } from '../../dist/core/event-store.js';

const KEY = `smoke-${Date.now().toString(36)}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const driver = getDriver('grok');
const session = await openTab('grok');

// 1. first ask with a fixed key
const first = await askAndWaitOn(driver, session, 'Say only: PONG', 90000, { idempotencyKey: KEY });
check('first ask completed', first.completed, `status=${first.status}`);
check('correlationId returned', !!first.correlationId);
const corr = first.correlationId;
check('first ask recorded', !!corr && eventsForCorrelation(corr).some(e => e.type === 'send.queued'));

// 2. replay with the SAME key
const second = await askAndWaitOn(driver, session, 'Say only: PONG', 90000, { idempotencyKey: KEY });
check('replay marked replayed', second.replayed === true, `replayed=${second.replayed}`);
check('replay returns same answer', second.response === first.response, `"${first.response.slice(0, 30)}"`);

// 3. event log proof: exactly one send.queued + one response.received for that correlation
const evs = eventsForCorrelation(corr);
const queued = evs.filter(e => e.type === 'send.queued').length;
const received = evs.filter(e => e.type === 'response.received').length;
const receipts = evs.filter(e => e.type === 'delivery.receipt').length;
check('exactly ONE send.queued (no duplicate send)', queued === 1, `queued=${queued}`);
check('exactly ONE response.received (no dup response event)', received === 1, `received=${received}`);
check('receipt stream present', receipts >= 1, `receipts=${receipts}`);

const pass = results.every(r => r.ok);
console.log(pass ? '\nP1 REPLAY-SAFETY SMOKE: PASS' : `\nP1 REPLAY-SAFETY SMOKE: FAIL (${results.filter(r => !r.ok).length})`);
process.exit(pass ? 0 : 1);
