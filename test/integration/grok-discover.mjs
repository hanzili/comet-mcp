// P2 Grok provider discovery — offline/on-demand selector miner for grok.com.
//
// Per the build plan's "Discovery and repair workflow": connect to the authenticated
// Comet profile, inspect idle controls (composer, send button, model picker, new chat,
// response containers), test the real submission path with `Say only: PONG`, capture
// idle/typing/streaming/stopped/completed states, and emit a provider entry with
// known selectors + constrained heuristics plus sanitized DOM fixtures per state.
//
// Design:
//  - Zero dependencies (Node >= 22 native WebSocket + fetch).
//  - Inspection-only for new-chat and model-picker (no activation; preserves session).
//  - One sanctioned submission: "Say only: PONG".
//  - Pierces open shadow roots; records closed-shadow-root count as a finding.
//  - Writes: out/grok-discovery-<ts>.json (full data) and
//            ../../test/fixtures/grok/<state>.html (sanitized snapshots).
//
// Usage:
//   node test/integration/grok-discover.mjs [targetId]

import { writeFileSync, mkdirSync, readFileSync } from 'fs';

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.COMET_PORT || '9222', 10);
const CALL_TIMEOUT = 15000;
const OUT_DIR = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FIX_DIR = new URL('../../test/fixtures/grok/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TS = new Date().toISOString().replace(/[:.]/g, '-');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDPSession {
  constructor(wsUrl, label) {
    this.label = label;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }
  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('WS connect error')), { once: true });
    });
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('WS closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, CALL_TIMEOUT);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception?.description || d.text || 'evaluate exception').split('\n')[0]);
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// ---------- page-side inventory ----------
const INVENTORY = `(() => {
  try {
  const out = { url: location.href, title: document.title, composer: [], buttons: [], responses: [], closedShadowRoots: 0, totalShadowRoots: 0 };
  const ident = el => {
    const i = {};
    if (el.id) i.id = el.id;
    if (el.getAttribute('data-testid')) i.testid = el.getAttribute('data-testid');
    if (el.getAttribute('aria-label')) i.aria = el.getAttribute('aria-label');
    if (el.getAttribute('placeholder')) i.placeholder = el.getAttribute('placeholder');
    if (el.getAttribute('name')) i.name = el.getAttribute('name');
    if (el.getAttribute('role')) i.role = el.getAttribute('role');
    const cls = [...el.classList].filter(c => !/^[a-f0-9]{6,}$/.test(c)).slice(0, 4);
    if (cls.length) i.classes = cls;
    return i;
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const tag = el.tagName.toLowerCase();
      // composer candidates
      if (el.matches('textarea, [contenteditable="true"], [role="textbox"]') || (el.getAttribute('data-testid') || '').toLowerCase().includes('input')) {
        const i = ident(el);
        const snippet = (el.innerText || '').replace(/\s+/g, ' ').slice(0, 40);
        out.composer.push({ tag, ...i, snippet });
      }
      // button candidates
      if (el.matches('button, [role="button"]')) {
        const i = ident(el);
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
        const hasIcon = !!el.querySelector('svg');
        out.buttons.push({ tag, ...i, text: txt, hasIcon, disabled: el.disabled === true });
      }
  // response container candidates
  const cls = [...el.classList];
  const idAttrs = Object.values(ident(el)).join(' ').toLowerCase();
  if (/message|response|answer|markdown|chat-item|conversation|assistant|human|completion/i.test(idAttrs + ' ' + cls.join(' '))) {
    out.responses.push({ tag, ...ident(el), childCount: el.children.length, textLen: (el.innerText || '').length });
  }
      // shadow roots
      if (el.shadowRoot) {
        out.totalShadowRoots++;
        try { walk(el.shadowRoot); } catch { out.closedShadowRoots++; }
      }
    }
  };
  walk(document);
  // keep the FULL button list for control detection (model picker, new chat);
  // only the console print is capped
  out.buttonsAll = out.buttons;
  // dedupe buttons (keep those with identity)
  out.buttons = out.buttons.filter(b => b.id || b.testid || b.aria || b.text || b.hasIcon).slice(0, 60);
  out.composer = out.composer.filter(c => c.id || c.testid || c.aria || c.placeholder || c.role).slice(0, 20);
  out.responses = out.responses.filter(r => r.textLen > 0).slice(0, 30);
  return out;
  } catch (e) { return { __error: String(e && e.stack || e) }; }
})()`;;

// ---------- page-side DOM snapshot (sanitized) ----------
const SNAPSHOT = (rootSel) => `(() => {
  const clone = (root) => {
    const c = root.cloneNode(true);
    c.querySelectorAll('script,style,svg,iframe,link,noscript').forEach(n => n.remove());
    return c;
  };
  let target = document;
  if (${JSON.stringify(rootSel)}) target = document.querySelector(${JSON.stringify(rootSel)}) || document;
  const root = target.shadowRoot || target;
  return clone(root).outerHTML.slice(0, 200000);
})()`;

function bestSelector(c) {
  const escToken = s => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  const escAttr = s => JSON.stringify(String(s));
  if (c.id) return `#${escToken(c.id)}`;
  if (c.testid) return `[data-testid=${escAttr(c.testid)}]`;
  if (c.aria) return `[aria-label=${escAttr(c.aria)}]`;
  if (c.placeholder) return `[placeholder=${escAttr(c.placeholder)}]`;
  if (c.classes?.length) return `${c.tag || 'div'}.${c.classes.map(escToken).join('.')}`;
  return null;
}

async function main() {
  const report = { tool: 'grok-discover', startedAt: new Date().toISOString(), states: {}, findings: [] };

  // locate grok target
  const list = await fetch(`http://${HOST}:${PORT}/json/list`).then(r => r.json());
  const wantIdArg = process.argv.slice(2).find(a => a && !a.startsWith('--'));
  const wantId = wantIdArg || undefined;
  const target = wantId
    ? list.find(t => t.id.startsWith(wantId))
    : list.find(t => t.type === 'page' && /grok\.com/i.test(t.url));
  if (!target) { console.error('FATAL: no grok.com page target found'); process.exit(2); }
  report.targetId = target.id;
  report.url = target.url;
  console.log(`Connecting to grok target ${target.id.slice(0, 8)} (${target.url})`);

  const s = new CDPSession(target.webSocketDebuggerUrl, target.id);
  await s.open();
  await s.send('Runtime.enable');

  // ---- 1. idle inventory ----
  console.log('\n== 1. IDLE INVENTORY ==');
  const inv = await s.evaluate(INVENTORY);
  if (inv && inv.__error) { console.error('INVENTORY PAGE ERROR: ' + inv.__error); process.exit(5); }
  report.idleInventory = inv;
  console.log(`composer candidates: ${inv.composer.length}`);
  for (const c of inv.composer) console.log(`  [${c.tag}] ${bestSelector(c) || '??'} snippet="${c.snippet}"`);
  console.log(`button candidates: ${inv.buttons.length}`);
  for (const b of inv.buttons) {
    const sel = bestSelector(b);
    if (b.aria || b.testid || (b.text && b.text.length)) console.log(`  [${b.tag}] ${sel || '??'} aria="${b.aria || ''}" text="${b.text}"${b.disabled ? ' DISABLED' : ''}`);
  }
  console.log(`response candidates: ${inv.responses.length}`);
  for (const r of inv.responses.slice(0, 12)) console.log(`  [${r.tag}] ${bestSelector(r)} childCount=${r.childCount} textLen=${r.textLen}`);
  console.log(`shadow roots: ${inv.totalShadowRoots} (closed: ${inv.closedShadowRoots})`);
  if (inv.closedShadowRoots) report.findings.push('closed shadow roots present — selectors inside them are unreachable from page JS');

  // capture idle snapshot — scoped to composer subtree (no conversation leak)
  const idleRoot = null; // idle snapshot now uses composerSel below (computed after composer selection)

  // ---- 2. pick composer + send button ----
  const composer = inv.composer.find(c => c.testid && /composer|input|prompt/i.test(c.testid))
    || inv.composer.find(c => c.aria && /composer|message|prompt|ask/i.test(c.aria))
    || inv.composer.find(c => c.placeholder)
    || inv.composer[0];
  if (!composer) { console.error('FATAL: no composer found'); s.close(); process.exit(3); }
  // if the picked composer is a wrapper (e.g. aria-label div), focus its editable child
  const focusExpr = `(() => {
    let el = document.querySelector(${JSON.stringify(bestSelector(composer))});
    if (!el) return false;
    el = el.matches('[contenteditable], textarea, input') ? el : (el.querySelector('[contenteditable], textarea, input') || el);
    el.focus();
    window.__composerEl = el;
    return true;
  })()`;
  const composerSel = bestSelector(composer);
  console.log(`\n== composer: ${composerSel} (${composer.tag})`);

  // idle snapshot — scoped to composer subtree (no conversation leak)
  try {
    report.states.idle = await s.evaluate(SNAPSHOT(composerSel));
    console.log(`idle snapshot: ${report.states.idle.length} chars`);
  } catch (e) { report.findings.push(`idle snapshot failed: ${e.message}`); }

  // send button: Grok renders chat-submit only after text is typed —
  // scanned after the typing phase below (see TYPING section).
  let sendBtn = null;
  let sendSel = null;

  // model picker + new chat (inspection only — no click) — search the FULL button list
  const allButtons = inv.buttonsAll || inv.buttons;
  const modelPicker = allButtons.find(b => (b.aria && /model|grok/i.test(b.aria)) || (b.text && /grok \d/i.test(b.text)));
  const newChat = allButtons.find(b => (b.aria && /new chat|new conversation/i.test(b.aria)) || (b.text && /^new/i.test(b.text)));
  console.log(`model picker: ${modelPicker ? bestSelector(modelPicker) + ' ("' + (modelPicker.text || modelPicker.aria) + '")' : 'not found (inspection only)'}`);
  console.log(`new chat: ${newChat ? bestSelector(newChat) + ' ("' + (newChat.text || newChat.aria) + '")' : 'not found (inspection only)'}`);

  // ---- 3. typing state ----
  console.log('\n== 2. TYPING ==');
  await s.evaluate(focusExpr);
  await sleep(300);
  // clear any residual text (Ctrl+A then Delete) — protects against residue from failed runs
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete' });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete' });
  await sleep(300);
  await s.send('Input.insertText', { text: 'Say only: PONG' });
  await sleep(500);
  const typed = await s.evaluate(`(() => {
    const el = window.__composerEl || document.querySelector(${JSON.stringify(composerSel)});
    const v = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText;
    return { len: (v || '').length, preview: (v || '').slice(0, 30) };
  })()`);
  console.log(`composer after insert: len=${typed.len} "${typed.preview}"`);
  report.states.typing = await s.evaluate(SNAPSHOT(composerSel));
  report.typing = typed;

  // send button — NOW that text is present, chat-submit should be rendered
  {
    const scan = await s.evaluate(`(() => {
      const cands = [...document.querySelectorAll('button, [role="button"], [type="submit"]')].filter(b => {
        const a = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
        const tid = (b.getAttribute('data-testid') || '').toLowerCase();
        return /send|submit|arrow/.test(a + tid) || b.getAttribute('type') === 'submit';
      });
      return cands.map(b => ({
        sel: (b.id ? '#' + b.id : '') + (b.getAttribute('data-testid') ? '[data-testid="' + b.getAttribute('data-testid') + '"]' : '') +
             (b.getAttribute('aria-label') ? '[aria-label="' + b.getAttribute('aria-label') + '"]' : ''),
        aria: b.getAttribute('aria-label') || '', testid: b.getAttribute('data-testid') || '',
        text: (b.innerText || '').trim().slice(0, 30), type: b.getAttribute('type') || '',
        hasIcon: !!b.querySelector('svg'), disabled: b.disabled === true,
      })).slice(0, 12);
    })()`);
    if (Array.isArray(scan) && scan.length) {
      sendBtn = scan;
      console.log(`post-typing send candidates: ${sendBtn.length}`);
      for (const b of sendBtn) console.log(`  ${b.sel || '??'} aria="${b.aria}" testid="${b.testid}" ${b.disabled ? 'DISABLED' : ''}`);
      const hit = sendBtn.find(b => !b.disabled && (b.aria || b.testid || b.type === 'submit'));
      sendSel = hit ? hit.sel : null;
    } else {
      console.log('post-typing send candidates: none (will fall back to Enter)');
    }
    console.log(`send button: ${sendSel || '(none — will fall back to Enter)'}`);
  }

  // controls — populated AFTER the send scan so sendButton reflects the rendered state
  report.controls = {
    composer: { selector: composerSel, ...composer },
    sendButton: sendBtn && sendSel ? { selector: sendSel, ...sendBtn.find(b => b.sel === sendSel) } : null,
    modelPicker: modelPicker ? { selector: bestSelector(modelPicker), ...modelPicker } : null,
    newChat: newChat ? { selector: bestSelector(newChat), ...newChat } : null,
  };

  // ---- 4. submission ----
  console.log('\n== 3. SUBMIT (Say only: PONG) ==');
  const PONG = 'Say only: PONG';
  const submitResult = await (async () => {
    // composer still has the text? (previous phase typed it)
    const hasText = await s.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(composerSel)});
      const v = el ? (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText) : '';
      return (v || '').includes('PONG'); })()`);
    if (!hasText) {
      await s.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(composerSel)}); el.focus(); return true; })()`);
      await sleep(200);
      await s.send('Input.insertText', { text: PONG });
      await sleep(400);
    }
    if (sendSel) {
      const clicked = await s.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sendSel)});
        if (!b || b.disabled) return false; b.click(); return true; })()`);
      if (clicked) return { method: 'button-click', selector: sendSel };
    }
    // fallback: Enter key in composer
    await s.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(composerSel)}); el.focus(); return true; })()`);
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    return { method: 'enter-key' };
  })();
  console.log('submit method: ' + submitResult.method + (submitResult.selector ? ' via ' + submitResult.selector : ''));
  report.submitMethod = submitResult;
  report.submittedAt = new Date().toISOString();
  await sleep(1500);

  // ---- 5. streaming / completed observation ----
  console.log('\n== 4. STREAMING -> COMPLETED ==');
  // probe: response text from assistant-message; streaming via stop button or "Working for" indicator
  const probe = `(() => {
    const stopBtns = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const tid = (b.getAttribute('data-testid') || '').toLowerCase();
      return a === 'stop' || a === 'stop generating' || /stop/.test(tid);
    });
    const am = [...document.querySelectorAll('[data-testid="assistant-message"]')];
    const last = am[am.length - 1];
    const bestLen = last ? (last.innerText || '').trim().length : 0;
    const working = (document.body.innerText || '').match(/Working for \d+s/);    return { stopButtons: stopBtns.length,
             stopSel: stopBtns[0] ? (stopBtns[0].getAttribute('aria-label') || stopBtns[0].getAttribute('data-testid') || '').slice(0, 30) : null,
             working: working ? working[0] : null,
             respTextLen: bestLen, respTail: last ? last.innerText.trim().slice(-60) : '' };
  })()`;

  const samples = [];
  const deadline = Date.now() + 120000;
  let prevLen = -1, stableTicks = 0, state = 'streaming';
  let streamingShot = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const p = await s.evaluate(probe);
    samples.push({ t: Math.round((Date.now() - Date.parse(report.submittedAt)) / 1000), stop: p.stopButtons, working: p.working, len: p.respTextLen, tail: p.respTail });
    // capture a mid-streaming snapshot once (assistant-message while still generating)
    if (!streamingShot && p.working && p.respTextLen > 0 && p.stopButtons > 0) {
      try {
        report.states.streaming = await s.evaluate(`(() => {
          const els = [...document.querySelectorAll('[data-testid="assistant-message"]')];
          const el = els[els.length - 1];
          if (!el) return null;
          const c = el.cloneNode(true);
          c.querySelectorAll('script,style,svg,iframe,link').forEach(n => n.remove());
          return c.outerHTML.slice(0, 100000);
        })()`);
        console.log(`streaming snapshot: ${(report.states.streaming || '').length} chars`);
      } catch (e) { report.findings.push('streaming snapshot failed: ' + e.message); }
      streamingShot = true;
    }
    if (p.respTextLen > prevLen) { stableTicks = 0; prevLen = p.respTextLen; }
    else if (p.respTextLen > 0) { stableTicks++; }
    if (!p.working && p.stopButtons === 0 && p.respTextLen > 0 && stableTicks >= 3) { state = 'completed'; break; }
    if (samples.length === 1 && p.respTextLen === 0 && p.stopButtons > 0) console.log('  (streaming: stop button present, response container empty yet)');
  }
  report.streamSamples = samples;
  report.endedState = state;
  console.log(`state after observation: ${state}  samples=${samples.length}`);
  console.log('  last sample: ' + JSON.stringify(samples[samples.length - 1]));

  // capture completed snapshot — scoped to the PONG response element only (no conversation leak)
  if (state === 'completed' || state === 'stalled') {
    try {
      report.states.completed = await s.evaluate(`(() => {
        const els = [...document.querySelectorAll('[data-testid="assistant-message"]')];
        const el = els[els.length - 1];
        if (!el) return null;
        const c = el.cloneNode(true);
        c.querySelectorAll('script,style,svg,iframe,link').forEach(n => n.remove());
        return c.outerHTML.slice(0, 100000);
      })()`);
      console.log(`completed snapshot: ${(report.states.completed || '').length} chars (scoped to PONG response)`);
    } catch (e) { report.findings.push('completed snapshot failed: ' + e.message); }
  }

  // ---- 6. emit provider entry ----
  const confidence = (() => {
    const completed = report.endedState === 'completed' || (report.states.completed && (report.states.completed || '').length > 0);
    if (completed && composerSel && report.states.idle && report.states.typing) return 'high';
    if (completed && composerSel) return 'medium';
    return 'low';
  })();
  const entry = {
    provider: 'grok',
    url: 'https://grok.com/',
    version: report.browser,
    discoveredAt: new Date().toISOString(),
    method: 'live-CDP-inventory + PONG validation',
    confidence,
    controls: report.controls,
    heuristics: {
      composerFallback: 'any [role="textbox"] or textarea visible near the bottom of the viewport',
      sendButtonFallback: '[data-testid="chat-submit"] (rendered only after text is typed); Enter-key fallback works',
      responseFallback: '[data-testid="assistant-message"] (last element)',
      stopDetection: 'NONE on Fast model — verified: no stop button ever renders during generation; use the "Working for Xs" indicator instead',
      stateMachine: {
        idle: 'no working indicator, composer empty',
        typing: 'composer has text, no working indicator',
        streaming: 'body text contains "Working for Xs" (canvas-working-indicator) and/or assistant-message text growing',
        completed: 'no working indicator and assistant-message text stable for 3s',
      },
    },
  };
  report.providerEntry = entry;

  // ---- 7. persist ----
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(FIX_DIR, { recursive: true });
  const jsonPath = OUT_DIR + `grok-discovery-${TS}.json`;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  for (const [state, html] of Object.entries(report.states)) {
    if (html) writeFileSync(FIX_DIR + `${state}.html`, html);
  }
  console.log(`\nprovider entry written: ${jsonPath}`);
  console.log(`fixtures: ${FIX_DIR} (${Object.keys(report.states).join(', ')})`);
  console.log(`confidence: ${confidence}`);

  // ---- 8. diff against previous provider entry (workflow step 9) ----
  if (process.argv.includes('--diff')) {
    const fs = await import('fs');
    const older = fs.readdirSync(OUT_DIR)
      .filter(f => f.startsWith('grok-discovery-') && f.endsWith('.json') && f !== jsonPath.split(/[\\/]/).pop())
      .sort().slice(-1)[0];
    if (older) {
      const prev = JSON.parse(fs.readFileSync(OUT_DIR + older, 'utf8'));
      const cur = report.providerEntry;
      const prevC = prev.providerEntry || {};
      const diffs = [];
      for (const key of new Set([...Object.keys(prevC.controls || {}), ...Object.keys(cur.controls || {})])) {
        const a = prevC.controls?.[key]?.selector || null;
        const b = cur.controls?.[key]?.selector || null;
        if (a !== b) diffs.push(`control ${key}: "${a}" -> "${b}"`);
      }
      const ph = prevC.heuristics || {}; const ch = cur.heuristics || {};
      for (const key of new Set([...Object.keys(ph), ...Object.keys(ch)])) {
        if (JSON.stringify(ph[key]) !== JSON.stringify(ch[key])) diffs.push(`heuristic ${key}: changed`);
      }
      console.log(`\n== DIFF vs ${older} ==`);
      if (diffs.length) { console.log(diffs.join('\n')); report.diff = { against: older, changes: diffs }; }
      else { console.log('provider entry unchanged'); report.diff = { against: older, changes: [] }; }
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    } else {
      console.log('\n--diff: no prior discovery to compare');
    }
  }
  s.close();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
