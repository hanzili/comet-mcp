// P1 gate smoke test: driver ask -> poll path (same code as comet_ask/comet_poll).
// Uses a REAL-LENGTH prompt (the extraction filter requires prose > 5 chars, matching
// the verified original behavior — short tokens like "OK"/"PONG" are intentionally
// filtered as UI noise). Run:
//   node test/integration/driver-smoke.mjs
import { perplexityDriver } from '../../dist/drivers/perplexity.js';

const PROMPT = 'What is the capital of France? Answer in one short sentence.';
const EXPECTED = 'Paris';

const session = await perplexityDriver.open();
const { receipt } = await perplexityDriver.ask(session, PROMPT);
console.log('ask receipt: ' + receipt.status + (receipt.details ? ' — ' + receipt.details.slice(0, 80) : ''));

const deadline = Date.now() + 120000;
let poll;
let sawResponse = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  poll = await perplexityDriver.poll(session);
  if (poll.response.length > 0) sawResponse = true;
  if (poll.state === 'completed' && sawResponse) break;
}
console.log('final state: ' + poll.state);
console.log('response len: ' + poll.response.length);
console.log('response: ' + JSON.stringify(poll.response.slice(0, 300)));
console.log('hasExpected("Paris"): ' + poll.response.includes(EXPECTED));
console.log('extraction flags: ' + JSON.stringify(poll.extraction));
console.log('contentHash: ' + poll.contentHash);
const pass = poll.state === 'completed' && sawResponse && poll.response.includes(EXPECTED);
console.log(pass ? 'P1 GATE SMOKE: PASS' : 'P1 GATE SMOKE: FAIL');
process.exit(pass ? 0 : 1);
