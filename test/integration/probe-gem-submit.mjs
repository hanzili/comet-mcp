#!/usr/bin/env node
// Manual submit on the gemini Gem tab (the driver's submit raced the fresh page).
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
  console.log('probing', tab.id.slice(0, 8), tab.url?.slice(0, 70));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();

  const compLen = async (label) => {
    const raw = await cdp.Runtime.evaluate({
      expression: `(() => { const c = document.querySelector('.ql-editor, [contenteditable="true"], textarea'); return c ? (c.innerText || c.value || '').trim().length : -1; })()`,
      returnByValue: true,
    });
    console.log(label + ' composer len:', raw.result?.value);
  };

  await compLen('BEFORE');
  // find + click the send button
  const click = await cdp.Runtime.evaluate({
    expression: `(() => {
      const btns = [...document.querySelectorAll('button')];
      const send = btns.find(b => /send|submit/i.test((b.getAttribute('aria-label')||'') + (b.title||'') + (b.getAttribute('data-testid')||'')));
      if (!send) return 'no-send-btn';
      send.click(); return 'clicked';
    })()`,
    returnByValue: true,
  });
  console.log('click:', click.result?.value);
  await sleep(2500);
  await compLen('AFTER click (+2.5s)');
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
