#!/usr/bin/env node
// Watcher: sample the perplexity thread + composer every 300ms while an ask runs,
// to catch WHEN the prompt gets duplicated.
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
  console.log('WATCHING', tab.id.slice(0, 8), tab.url?.slice(0, 80));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();
  const needle = process.argv[3] || 'WATCH-DOUBLE';
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const raw = await cdp.Runtime.evaluate({
      expression: `(() => {
        const body = document.body ? (document.body.innerText || '') : '';
        const comp = document.querySelector('[contenteditable="true"], textarea, .ProseMirror');
        const compLen = comp ? (comp.innerText || comp.value || '').trim().length : -1;
        // count prompt occurrences in the BODY (thread) only — strip the composer's own text
        const userMsgSel = '[data-message-author-role="user"], [data-testid*="user"]';
        const userEls = [...document.querySelectorAll(userMsgSel)];
        const inThread = userEls.filter(el => (el.innerText||'').includes(${JSON.stringify(needle)})).length;
        return JSON.stringify({ t: Date.now(), compLen, inThread, promptCount: (body.match(new RegExp(${JSON.stringify(needle)}, 'g'))||[]).length });
      })()`,
      returnByValue: true,
    });
    const v = JSON.parse(raw.result?.value || '{}');
    const dt = ((v.t - t0) / 1000).toFixed(1);
    console.log(`t=${dt}s compLen=${v.compLen} inThreadUserMsgs=${v.inThread} bodyCount=${v.promptCount}`);
    if (v.inThread >= 2) { console.log('>>> DUPLICATE DETECTED'); break; }
    await sleep(300);
  }
  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
