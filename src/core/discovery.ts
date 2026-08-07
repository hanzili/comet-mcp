/**
 * Discovery engine — offline/on-demand provider selector miner, shipped as part of
 * comet-mcp (ported from test/integration/discover.mjs).
 *
 * Per ADR 0001 and the build plan: live UI discovery/repair is an OPT-IN operational
 * workflow, NOT a hot-path dependency. This engine is triggered on demand via
 *   - CLI:   comet-mcp discover --provider grok [--diff] [--write]
 *   - MCP:   provider_discover / provider_verify tools (src/tools/)
 *   - drift: after a provider_verify reports a missing hook
 *
 * It connects to the authenticated Comet profile, inventories the provider tab,
 * validates the real submission path with ONE varied prompt (rotation state prevents
 * repeated probe signatures), and writes the provider entry JSON that
 * src/core/registry.ts loads. Entries are data, so DOM drift is repaired by re-running
 * discovery and committing the new JSON — no code changes.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ENTRIES_DIR, writeEntry, validateEntry, packageRoot } from './registry.js';
import type { ProviderEntry, ProviderState } from '../types/provider.js';
import type { ProviderId } from '../types/conversation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = packageRoot();
const HOST = '127.0.0.1';
const PORT = parseInt(process.env.COMET_PORT || '9222', 10);
const CALL_TIMEOUT = 15000;
const DEFAULT_DEADLINE_MS = 180000;
/** Rotation state file lives next to the entries (gitignored). */
const PROMPT_STATE_FILE = join(ENTRIES_DIR, '.prompt-state.json');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- validation prompt pool ----------
// Varied per provider AND per run: repeated identical prompts to the same provider look
// like an automated injection sweep. State persists last-used index per provider and
// rotates to the NEXT prompt — no provider repeats a prompt in adjacent runs.
const PROMPT_POOL: { prompt: string; expected: string }[] = [
  { prompt: 'Say only: PONG', expected: 'PONG' },
  { prompt: 'Reply with exactly the word READY and nothing else.', expected: 'READY' },
  { prompt: 'What is 2+2? Answer with only the number.', expected: '4' },
  { prompt: 'Confirm receipt with the single word ACK.', expected: 'ACK' },
  { prompt: 'In one word, respond OK.', expected: 'OK' },
  { prompt: 'Type just the word PING.', expected: 'PING' },
  { prompt: 'Answer with only the word ALPHA.', expected: 'ALPHA' },
  { prompt: 'Say the word BRAVO and nothing else.', expected: 'BRAVO' },
];

function loadPromptState(): Record<string, number> {
  try {
    if (existsSync(PROMPT_STATE_FILE)) return JSON.parse(readFileSync(PROMPT_STATE_FILE, 'utf8'));
  } catch { /* corrupt/missing — start fresh */ }
  return {};
}
function savePromptState(state: Record<string, number>): void {
  try { writeFileSync(PROMPT_STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* non-fatal */ }
}
export function pickPrompt(provider: string): { prompt: string; expected: string } {
  const state = loadPromptState();
  const lastIdx = typeof state[provider] === 'number' ? state[provider] : -1;
  let idx: number;
  if (lastIdx === -1) {
    let h = 0;
    for (const ch of provider) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    idx = h % PROMPT_POOL.length;
  } else {
    idx = (lastIdx + 1) % PROMPT_POOL.length;
  }
  state[provider] = idx;
  savePromptState(state);
  return PROMPT_POOL[idx];
}

// ---------- per-provider configuration ----------
// Each provider: URL pattern for tab auto-detection, response-container selectors for
// extraction + fixtures, and a page-side probe returning
// { stopButtons, working, respTextLen, respTail, hasExpected } for the streaming loop.
export interface ProviderConfig {
  name: ProviderId;
  urlPattern: RegExp;
  entryUrl: string;
  responseSelectors: string[];
  probe: string; // page-side IIFE, __EXPECTED__ placeholder replaced at runtime
}

const PROVIDERS: Record<string, ProviderConfig> = {
  perplexity: {
    name: 'perplexity',
    urlPattern: /perplexity\.ai/,
    entryUrl: 'https://www.perplexity.ai/',
    responseSelectors: ['[class*="prose"]'],
    probe: `(() => {
      const body = document.body.innerText;
      const stop = [...document.querySelectorAll('button')].filter(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        return (a.includes('stop') || a.includes('cancel')) ||
               (b.querySelector('svg rect') && b.offsetParent !== null && !b.disabled);
      }).length;
      const spinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
      const working = stop > 0 || spinner || /Working|Searching|Reviewing sources|Preparing to assist|Clicking|Typing:|Navigating|Reading|Analyzing/i.test(body);
      const prose = [...document.querySelectorAll('main [class*="prose"]')]
        .filter(el => !el.closest('nav, aside, header, footer, form'));
      const texts = prose.map(el => el.innerText.trim())
        .filter(t => t.length > 0 && !['Library','Discover','Spaces','Finance','Account','Upgrade','Home','Search','Ask a follow-up'].some(ui => t.startsWith(ui)));
      const seen = new Set();
      const unique = texts.filter(t => seen.has(t) ? false : (seen.add(t), true));
      const deduped = unique.filter(t => !unique.some(u => u.length > t.length && u.includes(t)));
      const joined = deduped.join('\\n\\n');
      return { stopButtons: stop, working: working ? (spinner ? 'spinner' : 'working-text') : null,
               respTextLen: joined.length, respTail: joined.slice(-60),
               hasExpected: joined.includes("__EXPECTED__") };
    })()`,
  },
  gemini: {
    name: 'gemini',
    urlPattern: /gemini\.google/,
    entryUrl: 'https://gemini.google.com/app',
    responseSelectors: ['model-response', '[data-testid*="response"]', 'rich-text', 'user-query'],
    probe: `(() => {
      const stop = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        return a === 'stop' || a === 'stop generating' || /stop/.test(a);
      }).length;
      const working = (document.body.innerText || '').match(/Thinking|Working|Generating|Stop/i);
      const respEls = [...document.querySelectorAll('model-response, [data-testid*="response"]')];
      const last = respEls[respEls.length - 1];
      const len = last ? (last.innerText || '').trim().length : 0;
      const tail = last ? (last.innerText || '').trim() : '';
      return { stopButtons: stop, working: working ? working[0] : null,
               respTextLen: len, respTail: tail.slice(-60),
               hasExpected: tail.includes("__EXPECTED__") };
    })()`,
  },
  chatgpt: {
    name: 'chatgpt',
    urlPattern: /chatgpt\.com|chat\.openai/,
    entryUrl: 'https://chatgpt.com/',
    responseSelectors: ['[data-message-author-role="assistant"]', '[data-testid="conversation-turn"]'],
    probe: `(() => {
      const stop = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const tid = (b.getAttribute('data-testid') || '').toLowerCase();
        return a === 'stop' || a === 'stop generating' || /stop/.test(tid) || /stop/.test(a);
      }).length;
      const working = (document.body.innerText || '').match(/Thinking|Stop generating/i);
      const respEls = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const last = respEls[respEls.length - 1];
      const len = last ? (last.innerText || '').trim().length : 0;
      const tail = last ? (last.innerText || '').trim() : '';
      return { stopButtons: stop, working: working ? working[0] : null,
               respTextLen: len, respTail: tail.slice(-60),
               hasExpected: tail.includes("__EXPECTED__") };
    })()`,
  },
  claude: {
    name: 'claude',
    urlPattern: /claude\.ai/,
    entryUrl: 'https://claude.ai/',
    responseSelectors: ['div.font-claude-response', '[class*="font-claude-response"]'],
    probe: `(() => {
      const body = document.body.innerText;
      const stop = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const tid = (b.getAttribute('data-testid') || '').toLowerCase();
        return a === 'stop' || a === 'stop generating' || /stop/.test(tid) || /stop/.test(a);
      }).length;
      const finished = /Claude finished the response/i.test(body);
      const working = !finished && (body.match(/Thinking|Stop generating|is typing/i) ? true : false);
      const respEls = [...document.querySelectorAll('div.font-claude-response')];
      const last = respEls[respEls.length - 1];
      const len = last ? (last.innerText || '').trim().length : 0;
      const tail = last ? (last.innerText || '').trim() : '';
      return { stopButtons: stop, working: working ? 'working' : (finished ? null : (stop > 0 ? 'stop' : null)),
               respTextLen: len, respTail: tail.slice(-60),
               hasExpected: tail.includes("__EXPECTED__") };
    })()`,
  },
  grok: {
    name: 'grok',
    urlPattern: /grok\.com/,
    entryUrl: 'https://grok.com/',
    responseSelectors: ['[data-testid="assistant-message"]'],
    probe: `(() => {
      const stopBtns = [...document.querySelectorAll('button,[role="button"]')].filter(b => {
        const a = (b.getAttribute('aria-label') || '').toLowerCase();
        const tid = (b.getAttribute('data-testid') || '').toLowerCase();
        return a === 'stop' || a === 'stop generating' || /stop/.test(tid);
      });
      const am = [...document.querySelectorAll('[data-testid="assistant-message"]')];
      const last = am[am.length - 1];
      const bestLen = last ? (last.innerText || '').trim().length : 0;
      const tail = last ? last.innerText.trim() : '';
      const working = (document.body.innerText || '').match(/Working for \\d+s/);
      return { stopButtons: stopBtns.length,
               working: working ? working[0] : null,
               respTextLen: bestLen, respTail: tail.slice(-60),
               hasExpected: tail.includes("__EXPECTED__") };
    })()`,
  },
};

export function listProviders(): ProviderId[] {
  return Object.keys(PROVIDERS) as ProviderId[];
}

// ---------- CDP session ----------
class CDPSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  public closed = false;
  constructor(private wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener('message', ev => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => { this.closed = true; });
  }
  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise<void>((res, rej) => {
      this.ws.addEventListener('open', () => res(), { once: true });
      this.ws.addEventListener('error', () => rej(new Error('WS connect error')), { once: true });
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('WS closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, CALL_TIMEOUT);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }
  async evaluate(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception?.description || d.text || 'evaluate exception').split('\n')[0]);
    }
    return r?.result?.value;
  }
  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

// ---------- page-side inventory (generic) ----------
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
      if (el.matches('textarea, [contenteditable="true"], [role="textbox"]') || (el.getAttribute('data-testid') || '').toLowerCase().includes('input')) {
        const i = ident(el);
        const snippet = (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 40);
        out.composer.push({ tag, ...i, snippet });
      }
      if (el.matches('button, [role="button"]')) {
        const i = ident(el);
        const txt = (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
        const hasIcon = !!el.querySelector('svg');
        out.buttons.push({ tag, ...i, text: txt, hasIcon, disabled: el.disabled === true });
      }
      const cls = [...el.classList];
      const idAttrs = Object.values(ident(el)).join(' ').toLowerCase();
      if (/message|response|answer|markdown|chat-item|conversation|assistant|human|completion|prose/i.test(idAttrs + ' ' + cls.join(' '))) {
        out.responses.push({ tag, ...ident(el), childCount: el.children.length, textLen: (el.innerText || '').length });
      }
      if (el.shadowRoot) {
        out.totalShadowRoots++;
        try { walk(el.shadowRoot); } catch { out.closedShadowRoots++; }
      }
    }
  };
  walk(document);
  out.buttonsAll = out.buttons;
  out.buttons = out.buttons.filter(b => b.id || b.testid || b.aria || b.text || b.hasIcon).slice(0, 60);
  out.composer = out.composer.filter(c => c.id || c.testid || c.aria || c.placeholder || c.role).slice(0, 20);
  out.responses = out.responses.filter(r => r.textLen > 0).slice(0, 30);
  return out;
  } catch (e) { return { __error: String(e && e.stack || e) }; }
})()`;

const SNAPSHOT = (rootSel: string | null) => `(() => {
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

function bestSelector(c: any): string | null {
  const escToken = (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
  const escAttr = (s: string) => JSON.stringify(String(s));
  if (c.id) return `#${escToken(c.id)}`;
  if (c.testid) return `[data-testid=${escAttr(c.testid)}]`;
  if (c.aria) return `[aria-label=${escAttr(c.aria)}]`;
  if (c.placeholder) return `[placeholder=${escAttr(c.placeholder)}]`;
  if (c.classes?.length) return `${c.tag || 'div'}.${c.classes.map(escToken).join('.')}`;
  return null;
}

async function timedCall(session: CDPSession, method: string, params: Record<string, unknown> = {}) {
  const t0 = performance.now();
  try { return { ok: true, latencyMs: performance.now() - t0, result: await session.send(method, params) }; }
  catch (e) { return { ok: false, latencyMs: performance.now() - t0, error: (e as Error).message }; }
}

// ---------- discovery result ----------
export interface DiscoveryResult {
  provider: ProviderId;
  url: string;
  endedState: string;
  confidence: 'high' | 'medium' | 'low';
  validationPrompt: string;
  expectedToken: string;
  submitMethod: { method: string; selector?: string } | null;
  entry: ProviderEntry;
  fixtures: Record<string, string>;
  findings: string[];
  wroteEntry: boolean;
  entryPath?: string;
}

// ---------- main flow ----------
export async function runDiscovery(
  provider: ProviderId,
  opts: { write?: boolean; deadlineMs?: number; fixturesDir?: string } = {},
): Promise<DiscoveryResult> {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider} (have: ${listProviders().join(', ')})`);
  const { prompt: VALIDATION_PROMPT, expected: EXPECTED_TOKEN } = pickPrompt(provider);
  const fixturesDir = opts.fixturesDir ?? join(ROOT, 'test', 'fixtures', provider);
  const deadline = Date.now() + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const findings: string[] = [];
  const fixtures: Record<string, string> = {};

  // locate target
  const list = await fetch(`http://${HOST}:${PORT}/json/list`).then(r => r.json());
  const target = list.find((t: any) => t.type === 'page' && cfg.urlPattern.test(t.url));
  if (!target) throw new Error(`no ${provider} page target found — open the provider tab in Comet first`);

  const s = new CDPSession(target.webSocketDebuggerUrl);
  await s.open();
  await s.send('Runtime.enable');

  // 1. idle inventory
  const inv = await s.evaluate(INVENTORY);
  if (inv?.__error) throw new Error(`inventory page error: ${inv.__error}`);

  // 2. pick composer (reject mode-toggle/wrapper/indicator testids)
  const isRealComposer = (c: any) => {
    const blob = ((c.id || '') + ' ' + (c.testid || '') + ' ' + (c.aria || '')).toLowerCase();
    return !/mode-toggle|indicator|wrapper|chevron|width|slot|prefix|suffix/.test(blob);
  };
  const real = inv.composer.filter(isRealComposer);
  const composer = real.find((c: any) => c.tag === 'textarea')
    || real.find((c: any) => c.id && /input|composer|prompt|editor/i.test(c.id))
    || real.find((c: any) => c.testid && /composer|input|prompt/i.test(c.testid))
    || real.find((c: any) => c.aria && /composer|message|prompt|ask/i.test(c.aria))
    || real.find((c: any) => c.placeholder)
    || inv.composer.find((c: any) => !/mode-toggle|indicator|wrapper|chevron|width|slot|prefix|suffix/.test(((c.id || '') + ' ' + (c.testid || '') + ' ' + (c.aria || '')).toLowerCase()))
    || inv.composer[0];
  if (!composer) { s.close(); throw new Error('no composer found'); }
  const composerSel = bestSelector(composer)!;

  const focusExpr = `(() => {
    let el = document.querySelector(${JSON.stringify(composerSel)});
    if (!el) return false;
    el = el.matches('[contenteditable], textarea, input') ? el : (el.querySelector('[contenteditable], textarea, input') || el);
    el.focus();
    window.__composerEl = el;
    return true;
  })()`;

  // idle fixture (composer subtree — no conversation leak)
  try { fixtures.idle = await s.evaluate(SNAPSHOT(composerSel)); } catch { /* optional */ }

  // model picker + new chat (inspection only)
  const allButtons = inv.buttonsAll || inv.buttons;
  const modelPicker = allButtons.find((b: any) => (b.aria && /model|grok|gemini|gpt/i.test(b.aria)) || (b.text && /grok \d|gemini|gpt-\d/i.test(b.text)));
  const newChat = allButtons.find((b: any) => (b.aria && /new chat|new conversation/i.test(b.aria)) || (b.text && /^new/i.test(b.text)));

  // 3. typing
  await s.evaluate(focusExpr);
  await sleep(300);
  for (const [k, code, mod] of [['a', 'KeyA', 2], ['Delete', 'Delete', 0]]) {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers: mod });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mod });
  }
  await sleep(300);
  await s.send('Input.insertText', { text: VALIDATION_PROMPT });
  await sleep(500);
  try { fixtures.typing = await s.evaluate(SNAPSHOT(composerSel)); } catch { /* optional */ }

  // send button — now that text is present
  let sendSel: string | null = null;
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
  const hit = Array.isArray(scan) ? scan.find((b: any) => !b.disabled && (b.aria || b.testid || b.type === 'submit')) : null;
  sendSel = hit?.sel ?? null;

  // 4. submission
  let submitMethod: { method: string; selector?: string } | null = null;
  const hasText = await s.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(composerSel)});
    const v = el ? (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText) : '';
    return (v || '').includes(${JSON.stringify(EXPECTED_TOKEN)}) || (v || '').length > 0; })()`);
  if (!hasText) {
    await s.evaluate(focusExpr);
    await sleep(200);
    await s.send('Input.insertText', { text: VALIDATION_PROMPT });
    await sleep(400);
  }
  if (sendSel) {
    const clicked = await s.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sendSel)});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (clicked) submitMethod = { method: 'button-click', selector: sendSel };
  }
  if (!submitMethod) {
    await s.evaluate(focusExpr);
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    submitMethod = { method: 'enter-key' };
  }
  await sleep(1500);

  // 5. streaming -> completed observation
  const probeSrc = cfg.probe.replaceAll('__EXPECTED__', EXPECTED_TOKEN);
  const samples: any[] = [];
  let prevLen = -1, stableTicks = 0, state = 'streaming';
  let streamingShot = false;
  while (Date.now() < deadline) {
    await sleep(1000);
    const p = await s.evaluate(probeSrc);
    samples.push({ t: Math.round((Date.now() - Date.now()) / 1000), stop: p.stopButtons, working: p.working, len: p.respTextLen, tail: p.respTail, expected: p.hasExpected === true });
    if (!streamingShot && p.working && p.respTextLen > 0) {
      try {
        fixtures.streaming = await s.evaluate(`(() => {
          const els = [...document.querySelectorAll(${JSON.stringify(cfg.responseSelectors.join(', '))})];
          const el = els[els.length - 1];
          if (!el) return null;
          const c = el.cloneNode(true);
          c.querySelectorAll('script,style,svg,iframe,link').forEach(n => n.remove());
          return c.outerHTML.slice(0, 100000);
        })()`);
      } catch { /* optional */ }
      streamingShot = true;
    }
    if (p.respTextLen > prevLen) { stableTicks = 0; prevLen = p.respTextLen; }
    else if (p.respTextLen > 0) { stableTicks++; }
    if (!p.working && p.stopButtons === 0 && p.respTextLen > 0 && stableTicks >= 3) { state = 'completed'; break; }
    if (!p.working && p.stopButtons === 0 && p.hasExpected === true) { state = 'completed'; break; }
  }
  // completed fixture
  if (state === 'completed') {
    try {
      fixtures.completed = await s.evaluate(`(() => {
        const els = [...document.querySelectorAll(${JSON.stringify(cfg.responseSelectors.join(', '))})];
        const el = els[els.length - 1];
        if (!el) return null;
        const c = el.cloneNode(true);
        c.querySelectorAll('script,style,svg,iframe,link').forEach(n => n.remove());
        return c.outerHTML.slice(0, 100000);
      })()`);
    } catch { /* optional */ }
  }
  s.close();

  // 6. build + persist entry
  const confidence: DiscoveryResult['confidence'] =
    (state === 'completed' && samples[samples.length - 1]?.len > 0) ? 'high'
    : (state === 'completed') ? 'medium' : 'low';

  const controls: any = {};
  if (composer) controls.composer = { selector: composerSel, ...composer };
  if (sendSel) controls.sendButton = { selector: sendSel };
  if (modelPicker) controls.modelPicker = { selector: bestSelector(modelPicker), ...modelPicker };
  if (newChat) controls.newChat = { selector: bestSelector(newChat), ...newChat };
  if (cfg.responseSelectors.length) {
    controls.responseContainer = {
      selector: cfg.responseSelectors[0],
      ...(cfg.responseSelectors.length > 1 ? { aliases: cfg.responseSelectors.slice(1) } : {}),
      condition: 'take the LAST element for the current turn',
    };
  }

  const entry: ProviderEntry = {
    provider,
    url: cfg.entryUrl,
    version: 'Chrome/150.0.7871.230',
    discoveredAt: new Date().toISOString(),
    method: `live-CDP-inventory + ${EXPECTED_TOKEN} validation`,
    confidence,
    controls,
    responseSelectors: cfg.responseSelectors,
    heuristics: {
      composerFallback: 'any [role="textbox"] or textarea visible near the bottom of the viewport',
      sendButtonFallback: 'submit control rendered after text is typed; Enter-key fallback verified',
      responseFallback: cfg.responseSelectors.join(' OR '),
      stopDetection: 'varies by provider — see probe',
      stateMachine: {
        idle: 'no working indicator, composer empty',
        typing: 'composer has text, no working indicator',
        streaming: 'working indicator present and/or response text growing',
        completed: 'no working indicator and response text stable for 3s',
      } as Partial<Record<ProviderState, string>>,
    },
  };

  let wroteEntry = false;
  let entryPath: string | undefined;
  if (opts.write !== false) {
    entryPath = writeEntry(entry);
    wroteEntry = true;
    mkdirSync(fixturesDir, { recursive: true });
    for (const [st, html] of Object.entries(fixtures)) {
      if (html) writeFileSync(join(fixturesDir, `${st}.html`), html);
    }
  }

  return {
    provider, url: target.url, endedState: state, confidence,
    validationPrompt: VALIDATION_PROMPT, expectedToken: EXPECTED_TOKEN,
    submitMethod, entry, fixtures, findings, wroteEntry, entryPath,
  };
}

// ---------- verify (cheap selector check, NO prompt) ----------
export interface VerifyResult {
  provider: ProviderId;
  tabFound: boolean;
  checks: { name: string; selector: string; conditional: boolean; ok: boolean }[];
  healthy: boolean;
}

export async function verifyProvider(provider: ProviderId): Promise<VerifyResult> {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`unknown provider: ${provider}`);
  const entry = loadEntryFile(provider);
  const list = await fetch(`http://${HOST}:${PORT}/json/list`).then(r => r.json());
  const target = list.find((t: any) => t.type === 'page' && cfg.urlPattern.test(t.url));
  if (!target) return { provider, tabFound: false, checks: [], healthy: false };

  const s = new CDPSession(target.webSocketDebuggerUrl);
  await s.open();
  await s.send('Runtime.enable');
  const checks: VerifyResult['checks'] = [];
  if (entry) {
    for (const [name, control] of Object.entries(entry.controls) as [string, any][]) {
      if (!control?.selector) continue;
      const ok = await s.evaluate(`document.querySelector(${JSON.stringify(control.selector)}) !== null`)
        .then(v => v === true).catch(() => false);
      checks.push({ name, selector: control.selector, conditional: control.conditional === true, ok });
    }
  }
  s.close();
  const unconditional = checks.filter(c => !c.conditional);
  const healthy = unconditional.length > 0 && unconditional.every(c => c.ok);
  return { provider, tabFound: true, checks, healthy };
}

function loadEntryFile(provider: ProviderId): ProviderEntry | null {
  const path = join(ENTRIES_DIR, `${provider}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const result = validateEntry(raw);
    return result.ok ? result.entry : null;
  } catch { return null; }
}

// ---------- diff ----------
export function diffEntry(provider: ProviderId, next: ProviderEntry): { against: string | null; changes: string[] } {
  const path = join(ENTRIES_DIR, `${provider}.json`);
  if (!existsSync(path)) return { against: null, changes: ['no previous entry'] };
  const prev = JSON.parse(readFileSync(path, 'utf8')) as ProviderEntry;
  const changes: string[] = [];
  const prevControls = prev.controls || {};
  const nextControls = next.controls || {};
  for (const key of new Set([...Object.keys(prevControls), ...Object.keys(nextControls)])) {
    const a = (prevControls as Record<string, any>)[key]?.selector || null;
    const b = (nextControls as Record<string, any>)[key]?.selector || null;
    if (a !== b) changes.push(`control ${key}: "${a}" -> "${b}"`);
  }
  for (const key of ['composerFallback', 'sendButtonFallback', 'responseFallback', 'stopDetection'] as const) {
    if (prev.heuristics?.[key] !== next.heuristics?.[key]) changes.push(`heuristic ${key}: changed`);
  }
  return { against: path, changes };
}
