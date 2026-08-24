#!/usr/bin/env node
// Probe perplexity mode toggle STATE: which of Search/Computer is active?
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
  console.log('probing', tab.id.slice(0, 8), tab.url?.slice(0, 80));
  const cdp = await CDP({ target: tab.id });
  await cdp.Runtime.enable();
  const raw = await cdp.Runtime.evaluate({
    expression: `(() => {
      const out = {};
      // the two mode buttons: Search + Computer (text match, near composer)
      out.modeButtons = [...document.querySelectorAll('button')]
        .filter(b => /^(Search|Computer|Focus)$/.test((b.innerText||'').trim()))
        .map(b => ({
          text: (b.innerText||'').trim(),
          ariaPressed: b.getAttribute('aria-pressed'),
          ariaSelected: b.getAttribute('aria-selected'),
          ariaChecked: b.getAttribute('aria-checked'),
          cls: (b.className||'').toString().slice(0, 90),
          parentCls: (b.parentElement?.className||'').toString().slice(0, 60),
        }));
      // the sliding indicator pill position (which mode it covers)
      const ind = document.querySelector('[data-testid="ask-input-mode-toggle-indicator"]');
      if (ind) {
        const r = ind.getBoundingClientRect();
        out.indicator = { x: Math.round(r.x), width: Math.round(r.width) };
      }
      // the two width wrappers' positions (to compare against the indicator)
      out.wrappers = [...document.querySelectorAll('[data-testid="ask-input-mode-toggle-width-wrapper"]')].map(w => {
        const r = w.getBoundingClientRect();
        return { text: (w.innerText||'').trim(), x: Math.round(r.x), width: Math.round(r.width) };
      });
      // is there a container that knows the active mode? check aria on the group
      const group = document.querySelector('[role="radiogroup"], [role="tablist"]');
      out.group = group ? { role: group.getAttribute('role'), testid: group.getAttribute('data-testid') } : null;
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
