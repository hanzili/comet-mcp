#!/usr/bin/env node
// Precision probe: separate USER-MESSAGE elements from the COMPOSER, count prompt occurrences.
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
      const needle = 'SEARCH-MODE-FORCED';
      const out = {};
      // 1) user-role message elements specifically
      const userMsgs = [...document.querySelectorAll('[data-message-author-role="user"], [data-testid*="user"], [class*="user"]')]
        .filter(el => (el.innerText || '').includes(needle))
        .map(el => ({ cls: (el.className||'').toString().slice(0,50), text: (el.innerText||'').replace(/\\n/g,'\\\\n').slice(0, 140) }));
      out.userMessages = userMsgs;
      // 2) the composer element state
      const comp = document.querySelector('[contenteditable="true"], textarea, .ProseMirror');
      out.composerLen = comp ? (comp.innerText || comp.value || '').trim().length : -1;
      out.composerHead = comp ? (comp.innerText || comp.value || '').trim().slice(0, 80) : null;
      // 3) count occurrences of the prompt in the FULL body text
      const body = document.body ? (document.body.innerText || '') : '';
      out.bodyPromptCount = (body.match(new RegExp(needle, 'g')) || []).length;
      out.bodyTail = body.slice(-600).replace(/\\n/g, '\\\\n');
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
