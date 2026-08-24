/**
 * Perplexity ChatDriver (P1) — refactors CometAI behavior into the provider contract
 * without changing user-visible behavior (P1 task list item: "Refactor Perplexity
 * behavior into the provider contract without changing user-visible behavior").
 *
 * Controls resolve through the provider registry (src/providers/entries/perplexity.json)
 * with ADR 0003 fingerprint rebind, instead of the hardcoded INPUT_SELECTORS list in
 * the old CometAI. Response extraction lives in src/providers/extraction.ts (pure,
 * testable) — the in-page script only COLLECTS raw prose + signals.
 *
 * The comet_* MCP tools keep their exact external behavior; they now call this driver
 * (migration path from comet_* to provider_*, P1 item).
 */

import { tabRegistry } from '../tab-registry.js';
import { sessionPool } from '../cdp-pool.js';
import { createRequire } from 'module';
import type { TabCDPHandle } from '../cdp-pool.js';
import type { EvaluateResult } from '../types.js';
import type {
  ChatDriver, PollResult, TabSession, HealthReport, ProviderState,
} from '../types/provider.js';
import type { DeliveryReceipt } from '../types/conversation.js';
import { loadEntry, resolveWithConfidence, recordSuccess, recordFailure, writeEntry } from '../core/registry.js';
import { resolveWithRebind } from '../core/fingerprint.js';
import {
  extractResponse, extractSteps, filterProseTexts,
} from '../providers/extraction.js';
import { detectCompletion } from '../providers/completion.js';
import { htmlToMarkdown } from '../providers/markdown.js';

/** Composer selectors used by the old CometAI, kept as the heuristic fallback chain. */
const COMPOSER_FALLBACKS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

const entry = () => loadEntry('perplexity');

/** Resolve the per-tab CDP handle for a session (throws if the tab is not pooled). */
function handleFor(session: TabSession): TabCDPHandle {
  const handle = sessionPool.get(session.targetId);
  if (!handle) throw new Error(`no pooled CDP session for tab ${session.targetId} — reopen with provider_open`);
  return handle;
}

/** Wrap a pool handle's EvaluateResult into a bare value (or null). */
async function evalValue(handle: TabCDPHandle, expression: string): Promise<any> {
  try {
    const r: EvaluateResult = await handle.evaluate(expression);
    return r?.result?.value ?? null;
  } catch {
    return null;
  }
}

/** Resolve a control selector via registry confidence + fingerprint rebind. */
async function resolveControl(handle: TabCDPHandle, name: 'composer' | 'sendButton' | 'modelPicker' | 'responseContainer', conditional = false): Promise<string | null> {
  const e = entry();
  if (!e) return null;
  const { selector, control } = resolveWithConfidence(e, name);
  if (!selector) return null;

  // fingerprint rebind on miss (ADR 0003)
  const resolved = await resolveWithRebind(
    (expr) => evalValue(handle, expr),
    selector,
    control?.fingerprint,
  );

  if (resolved) {
    if (resolved.rebound) {
      const updated = recordSuccess(control!);
      updated.last_sig = resolved.selector;
      (e.controls as any)[name] = updated;
      writeEntry(e);
    }
    return resolved.selector;
  }

  // genuine miss — record failure (conditional controls skipped: they may be
  // legitimately absent until their precondition is met)
  if (!conditional && control) {
    const { control: updated } = recordFailure(control);
    (e.controls as any)[name] = updated;
    writeEntry(e);
  }
  return null;
}

/** Find a usable composer: entry selector first (with rebind), then fallback chain. */
async function findComposer(handle: TabCDPHandle): Promise<string | null> {
  const entrySel = await resolveControl(handle, 'composer');
  if (entrySel) return entrySel;
  for (const sel of COMPOSER_FALLBACKS) {
    const hit = await evalValue(handle, `document.querySelector(${JSON.stringify(sel)}) !== null`);
    if (hit === true) return sel;
  }
  return null;
}

/** Find the send button (conditional — only after text exists). */
async function findSendButton(handle: TabCDPHandle): Promise<string | null> {
  return resolveControl(handle, 'sendButton', true);
}

// ---------------------------------------------------------------------------
// In-page collection script (status signals + raw prose), NO extraction here —
// extraction happens Node-side in src/providers/extraction.ts (testable).
// ---------------------------------------------------------------------------
const POLL_SCRIPT = `(() => {
  const body = document.body.innerText;

  // stop button + spinner signals
  let hasActiveStopButton = false;
  for (const btn of document.querySelectorAll('button')) {
    const rect = btn.querySelector('rect');
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    if ((rect || ariaLabel.includes('stop')) &&
        btn.offsetParent !== null && !btn.disabled) {
      hasActiveStopButton = true;
      break;
    }
  }
  const hasLoadingSpinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;

  // collect RAW prose texts (filtering happens Node-side). 2026-08-10 FIX:
  // scope to the CURRENT TURN — the last assistant message — not the whole
  // thread. Previously ALL prose in <main> was collected and joined (capped at
  // RESPONSE_CAP=30K). Typing a new user prompt grows that join, so
  // sawNewResponse fired on the user's own prompt before the model answered,
  // and the gate finalized with the PREVIOUS turn's content (perplexity live
  // bugs 2026-08-10: prompt-3 asks completed in ~3s with the P7 hash
  // cdc52a21 / 1f8ccbe6). The status-line convention is our own anchor: each
  // assistant message ends with \"Turn N, MM/DD/YY, time, model, %\" — the
  // current turn is everything AFTER the second-to-last status line (answer
  // fragments + the trailing status line). If no/one status line exists, take
  // the whole collected set (first turn).
  const mainContent = document.querySelector('main') || document.body;
  const allProse = Array.from(mainContent.querySelectorAll('[class*="prose"]'));
  // NOTE: no TS type annotations inside injected scripts — they survive verbatim
  // into the browser and throw SyntaxError (2026-08-10: 'el: Element' broke
  // every poll → send.blocked).
  // 2026-08-10 (multi-turn scoping bug): Perplexity renders ONE prose element
  // per turn, each containing the answer + trailing status line. The current
  // turn is ALWAYS the LAST element (whether completed or still streaming).
  // Earlier status lines are just turn boundaries — ignore them entirely.
  // Previously we anchored on status-line positions with a ^-anchored regex
  // that never matched mid-text status lines, so the whole thread was
  // collected (observed: seed + Turn 2 + Turn 3 all returned as the response).
  const currentStart = allProse.length > 0 ? allProse.length - 1 : 0;
  const proseTexts = [];
  const proseHtmls = [];
  for (let i = currentStart; i < allProse.length; i++) {
    const el = allProse[i];
    if (el.closest('nav, aside, header, footer, form')) continue;
    const t = el.innerText.trim();
    if (t.length > 0) proseTexts.push(t);
    proseHtmls.push(el.innerHTML);
  }

  // 2026-08-10 (live bug): return a JSON STRING, not a raw object. Large
  // innerHTML strings can contain U+2028/2029 which break CDP's
  // returnByValue object serialization (observed: Runtime.evaluate returned
  // objectId with no value → driver saw empty bodyText → ask stuck WATCHING
  // forever with the answer on screen). JSON.stringify + parse is immune.
  return JSON.stringify({ hasActiveStopButton, hasLoadingSpinner, bodyText: body, proseTexts, proseHtmls });
})()`;

// 2026-08-10 (phantom-module fix): the module-level POLL_SCRIPT constant can be
// served stale by the ESM loader even after rebuilds (observed: loaded module
// evaluated a 2945-char object-return script while dist on disk is 3012 with
// JSON.stringify — a mix of builds in the loaded module graph). Read the script
// from DISK at poll time so the driver ALWAYS uses the current dist. Falls back
// to the module constant if the file read fails (e.g. packaged installs).
let cachedPollScript: string | null = null;
const nodeRequire = createRequire(import.meta.url);
function currentPollScript(): string {
  if (cachedPollScript) return cachedPollScript;
  try {
    const fs = nodeRequire('fs') as typeof import('fs');
    const path = nodeRequire('path') as typeof import('path');
    const here = path.dirname(nodeRequire.resolve('./perplexity.js'));
    const file = path.join(here, 'perplexity.js');
    const src = fs.readFileSync(file, 'utf8');
    const i = src.indexOf('const POLL_SCRIPT = ');
    if (i >= 0) {
      const a = src.indexOf('`', i) + 1;
      const b = src.indexOf('`;', a);
      if (b > a) {
        const script = src.slice(a, b);
        if (script.includes('JSON.stringify')) cachedPollScript = script;
      }
    }
  } catch { /* fall through to the module constant */ }
  return cachedPollScript ?? POLL_SCRIPT;
}

export class PerplexityDriver implements ChatDriver {
  readonly provider = 'perplexity' as const;

  async open(): Promise<TabSession> {
    // P3: open/reuse the provider tab through the registry (pooled per-tab session).
    return tabRegistry.open('perplexity');
  }

  async ask(session: TabSession, prompt: string): Promise<{ receipt: DeliveryReceipt }> {
    const handle = handleFor(session);
    const composer = await findComposer(handle);
    if (!composer) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
          details: 'Could not find input element. Navigate to Perplexity first.',
        },
      };
    }

    // type (contenteditable first, textarea fallback) — same as CometAI.sendPrompt
    const typed = await evalValue(handle, `(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return { success: false };
      if (el.isContentEditable || el.tagName === 'DIV') {
        const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
        editable.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${JSON.stringify(prompt)});
        // 2026-08-10 (submission bug, user report): execCommand('insertText')
        // sets the DOM but does NOT fire React's onChange — Perplexity never
        // enables the Submit button / registers the text, so Enter+click both
        // no-op and the submit fallthrough lied (send.accepted, no response).
        // Dispatch a real InputEvent so React sees the value and enables submit.
        // 2026-08-13 (double-submit, live-verified): the InputEvent MUST NOT
        // carry data — with data, Perplexity's editor ALSO inserts the text
        // itself on top of execCommand's copy, doubling the prompt in the
        // composer (empirically 2 copies). A data-less input event only
        // triggers React's onChange (value read from the DOM = 1 copy).
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        return { success: true };
      }
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.focus();
        el.value = ${JSON.stringify(prompt)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true };
      }
      return { success: false };
    })()`);
    if (typed?.success !== true) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
          details: 'Failed to type into input element',
        },
      };
    }

    // 2026-08-13 (user report): Perplexity is sneaky — a fresh session on a
    // PROJECT page defaults the composer to COMPUTER mode, not Search. The
    // completion/sentinel contract and the council legs need Search mode (the
    // model generates its status line there; Computer mode runs an agent that
    // may not). The mode is a tablist: each button carries aria-pressed, and
    // the active one is true. Ensure Search is active before submitting.
    await this.ensureSearchMode(handle);

    const submitted = await this.submit(handle, composer);
    return {
      receipt: {
        receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        status: submitted ? 'sent' : 'unknown', // uncertain delivery surfaced, never silently retried
        recordedAt: new Date().toISOString(),
        details: submitted ? `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"` : 'Submission uncertain',
      },
    };
  }

  /** Submit the current prompt — same strategy ladder as CometAI.submitPrompt. */
  private async submit(handle: TabCDPHandle, composer: string): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 500));

    // verify text landed
    const hasContent = await evalValue(handle, `(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return false;
      const v = el.isContentEditable || el.tagName === 'DIV'
        ? el.innerText : (el.value || '');
      return v.trim().length > 0;
    })()`);
    if (hasContent !== true) return false;

    // composer-emptied check (shared by all strategies). "Empty" = the prompt
    // text is gone from the composer (submitted).
    const isEmpty = async (): Promise<boolean> => {
      const v = await evalValue(handle, `(() => {
        const el = document.querySelector(${JSON.stringify(composer)});
        if (!el) return false;
        const val = el.isContentEditable || el.tagName === 'DIV' ? el.innerText : (el.value || '');
        return val.trim().length < 5;
      })()`);
      return v === true;
    };

    // Strategy 1: Enter key (most reliable for Perplexity). 2026-08-13
    // (double-submit race, user report): Perplexity clears the composer
    // ASYNCHRONOUSLY after Enter — a single 500ms check can run before the
    // clear, falsely report "not submitted", and fall through to the click
    // fallback → the prompt was submitted TWICE. POLL for emptiness over a
    // longer window before ever escalating.
    await evalValue(handle, `(() => { const el = document.querySelector(${JSON.stringify(composer)}); if (el) el.focus(); return true; })()`);
    await handle.pressKey('Enter');
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      if (await isEmpty()) return true;
      // also accept the loading indicator as evidence the submit registered
      const loading = await evalValue(handle, `document.querySelector('[class*="animate"]') !== null`);
      if (loading === true) return true;
    }

    // Strategy 2: click submit button — ONLY if the composer still holds the
    // prompt (the Enter genuinely did not submit; never re-submit after a
    // race where Enter actually worked).
    if (await isEmpty()) return true;
    const sendSel = await findSendButton(handle);
    if (sendSel) {
      const clicked = await evalValue(handle, `(() => {
        const b = document.querySelector(${JSON.stringify(sendSel)});
        if (!b || b.disabled) return false;
        b.click(); return true;
      })()`);
      if (clicked === true) {
        // poll for the composer to empty (the click really submitted)
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise((r) => setTimeout(r, 400));
          if (await isEmpty()) return true;
        }
      }
    }

    // Last resort: Enter one more time — but verify it actually submitted
    // (2026-08-10 bug: this returned true unconditionally, recording send.accepted
    // while nothing was submitted — the prompt never rendered, no response).
    await handle.pressKey('Enter');
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      if (await isEmpty()) return true;
    }
    return false;
  }

  /**
   * 2026-08-13 (user report): Perplexity is sneaky — a fresh session on a
   * PROJECT page defaults the composer to COMPUTER mode, not Search. The
   * sentinel contract (and the council legs) need Search mode: the model
   * generates its status line there; Computer mode runs an agent that may not.
   * The mode is a tablist of buttons, each with aria-pressed; the active one
   * is true. If Search is NOT active, click the Search button (the toggle is
   * visible in the composer). No-op when already in Search mode.
   */
  private async ensureSearchMode(handle: TabCDPHandle): Promise<void> {
    const active = await evalValue(handle, `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => /^(Search|Computer)$/.test((b.innerText || '').trim()));
      const search = btns.find(b => (b.innerText || '').trim() === 'Search');
      return search ? search.getAttribute('aria-pressed') : null;
    })()`);
    if (active === 'true') return; // already Search mode
    // click the Search toggle button
    const clicked = await evalValue(handle, `(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => (b.innerText || '').trim() === 'Search');
      const search = btns.find(b => b.offsetParent !== null);
      if (!search) return false;
      search.click();
      return true;
    })()`);
    if (clicked === true) {
      // let the mode switch settle before submit
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  async poll(session: TabSession): Promise<PollResult> {
    const handle = handleFor(session);

    // agent browsing URL — P3 fix: with multiple provider tabs open, the legacy
    // listTabsCategorized classification ("any non-Perplexity page = agent browsing")
    // mislabels SIBLING provider tabs (grok.com, claude.ai, ...) as the agent's
    // browsing target. Exclude tabs registered in the tab registry (they are
    // provider tabs, not the agent browsing).
    let agentBrowsingUrl = '';
    try {
      const { cometClient } = await import('../cdp-client.js');
      const tabs = await cometClient.listTabsCategorized();
      const registeredTabIds = tabRegistry.list().map((s) => s.targetId);
      if (tabs.agentBrowsing && !registeredTabIds.includes(tabs.agentBrowsing.id)) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch { /* continue without URL */ }

    const raw = await handle.safeEvaluate(currentPollScript());
    // 2026-08-10: POLL_SCRIPT returns a JSON STRING (object serialization broke
    // on U+2028/2029 in innerHTML — Runtime.evaluate returned objectId, no
    // value). Parse it here; fall back to the raw object shape defensively.
    let parsed: Record<string, unknown> | null = null;
    const rawValue = (raw as any)?.result?.value;
    if (typeof rawValue === 'string') {
      try { parsed = JSON.parse(rawValue); } catch { parsed = null; }
    } else if (rawValue && typeof rawValue === 'object') {
      parsed = rawValue as Record<string, unknown>;
    }
    const value = (parsed ?? {}) as {
      hasActiveStopButton?: boolean;
      hasLoadingSpinner?: boolean;
      bodyText?: string;
      proseTexts?: string[];
      proseHtmls?: string[];
    };

    const bodyText = value.bodyText ?? '';
    // TEMP DEBUG (2026-08-10): trace what the driver actually sees
    console.error('[poll-debug] bodyTextLen=' + bodyText.length, 'prose=' + (value.proseTexts ?? []).length, 'statusMatch=' + !!bodyText.match(/Turn \d+,\s*\d{2}\/\d{2}\/\d{2},[^\n]+(?=[\s\S]*?(?:Ask a follow-up|Sources|Search|$))/));
    // 2026-08-10 (user rule — the CODE is PRIMARY, UI markers are FALLBACK):
    // the status line is the completion contract. It renders OUTSIDE the
    // [class*="prose"] containers (observed live: bodyText ends with it while
    // prose has zero status-line elements) — so detect it in BODY TEXT, which
    // always contains it, allowing trailing UI chrome ("Sources", "Ask a
    // follow-up", "Search"...) after the line. When present ⇒ COMPLETE and
    // authoritative; the gate confirms the ask's own sentinel against it.
    // determineStatus (UI markers) is consulted ONLY as fallback when no status
    // line is present — those markers may never appear on fast answers or after
    // UI drift, and gating extraction on them hid the rendered reply (live bug
    // 2026-08-10: ask stuck WATCHING forever with the answer on screen).
    const joinedProse = (value.proseTexts ?? []).join('\n\n').trimEnd();
    // 2026-08-10 (user rule): ONE completion detector shared by ALL drivers —
    // detectCompletion() (src/providers/completion.ts). The status-line /
    // sentinel contract, working-state, fallback markers, confidence, and
    // completionVia all come from the shared, provider-parameterized detector.
    const verdict = detectCompletion({
      provider: 'perplexity',
      // the status line renders OUTSIDE prose — the detector's perplexity
      // config scopes status-line detection to bodyText
      currentTurnText: joinedProse,
      bodyText,
      hasActiveStopButton: value.hasActiveStopButton === true,
      hasLoadingSpinner: value.hasLoadingSpinner === true,
      hasWorkingSignal: true,
    });
    const status = verdict;
    const { steps, currentStep } = extractSteps(bodyText);
    const extraction = status.state === 'completed' ? extractResponse(value.proseTexts ?? []) : null;
    // 2026-08-10: the status line + sentinel render OUTSIDE [class*="prose"]
    // (bodyText only) — append it to the response so the gate's sentinel strip
    // and shape check see it; otherwise a completed reply looks lineless and
    // the marker-ask gate waits/reminds needlessly. The shared detector
    // returns the observed line (last match — the current turn's).
    let response = extraction?.response ?? '';
    const statusLineText = status.statusLine ? status.statusLine.trim() : '';
    // 2026-08-10: append UNCONDITIONALLY when detected — the status line can
    // appear mid-prose (UI-rendered) but stripSentinel requires it at the END.
    // Dropping it (or skipping when includes() matches mid-body) made a
    // completed reply look lineless → sentinel never confirmed → gate waited
    // forever (live bug 2026-08-10, the actual root cause).
    if (response && statusLineText && !response.trimEnd().endsWith(statusLineText)) {
      response = `${response}\n\n${statusLineText}`;
    }
    // P2 markdown: convert the LAST prose container's innerHTML when completed
    const markdown = status.state === 'completed' && (value.proseHtmls?.length ?? 0) > 0
      ? htmlToMarkdown('perplexity', value.proseHtmls![value.proseHtmls!.length - 1])
      : null;

    return {
      state: status.state as ProviderState,
      steps,
      currentStep,
      response,
      markdown,
      hasStopButton: value.hasActiveStopButton === true,
      agentBrowsingUrl,
      contentHash: response ? simpleHash(response) : undefined,
      // 2026-08-09 latency fix: follow-up/Finished ⇒ authoritative; steps-only ⇒ heuristic
      completionConfidence: status.completionConfidence,
      // 2026-08-10 (user rule): the driver KNOWS how it completed — sentinel
      // (status line observed) or fallback (markers/steps). The gate's bounded
      // reminder fires when a completionMarker ask completed via fallback.
      completionVia: status.completionVia,
      extraction: extraction
        ? {
            joinedProseBlocks: extraction.joinedProseBlocks,
            truncatedFromEnd: extraction.truncatedFromEnd,
            dedupedByContainment: extraction.dedupedByContainment,
          }
        : undefined,
    };
  }

  async stop(session: TabSession): Promise<boolean> {
    const handle = handleFor(session);
    const result = await handle.evaluate(`(() => {
      for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
        btn.click(); return true;
      }
      for (const btn of document.querySelectorAll('button')) {
        if (btn.querySelector('svg rect')) { btn.click(); return true; }
      }
      return false;
    })()`);
    return (result?.result?.value as boolean) ?? false;
  }

  async reset(session: TabSession): Promise<void> {
    // P3: scoped reset — only this provider's tab is navigated (tabRegistry.reset)
    await tabRegistry.reset(session.targetId);
  }

  async health(session: TabSession): Promise<HealthReport> {
    const handle = handleFor(session);
    const e = entry();
    const checks: HealthReport['hookResolution'] = [];
    let healthy = true;
    for (const name of ['composer', 'sendButton', 'modelPicker', 'responseContainer'] as const) {
      const control = e?.controls[name];
      if (!control?.selector) continue;
      const resolved = await resolveWithRebind(
        (expr) => evalValue(handle, expr),
        control.selector,
        control.fingerprint,
      );
      const ok = resolved !== null;
      checks.push({
        control: name,
        source: ok ? (resolved!.rebound ? 'known-selector' : 'known-selector') : (control.fingerprint ? 'override' : 'missing'),
      });
      if (!ok && name !== 'sendButton') healthy = false; // sendButton conditional
    }
    return {
      provider: 'perplexity',
      healthy,
      loginRequired: false,
      degraded: !healthy,
      hookResolution: checks,
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** Migration path: comet_* tools keep working; provider_* names arrive later. */
export const perplexityDriver = new PerplexityDriver();
