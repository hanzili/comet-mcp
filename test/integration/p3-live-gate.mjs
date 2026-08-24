// P3 live gate: Perplexity and Grok operate independently (two pooled CDP sessions).
// The pre-P3 singleton could NEVER hold two sessions — the second open() killed the first.
// Run: node test/integration/p3-live-gate.mjs
import { tabRegistry } from '../../dist/tab-registry.js';
import { sessionPool } from '../../dist/cdp-pool.js';
import { getDriver, askAndWait } from '../../dist/drivers/index.js';
import { openTab } from '../../dist/drivers/index.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// 1. Open both providers — two independent tabs, two pooled sessions
const pplx = await openTab('perplexity');
const grok = await openTab('grok');
check('perplexity tab opened', !!pplx.targetId, `tabId=${pplx.targetId.slice(0, 12)}…`);
check('grok tab opened', !!grok.targetId, `tabId=${grok.targetId.slice(0, 12)}…`);
check('distinct tabs', pplx.targetId !== grok.targetId, `${pplx.targetId} vs ${grok.targetId}`);
check('pool holds BOTH sessions concurrently', sessionPool.size >= 2, `pool=${sessionPool.size}/${sessionPool.cap} — singleton would be 1`);
check('cdpSessionId is real (per-target wsUrl)', pplx.cdpSessionId.startsWith('ws://') && grok.cdpSessionId.startsWith('ws://'), `pplx=${pplx.cdpSessionId.slice(0, 40)}…`);

// 2. Registry addressing: providerKey → tabId
check('registry resolves perplexity', tabRegistry.getProviderTab('perplexity')?.targetId === pplx.targetId);
check('registry resolves grok', tabRegistry.getProviderTab('grok')?.targetId === grok.targetId);
check('registry lists 2 tabs', tabRegistry.list().length === 2);

// 3. Health both WITHOUT prompts (no conversation pollution, ADR 0001)
const pplxHealth = await getDriver('perplexity').health(pplx);
const grokHealth = await getDriver('grok').health(grok);
check('perplexity health structured', pplxHealth.hookResolution.length > 0, `${pplxHealth.hookResolution.length} controls`);
check('grok health structured', grokHealth.hookResolution.length > 0, `${grokHealth.hookResolution.length} controls`);

// 4. Ask GROK while perplexity session stays registered — the old singleton would
// have torn down perplexity when grok asked. Ask one lightweight prompt only
// (provider-page anomaly risk, P0 finding); verify the OTHER tab survived.
const grokOutcome = await askAndWait(getDriver('grok'), 'Say only: PONG', 90000);
check('grok ask completed', grokOutcome.completed, `status=${grokOutcome.status}`);
check('grok response non-empty', grokOutcome.response.length > 0, `${grokOutcome.response.length} chars`);
const pplxStillThere = tabRegistry.getProviderTab('perplexity');
check('perplexity session survived grok ask', pplxStillThere?.state === 'connected', 'no cross-tab teardown (P3 gate)');
check('perplexity still pooled', sessionPool.get(pplxStillThere.targetId) !== null);

// 5. Scoped close: closing grok must not touch perplexity
const closeRes = await tabRegistry.close(grok.targetId);
check('grok closed (scoped)', closeRes.closed || closeRes.reset, closeRes.reset ? 'last-tab protected → reset' : 'closed');
const pplxAfter = tabRegistry.getProviderTab('perplexity');
check('perplexity unaffected by grok close', pplxAfter?.state === 'connected', 'scoped close (P3 gate)');

const pass = results.every(r => r.ok);
console.log(pass ? '\nP3 LIVE GATE: PASS' : `\nP3 LIVE GATE: FAIL (${results.filter(r => !r.ok).length} failed)`);
await tabRegistry.closeAll().catch(() => {});
process.exit(pass ? 0 : 1);
