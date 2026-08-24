#!/usr/bin/env node
// Probe claude send button + composer state in live DOM
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
  console.log('probing', tab.id.slice(0, 8), tab.url?.slice(0, 60));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();
  const raw = await cdp.Runtime.evaluate({
    expression: `(() => {
      const out = {};
      // all buttons with aria-label / title containing send/speak/submit
      out.buttons = [...document.querySelectorAll('button')].map(b => ({
        aria: b.getAttribute('aria-label') || '',
        title: b.title || '',
        disabled: b.disabled === true,
        visible: b.offsetParent !== null,
        testid: b.getAttribute('data-testid') || '',
      })).filter(b => /send|speak|submit|enter/i.test(b.aria + b.title + b.testid)).slice(0, 10);
      // composer
      const comp = document.querySelector('[aria-label="Send message"], [contenteditable="true"], .ProseMirror');
      out.composer = comp ? {
        cls: (comp.className || '').toString().slice(0, 60),
        len: (comp.innerText || comp.textContent || '').trim().length,
        aria: comp.getAttribute('aria-label') || '',
      } : null;
      return JSON.stringify(out);
    })()`,
    returnByValue: true,
  });
  const rv = raw.result?.value;
  if (typeof rv === 'string') {
    const v = JSON.parse(rv);
    console.log('buttons:', JSON.stringify(v.buttons, null, 1));
    console.log('composer:', JSON.stringify(v.composer));
  } else {
    console.log('RAW:', JSON.stringify(raw.result || {}).slice(0, 300));
  }
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
