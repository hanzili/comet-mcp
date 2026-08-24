#!/usr/bin/env node
// Manually click claude's send button and observe: does the composer empty?
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
  console.log('probing', tab.id.slice(0, 8));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();

  const compLen = async (label) => {
    const raw = await cdp.Runtime.evaluate({
      expression: `(() => { const c = document.querySelector('.ProseMirror, [contenteditable="true"]'); return c ? (c.innerText || c.textContent || '').trim().length : -1; })()`,
      returnByValue: true,
    });
    console.log(label + ' composer len:', raw.result?.value);
  };

  await compLen('BEFORE');

  // 1) click the send button
  const click = await cdp.Runtime.evaluate({
    expression: `(() => {
      const b = document.querySelector('[aria-label="Send message"]');
      if (!b) return 'no-button';
      b.click();
      return 'clicked';
    })()`,
    returnByValue: true,
  });
  console.log('click result:', click.result?.value);
  await sleep(1500);
  await compLen('AFTER click (+1.5s)');

  // 2) if still there, try Enter on the composer
  await compLen('before Enter');
  await cdp.Runtime.evaluate({
    expression: `(() => {
      const c = document.querySelector('.ProseMirror, [contenteditable="true"]');
      if (!c) return 'no-composer';
      c.focus();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      c.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      return 'enter-dispatched';
    })()`,
    returnByValue: true,
  });
  await sleep(1500);
  await compLen('AFTER Enter (+1.5s)');

  // 3) real CDP Input.dispatchKeyEvent Enter (trusted)
  await cdp.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(1500);
  await compLen('AFTER trusted Enter (+1.5s)');

  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
