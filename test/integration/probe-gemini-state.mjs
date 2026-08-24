#!/usr/bin/env node
// Probe gemini tab: current DOM state — composer text, response containers, stop button
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
  const tab = targets.find((t) => t.id === process.argv[2] || (t.type === 'page' && /gemini\.google/.test(t.url || '')));
  if (!tab) { console.error('no gemini tab'); process.exit(1); }
  console.log('probing', tab.id.slice(0, 8), tab.url?.slice(0, 60));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();
  const raw = await cdp.Runtime.evaluate({
    expression: `(() => {
      const body = document.body ? (document.body.innerText || '') : '';
      // composer-ish elements
      const editors = [...document.querySelectorAll('[contenteditable], textarea, .ql-editor, [class*="input-area"]')].map(el => {
        const t = (el.innerText || el.value || '').trim();
        return { cls: (el.className || '').toString().slice(0, 60), len: t.length, head: t.slice(0, 80) };
      }).filter(x => x.len > 0).slice(0, 5);
      // response containers
      const msgs = [...document.querySelectorAll('[class*="message"], [class*="response"], .model-response-text, .markdown')].map(el => (el.innerText || '').trim()).filter(t => t.length > 2).slice(-3);
      const stopBtn = [...document.querySelectorAll('button')].filter(b => /stop|pause/i.test((b.getAttribute('aria-label') || '') + (b.title || ''))).length;
      return JSON.stringify({ bodyLen: body.length, tail: body.slice(-400), editors, msgs, stopBtn });
    })()`,
    returnByValue: true,
  });
  const rv = raw.result?.value;
  if (typeof rv === 'string') {
    const v = JSON.parse(rv);
    console.log('bodyLen:', v.bodyLen);
    console.log('tail:', JSON.stringify(v.tail));
    console.log('editors:', JSON.stringify(v.editors, null, 1));
    console.log('msgs:', JSON.stringify(v.msgs, null, 1));
    console.log('stopBtn:', v.stopBtn);
  } else {
    console.log('RAW:', JSON.stringify(raw.result || {}).slice(0, 300));
  }
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
