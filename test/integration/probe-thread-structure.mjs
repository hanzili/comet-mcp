#!/usr/bin/env node
// Extract user + assistant message elements SEPARATELY to see the thread structure
// and whether the prompt is doubled in a single user message or two messages.
import CDP from 'chrome-remote-interface';
import http from 'http';

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
  const tab = targets.find((t) => t.id === process.argv[2]);
  if (!tab) { console.error('no tab'); process.exit(1); }
  console.log('probing', tab.id.slice(0, 8), tab.url?.slice(0, 90));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();
  const raw = await cdp.Runtime.evaluate({
    expression: `(() => {
      const out = {};
      const log = (label, els) => {
        out[label] = els.map((el, i) => {
          const t = (el.innerText || el.textContent || '').replace(/\\n/g,'\\\\n');
          return { i, cls: (el.className||'').toString().slice(0,40), text: t.slice(0, 200) };
        });
      };
      // candidate containers in main
      const main = document.querySelector('main') || document.body;
      // look for elements that contain the prompt text
      const prompt = 'SEARCH-MODE-FORCED';
      const holders = [...main.querySelectorAll('*')].filter(el => {
        const t = (el.innerText || '');
        return t.includes(prompt) && t.length < 400;
      }).slice(0, 10);
      log('holders', holders);
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  const rv = raw.result?.value;
  if (typeof rv === 'string') console.log(JSON.stringify(JSON.parse(rv), null, 1));
  else console.log('RAW:', JSON.stringify(raw.result || {}).slice(0, 400));
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
