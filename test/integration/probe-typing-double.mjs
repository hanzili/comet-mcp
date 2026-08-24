#!/usr/bin/env node
// Empirical test: which typing combination yields exactly ONE copy of the prompt?
// (a) execCommand insertText + InputEvent(data)
// (b) InputEvent(data) only
// (c) execCommand insertText + InputEvent(data:null)  [trigger onChange, no re-insert]
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

  const test = async (label, expr) => {
    // clear composer first
    await cdp.Runtime.evaluate({
      expression: `(() => {
        const c = document.querySelector('[contenteditable="true"], .ProseMirror');
        if (!c) return;
        c.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      })()`,
      returnByValue: true,
    });
    await sleep(400);
    const ins = await cdp.Runtime.evaluate({ expression: expr, returnByValue: true });
    await sleep(600);
    const rd = await cdp.Runtime.evaluate({
      expression: `(() => { const c = document.querySelector('[contenteditable="true"], .ProseMirror'); return c ? (c.innerText || c.textContent || '') : ''; })()`,
      returnByValue: true,
    });
    const txt = rd.result?.value || '';
    const count = (txt.match(/PROMPT-TEST-XYZ/g) || []).length;
    console.log(label + ': insert=' + JSON.stringify(ins.result?.value) + ' → copies=' + count + ' len=' + txt.length + ' text=' + JSON.stringify(txt.slice(0, 90)));
    // clear again
    await cdp.Runtime.evaluate({
      expression: `(() => {
        const c = document.querySelector('[contenteditable="true"], .ProseMirror');
        if (!c) return;
        c.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
      })()`,
      returnByValue: true,
    });
    await sleep(400);
  };

  await test('(a) exec+InputEvent(data)', `(() => {
    const c = document.querySelector('[contenteditable="true"], .ProseMirror');
    if (!c) return 'no-composer';
    const e = c.matches('[contenteditable]') ? c : (c.querySelector('[contenteditable]') || c);
    e.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, 'PROMPT-TEST-XYZ');
    e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'PROMPT-TEST-XYZ' }));
    return 'done';
  })()`);

  await test('(b) InputEvent(data) only', `(() => {
    const c = document.querySelector('[contenteditable="true"], .ProseMirror');
    if (!c) return 'no-composer';
    const e = c.matches('[contenteditable]') ? c : (c.querySelector('[contenteditable]') || c);
    e.focus();
    e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'PROMPT-TEST-XYZ' }));
    return 'done';
  })()`);

  await test('(c) exec+InputEvent(data:null)', `(() => {
    const c = document.querySelector('[contenteditable="true"], .ProseMirror');
    if (!c) return 'no-composer';
    const e = c.matches('[contenteditable]') ? c : (c.querySelector('[contenteditable]') || c);
    e.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, 'PROMPT-TEST-XYZ');
    e.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return 'done';
  })()`);

  await test('(d) exec only', `(() => {
    const c = document.querySelector('[contenteditable="true"], .ProseMirror');
    if (!c) return 'no-composer';
    const e = c.matches('[contenteditable]') ? c : (c.querySelector('[contenteditable]') || c);
    e.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, 'PROMPT-TEST-XYZ');
    return 'done';
  })()`);

  await cdp.close();
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
