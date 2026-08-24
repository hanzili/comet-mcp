#!/usr/bin/env node
// Navigate the perplexity tab to the project URL, wait, then report the mode
// toggle state (proves the fresh-project default).
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await listTargets();
  const tab = targets.find((t) => t.id === process.argv[2]);
  if (!tab) { console.error('no tab'); process.exit(1); }
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();
  const url = process.argv[3] || 'https://www.perplexity.ai/projects/comet-mcp-Q4X3NfeNRXCBA4xt5k2Z5w';
  await cdp.Page.enable();
  await cdp.Page.navigate({ url });
  console.log('navigated to', url);
  await sleep(4000);
  const raw = await cdp.Runtime.evaluate({
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => /^(Search|Computer)$/.test((b.innerText || '').trim()));
      return JSON.stringify({
        url: location.href,
        modes: btns.map(b => ({ text: (b.innerText||'').trim(), pressed: b.getAttribute('aria-pressed') })),
      });
    })()`,
    returnByValue: true,
  });
  console.log(raw.result?.value);
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
