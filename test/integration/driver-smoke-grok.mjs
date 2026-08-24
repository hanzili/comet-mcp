// P2 gate smoke test: Grok driver ask -> poll with markdown extraction (live).
// Run: node test/integration/driver-smoke-grok.mjs
import { grokDriver } from '../../dist/drivers/grok.js';

const PROMPT = 'List three capital cities of Europe in a markdown bullet list.';
const EXPECTED = 'Paris';

const session = await grokDriver.open();
const { receipt } = await grokDriver.ask(session, PROMPT);
console.log('ask receipt: ' + receipt.status + (receipt.details ? ' — ' + receipt.details.slice(0, 80) : ''));

const deadline = Date.now() + 120000;
let poll;
let sawResponse = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  poll = await grokDriver.poll(session);
  if (poll.response.length > 0) sawResponse = true;
  if (poll.state === 'completed' && sawResponse) break;
}
console.log('final state: ' + poll.state);
console.log('text len: ' + poll.response.length);
console.log('text: ' + JSON.stringify(poll.response.slice(0, 250)));
console.log('markdown len: ' + (poll.markdown || '').length);
console.log('markdown: ' + JSON.stringify((poll.markdown || '').slice(0, 300)));
console.log('hasExpected(Paris): ' + poll.response.includes(EXPECTED));
console.log('hasMarkdownBullets: ' + (/^[-*] /m.test(poll.markdown || '')));
console.log('extraction: ' + JSON.stringify(poll.extraction));
const pass = poll.state === 'completed' && sawResponse && poll.response.includes(EXPECTED) && (poll.markdown || '').length > 0;
console.log(pass ? 'P2 GATE SMOKE: PASS' : 'P2 GATE SMOKE: FAIL');
process.exit(pass ? 0 : 1);
