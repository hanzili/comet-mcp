/**
 * Standalone perplexity completion test (2026-08-10).
 * Drives the REAL dist driver + dispatchAsk/advanceAsk against the live browser
 * via a direct CDP session — NO pi gateway in the path. The COMET_STRICT_COMPLETION_GATE
 * env var is read at module load, so this tests both gate modes.
 *
 * Each run opens a FRESH perplexity thread (navigates away from any prior chat) so
 * no previous answer pollutes the poll. Verifies the prompt actually landed in the
 * thread before polling.
 *
 * Usage: COMET_STRICT_COMPLETION_GATE=0 node test/integration/standalone-perplexity-test.mjs
 *        COMET_STRICT_COMPLETION_GATE=1 node test/integration/standalone-perplexity-test.mjs
 */
import CDP from 'chrome-remote-interface';
import http from 'http';
import fs from 'fs';

const ROOT_URL = new URL('../..', import.meta.url); // file:///C:/Dev/comet-mcp/

async function listTargets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222/json/list', (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

// Attach to a perplexity page target and get onto a real SEARCH thread.
// The home-page composer submits unreliably (prompt lands, send.accepted fires,
// but no response — observed 2026-08-10). Seed a benign query first so the tab
// lands on /search/... where ask() reliably generates.
async function openFreshPerplexity() {
  const targets = await listTargets();
  const existing = targets.find((t) => t.type === 'page' && /perplexity\.ai/.test(t.url || ''));
  const cdp = await CDP({ target: existing ? existing.id : undefined });
  await cdp.Page.enable();
  await cdp.Runtime.enable();
  const targetId = existing ? existing.id : (cdp.target?._targetId ?? 'unknown');
  // navigate home, then seed a thread via the composer
  await cdp.Page.navigate({ url: 'https://www.perplexity.ai/' });
  await new Promise((resolve) => setTimeout(resolve, 7000));
  // type a benign seed into #ask-input, then CLICK the real Submit button
  // (the driver's submit ladder uses click+verify, not bare Enter — the home
  // composer ignores Enter, observed 2026-08-10 user correction)
  await cdp.Runtime.evaluate({
    expression: `(() => { const el = document.querySelector('#ask-input'); if (!el) return false; el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, 'hello'); return true; })()`,
    returnByValue: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await cdp.Runtime.evaluate({
    expression: `(() => { const b = document.querySelector('[aria-label="Submit"]'); if (!b) return false; b.click(); return true; })()`,
    returnByValue: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 7000));
  const sanity = await cdp.Runtime.evaluate({ expression: 'JSON.stringify({ url: location.href, bodyLen: document.body.innerText.length, hasProse: !!document.querySelector("[class*=prose]") })', returnByValue: true });
  console.log('seeded tab:', targetId.slice(0, 8), '| sanity:', sanity.result?.value);
  return { cdp, targetId };
}

async function main() {
  const strict = process.env.COMET_STRICT_COMPLETION_GATE === '1';
  console.log('=== STRICT GATE:', strict ? 'ON (poll.state must be completed)' : 'OFF (content-driven) ===');

  const driverMod = await import(ROOT_URL + 'dist/drivers/perplexity.js');
  const PerplexityDriver = driverMod.PerplexityDriver;
  const drivers = await import(ROOT_URL + 'dist/drivers/index.js');
  const { sessionPool } = await import(ROOT_URL + 'dist/cdp-pool.js');
  const { tabRegistry } = await import(ROOT_URL + 'dist/tab-registry.js');

  const { cdp, targetId } = await openFreshPerplexity();

  // Shim the pool so handleFor(session) resolves to our CDP session
  const handle = {
    async evaluate(expression) {
      const r = await cdp.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      return { result: { value: r.result ? r.result.value : undefined, type: 'object' } };
    },
    async safeEvaluate(expression) { return this.evaluate(expression); },
    async isHealthy() { return true; },
    async navigate() { return { ok: true }; },
    async pressKey() {},
    async screenshot() { return { data: '' }; },
  };
  sessionPool.get = () => handle;
  tabRegistry.list = () => [];

  const driver = new PerplexityDriver();
  const session = {
    provider: 'perplexity', tabId: targetId, targetId,
    cdpSessionId: 'ws://x', openedAt: new Date().toISOString(), state: 'connected',
  };

  const prompt = 'Reply with the single word CONFIRMED, then end with a status line in this exact format: Turn <N>, <MM/DD/YY>, <time> <timezone>, <model>, <context%>, then the code <SENTINEL>.';
  const dispatched = await drivers.dispatchAsk(driver, session, prompt, { timeoutMs: 60000, completionMarker: true });
  console.log('dispatched:', dispatched.status);

  // VERIFY SUBMISSION: wait a moment, then check the thread actually has the prompt text
  await new Promise((r) => setTimeout(r, 4000));
  const check = await cdp.Runtime.evaluate({
    expression: 'JSON.stringify({ bodyLen: document.body.innerText.length, hasPrompt: document.body.innerText.includes("CONFIRMED, then end with a status line") })',
    returnByValue: true,
  });
  console.log('submission check:', check.result?.value);

  // Advance until completed or 40 polls
  let outcome = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    outcome = await drivers.advanceAsk(dispatched.idempotencyKey);
    const status = outcome?.status ?? 'null';
    console.log(`poll ${i + 1}: status=${status} completed=${outcome?.completed ?? false}`);
    if (outcome?.completed) break;
  }

  if (outcome?.completed) {
    console.log('\nCOMPLETED: response tail =', JSON.stringify(outcome.response.slice(-120)));
    console.log('RESULT: PASS');
  } else {
    console.log('\nRESULT: STUCK (no completion after 40 polls)');
  }
  await cdp.close();
  process.exit(outcome?.completed ? 0 : 1);
}

main().catch((e) => { console.error('ERR', e); process.exit(2); });
