#!/usr/bin/env node
/**
 * Perplexity status-line probe (2026-08-10 debugging aid).
 *
 * Evaluates the EXACT POLL_SCRIPT from dist/drivers/perplexity.js against a live
 * Perplexity tab via a fresh CDP session, then runs the driver's status-line
 * detection + sentinel strip. This is the script that WORKED in isolation:
 * it reports `completed + authoritative` with the status line + sentinel
 * captured, while the driver running through the bridge returned `idle`/empty.
 *
 * Usage:
 *   node test/integration/probe-perplexity-status.mjs [tabId]
 * (tabId optional — defaults to the most recent perplexity.ai/search tab)
 *
 * Read-only: evaluates the page, never mutates it.
 */
import CDP from 'chrome-remote-interface';
import http from 'http';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// fileURLToPath of the repo root: .../comet-mcp/ (URL pathname on Windows is
// /C:/Dev/comet-mcp — strip the leading slash for fs/require paths).
const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\//, '');
const ROOT_PATH = ROOT.endsWith('/') ? ROOT.slice(0, -1) : ROOT;

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
  const wantedTab = process.argv[2];
  const targets = await listTargets();
  const searchTabs = targets.filter(
    (t) => t.type === 'page' && /perplexity\.ai\/search/.test(t.url || ''),
  );
  const tab = wantedTab
    ? targets.find((t) => t.id === wantedTab)
    : searchTabs[searchTabs.length - 1];
  if (!tab) {
    console.error('no perplexity tab found; tabs:');
    for (const t of targets) if (t.type === 'page') console.error(' ', t.id.slice(0, 8), t.url?.slice(0, 60));
    process.exit(1);
  }
  console.log('probing tab', tab.id.slice(0, 8), tab.url?.slice(0, 60));

  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();

  // 1) Pull the EXACT POLL_SCRIPT out of the built driver.
  const src = fs.readFileSync(ROOT_PATH + '/dist/drivers/perplexity.js', 'utf8');
  const i = src.indexOf('const POLL_SCRIPT = ');
  const start = src.indexOf('`', i) + 1;
  const end = src.indexOf('`;', start);
  const script = src.slice(start, end);
  console.log('POLL_SCRIPT length:', script.length, '| CRLF:', script.includes('\r\n'));

  // 2) Evaluate it directly (what the driver does via safeEvaluate).
  const raw = await cdp.Runtime.evaluate({
    expression: script,
    awaitPromise: true,
    returnByValue: true,
  });
  const rv = raw.result?.value;
  if (typeof rv !== 'string') {
    console.log('result type:', typeof rv, '| keys:', Object.keys(raw.result || {}));
    console.log('RAW RESULT:', JSON.stringify(raw.result || {}).slice(0, 400));
    console.log('=> CDP did NOT return a value (objectId / serialization issue)');
  } else {
    const value = JSON.parse(rv);
    const bodyText = value.bodyText ?? '';
    const joinedProse = (value.proseTexts ?? []).join('\n\n').trimEnd();
    const STATUS_LINE_RE =
      /Turn \d+,\s*\d{2}\/\d{2}\/\d{2},[^\n]+(?=[\s\S]*?(?:Ask a follow-up|Sources|Search|$))/;
    const statusLineMatch = bodyText.match(STATUS_LINE_RE);
    const hasStatusLine =
      !!statusLineMatch ||
      /^Turn \d+,\s*\d{2}\/\d{2}\/\d{2},.*\d+%(?:\s*,\s*\S+)?$/m.test(joinedProse);
    console.log('bodyText len:', bodyText.length, '| prose:', (value.proseTexts || []).length);
    console.log('statusLineMatch:', statusLineMatch ? JSON.stringify(statusLineMatch[0]) : 'NULL');
    console.log('hasStatusLine => state would be:', hasStatusLine ? 'completed + authoritative' : 'idle/fallback');

    if (hasStatusLine && statusLineMatch) {
      // 3) Sentinel strip against the captured line (the model's reply ends with it).
      const { stripSentinel } = require(ROOT_PATH + '/dist/drivers/index.js');
      const line = statusLineMatch[0].trim();
      const sentinel = line.match(/(\S+)$/)?.[1] ?? '';
      const stripped = stripSentinel(line, sentinel);
      console.log('line tail:', JSON.stringify(line.slice(-40)));
      console.log('stripSentinel found:', stripped.found, '| stripped:', JSON.stringify(stripped.text.slice(-40)));
    }
  }

  await cdp.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
