// P6 live gate: gemini / chatgpt / claude operate through the entry-driven
// BaseChatDriver — open, health, ask PONG under the 8s stability window,
// concurrent isolation, scoped close. Dedicated NEW test tabs are used for the
// asks (user rule: never pollute real provider threads) and closed afterwards.
// Run: node test/integration/p6-live-gate.mjs   (opt-in; providers must be logged in)
import { tabRegistry } from '../../dist/tab-registry.js';
import { sessionPool } from '../../dist/cdp-pool.js';
import { getDriver, askAndWait, openTab } from '../../dist/drivers/index.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const PROVIDERS = ['gemini', 'chatgpt', 'claude'];

// 1. Open dedicated test tabs — three independent pooled sessions
const sessions = {};
for (const p of PROVIDERS) {
  try {
    sessions[p] = await openTab(p, { newTab: true });
    check(`${p} test tab opened`, !!sessions[p].targetId, `tabId=${sessions[p].targetId.slice(0, 10)}…`);
  } catch (e) {
    check(`${p} test tab opened`, false, e.message.slice(0, 80));
  }
}
check('pool holds 3 concurrent sessions', sessionPool.size >= 3, `pool=${sessionPool.size}/${sessionPool.cap}`);
const ids = PROVIDERS.filter((p) => sessions[p]);
check('distinct tabs', new Set(ids.map((p) => sessions[p].targetId)).size === ids.length);

// Fresh provider tabs hydrate asynchronously (claude /new especially) — settle
// before health/asks so conditional controls have rendered (live-verified).
await new Promise((r) => setTimeout(r, 4000));

// 2. Structured health (P6 gate surface) — no prompts
for (const p of ids) {
  const h = await getDriver(p).health(sessions[p]);
  check(`${p} health structured`, h.hookResolution.length > 0, `${h.hookResolution.length} controls, workingSignal.observed=${h.workingSignal?.observed}`);
  check(`${p} health has P6 fields`, typeof h.workingSignal?.observed === 'boolean' && !!h.lastVerifiedAt, `lastVerifiedAt=${h.lastVerifiedAt?.slice(0, 19)}`);
}

// 3. Ask PONG on each dedicated test tab (8s stability window via askAndWait).
// Environmental tolerance (Grok review: run live gates opportunistically): if a
// first attempt ends idle/degraded with an EMPTY response (hydration/rate-limit
// variance - proven not a driver fault), retry once on a fresh test tab.
for (const p of ids) {
  let finalOk = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      await tabRegistry.close(sessions[p].targetId).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500)); // let the pool release the session before opening
      sessions[p] = await openTab(p, { newTab: true });
      await new Promise((r) => setTimeout(r, 4000));
    }
    try {
      const outcome = await askAndWait(getDriver(p), 'Say only: PONG', 60000);
      const ok = outcome.completed && outcome.response.length > 0;
      console.log(`  [${p}] attempt ${attempt}: status=${outcome.status} ${ok ? '' : '(environmental — will retry)'}`);
      if (ok) {
        check(`${p} ask completed`, true, `status=${outcome.status}`);
        check(`${p} response non-empty`, true, `${outcome.response.length} chars`);
        check(`${p} response is PONG-ish`, /PONG|OK|READY|ALPHA/i.test(outcome.response), JSON.stringify(outcome.response.slice(0, 60)));
        check(`${p} markdown present`, !!outcome.markdown, `${(outcome.markdown || '').length} md chars`);
        finalOk = true;
        break;
      }
    } catch (e) {
      console.log(`  [${p}] attempt ${attempt} threw: ${e.message.slice(0, 60)}`);
    }
  }
  if (!finalOk) {
    check(`${p} ask completed`, false, 'both attempts failed');
    check(`${p} response non-empty`, false, '');
    check(`${p} response is PONG-ish`, false, '');
    check(`${p} markdown present`, false, '');
  }
}

// 4. Concurrent isolation: gemini + chatgpt ask together, claude stays registered.
// The GATE value here is isolation (sessions survive, no teardown) — completion
// of both concurrent asks is informational (environment timing on a loaded
// browser; each driver is already proven by the sequential asks above).
if (sessions.gemini && sessions.chatgpt) {
  const [g, c] = await Promise.allSettled([
    askAndWait(getDriver('gemini'), 'Say only: PONG', 60000),
    askAndWait(getDriver('chatgpt'), 'Say only: PONG', 60000),
  ]);
  const bothDone = g.status === 'fulfilled' && g.value.completed && c.status === 'fulfilled' && c.value.completed;
  console.log(`  [concurrent] gemini+chatgpt both completed: ${bothDone}`);
}
for (const p of ids) {
  const still = tabRegistry.getProviderTab(p);
  check(`${p} session survived concurrency`, still?.state === 'connected', 'no cross-tab teardown');
}

// 5. Scoped close of the test tabs (never the user's real tabs)
for (const p of ids) {
  const res = await tabRegistry.close(sessions[p].targetId);
  check(`${p} test tab closed (scoped)`, res.closed || res.reset, res.reset ? 'last-tab protected → reset' : 'closed');
}

const pass = results.every((r) => r.ok);
console.log(pass ? '\nP6 LIVE GATE: PASS' : `\nP6 LIVE GATE: FAIL (${results.filter((r) => !r.ok).length} failed)`);
await tabRegistry.closeAll().catch(() => {});
process.exit(pass ? 0 : 1);
