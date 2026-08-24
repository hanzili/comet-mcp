#!/usr/bin/env node
// Probe perplexity mode toggle: find the ask-input mode button + dropdown options
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
  const tab = targets.find((t) => t.id === process.argv[2] || (t.type === 'page' && /perplexity\.ai/.test(t.url || '')));
  if (!tab) { console.error('no perplexity tab'); process.exit(1); }
  console.log('probing', tab.id.slice(0, 8), tab.url?.slice(0, 80));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();
  const raw = await cdp.Runtime.evaluate({
    expression: `(() => {
      const out = {};
      // any element with data-testid containing "mode" or "ask-input"
      out.modeElements = [...document.querySelectorAll('[data-testid*="mode"], [data-testid*="ask-input"]')].map(el => ({
        testid: el.getAttribute('data-testid'),
        tag: el.tagName,
        role: el.getAttribute('role'),
        text: (el.innerText || el.textContent || '').trim().slice(0, 60),
        cls: (el.className || '').toString().slice(0, 70),
      })).slice(0, 12);
      // buttons near the composer (bottom of viewport) with their text
      const btns = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
      out.bottomButtons = btns.slice(-14).map(b => ({
        text: (b.innerText || b.textContent || '').trim().slice(0, 30),
        aria: b.getAttribute('aria-label') || '',
        testid: b.getAttribute('data-testid') || '',
        cls: (b.className || '').toString().slice(0, 60),
      }));
      // body tail around "Search"/"Computer" mode chip
      const body = document.body ? (document.body.innerText || '') : '';
      const idx = body.lastIndexOf('Search');
      out.bodyTail = body.slice(-350).replace(/\\n/g, '\\\\n');
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  const rv = raw.result?.value;
  if (typeof rv === 'string') {
    const v = JSON.parse(rv);
    console.log('modeElements:', JSON.stringify(v.modeElements, null, 1));
    console.log('bottomButtons:', JSON.stringify(v.bottomButtons, null, 1));
    console.log('bodyTail:', JSON.stringify(v.bodyTail));
  } else {
    console.log('RAW:', JSON.stringify(raw.result || {}).slice(0, 400));
  }
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
