#!/usr/bin/env node
// Deep probe: dump last ~1200 chars of bodyText + ALL prose elements + steps,
// to see where the answer, status line, and reminder turn actually rendered.
import CDP from 'chrome-remote-interface';
import http from 'http';
import fs from 'fs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\//, '');
const ROOT_PATH = ROOT.endsWith('/') ? ROOT.slice(0, -1) : ROOT;
const WANTED_TAB = process.argv[2];

async function listTargets() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222/json/list', (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

async function main() {
  const targets = await listTargets();
  const tab = WANTED_TAB
    ? targets.find((t) => t.id === WANTED_TAB)
    : targets.filter((t) => t.type === 'page' && /perplexity\.ai/.test(t.url || '')).pop();
  if (!tab) { console.error('no tab'); process.exit(1); }
  console.log('probing', tab.id.slice(0, 8), tab.url?.slice(0, 70));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();

  const src = fs.readFileSync(ROOT_PATH + '/dist/drivers/perplexity.js', 'utf8');
  const i = src.indexOf('const POLL_SCRIPT = ');
  const start = src.indexOf('`', i) + 1;
  const end = src.indexOf('`;', start);
  const script = src.slice(start, end);
  const raw = await cdp.Runtime.evaluate({ expression: script, awaitPromise: true, returnByValue: true });
  const value = JSON.parse(raw.result?.value);
  const bodyText = value.bodyText ?? '';

  console.log('bodyText len:', bodyText.length);
  console.log('--- bodyText LAST 1500 chars (\\n escaped) ---');
  console.log(JSON.stringify(bodyText.slice(-1500)));

  console.log('\n--- proseTexts (' + (value.proseTexts ?? []).length + ') ---');
  (value.proseTexts ?? []).forEach((p, i) => {
    console.log('[' + i + '] len=' + p.length + ' tail=' + JSON.stringify(p.slice(-90)));
  });
  console.log('steps:', JSON.stringify(value.steps ?? value.currentStep ?? ''));
  console.log('hasActiveStopButton:', value.hasActiveStopButton, 'hasLoadingSpinner:', value.hasLoadingSpinner);
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
