// Smoke test the provider dispatcher (the code provider_ask runs) against live Grok.
// Run: node test/integration/dispatcher-smoke.mjs
import { getDriver, askAndWait, renderPoll, normalizePrompt } from '../../dist/drivers/index.js';

const driver = getDriver('grok');
if (!driver) { console.log('FAIL: grok driver not registered'); process.exit(1); }
console.log('drivers: ' + Object.keys(await import('../../dist/drivers/index.js')).length + ' exports OK');

const prompt = normalizePrompt('Name two programming languages. Answer as a markdown bullet list.');
const outcome = await askAndWait(driver, prompt, 90000);
console.log('completed: ' + outcome.completed);
console.log('status: ' + outcome.status);
console.log('text: ' + JSON.stringify(outcome.response.slice(0, 200)));
console.log('markdown: ' + JSON.stringify((outcome.markdown || '').slice(0, 200)));
console.log('steps: ' + outcome.steps.length);
const pass = outcome.completed && outcome.response.length > 0 && (outcome.markdown || '').length > 0;
console.log(pass ? 'DISPATCHER SMOKE: PASS' : 'DISPATCHER SMOKE: FAIL');
process.exit(pass ? 0 : 1);
