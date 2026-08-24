#!/usr/bin/env node
// Probe T6: where does the trailing "T" after the status line come from?
// Evaluates the EXACT POLL_SCRIPT from dist against the live tab, then dissects
// bodyText + prose structure around the status line.
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
  if (!tab) {
    console.error('no tab found; pages:');
    for (const t of targets) if (t.type === 'page') console.error(' ', t.id.slice(0, 8), t.url?.slice(0, 70));
    process.exit(1);
  }
  console.log('probing tab', tab.id.slice(0, 8), tab.url?.slice(0, 70));

  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();

  const src = fs.readFileSync(ROOT_PATH + '/dist/drivers/perplexity.js', 'utf8');
  const i = src.indexOf('const POLL_SCRIPT = ');
  const start = src.indexOf('`', i) + 1;
  const end = src.indexOf('`;', start);
  const script = src.slice(start, end);
  console.log('POLL_SCRIPT length:', script.length);

  const raw = await cdp.Runtime.evaluate({ expression: script, awaitPromise: true, returnByValue: true });
  const rv = raw.result?.value;
  if (typeof rv !== 'string') {
    console.log('RAW:', JSON.stringify(raw.result || {}).slice(0, 300));
    process.exit(1);
  }
  const value = JSON.parse(rv);
  const bodyText = value.bodyText ?? '';

  // Dissect bodyText: find ALL status lines, then show what follows the LAST one
  const STATUS_LINE_RE = /Turn \d+,\s*\d{2}\/\d{2}\/\d{2},[^\n]+(?=[\s\S]*?(?:Ask a follow-up|Sources|Search|$))/g;
  const matches = bodyText.match(STATUS_LINE_RE) ?? [];
  console.log('\n=== status lines found:', matches.length, '===');
  matches.forEach((m, i) => console.log(`  [${i}] len=${m.length} tail=${JSON.stringify(m.slice(-45))}`));

  if (matches.length) {
    const last = matches[matches.length - 1];
    const idx = bodyText.lastIndexOf(last);
    const after = bodyText.slice(idx + last.length, idx + last.length + 100);
    console.log('\n=== what follows LAST status line (100 chars, \\n escaped) ===');
    console.log(JSON.stringify(after));
    // character-by-character around the boundary
    const around = bodyText.slice(idx + last.length - 10, idx + last.length + 20);
    console.log('=== boundary ±10 chars ===');
    console.log(JSON.stringify(around));
  }

  console.log('\n=== prose structure ===');
  console.log('proseTexts count:', (value.proseTexts ?? []).length);
  const proseTexts = value.proseTexts ?? [];
  if (proseTexts.length) {
    const lastP = proseTexts[proseTexts.length - 1];
    console.log('last prose len:', lastP.length, 'tail:', JSON.stringify(lastP.slice(-100)));
    console.log('second-to-last prose tail:', JSON.stringify(proseTexts[proseTexts.length - 2]?.slice(-60)));
  }

  console.log('\n=== old-format residue ===');
  console.log('"then the code" count in bodyText:', (bodyText.match(/then the code/g) ?? []).length);
  console.log('bodyText total len:', bodyText.length);

  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
