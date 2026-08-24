/**
 * BaseChatDriver (P6, docs/design/03-p6-drivers-design.md §4) — entry-driven
 * shared driver core for the P6 adapters (gemini, chatgpt, claude) and the future
 * typed-adapter core.
 *
 * Composition over copy-paste (Grok consultation + design review): every provider
 * difference is expressed in the entry's `driver` section (merged from
 * src/providers/entries/<p>.driver.json at load — registry.ts), and this class is
 * a thin interpreter of ProviderEntry.driver + shared CDP machinery.
 *
 * Design-review constraints honored here (responses/grok-p6-design-review-2026-08-08.md):
 *  - the base stays free of provider-specific prose — residual quirks live in an
 *    override hook or in the entry, and are the signal that the schema needs
 *    extension;
 *  - stability window / session anchors / poll backoff stay in src/drivers/index.ts
 *    (completionStability, updateSessionAnchors) — NOT re-implemented here;
 *  - DOM nodes are never cached — every poll re-resolves;
 *  - completed NEVER returns an empty response — a missing/empty response
 *    container at completion detection degrades instead (P6 gate).
 */

import { tabRegistry } from '../tab-registry.js';
import { sessionPool } from '../cdp-pool.js';
import type { TabCDPHandle } from '../cdp-pool.js';
import type { EvaluateResult } from '../types.js';
import type {
  ChatDriver, PollResult, TabSession, HealthReport, ProviderState, ProviderEntry,
  ProviderControlName, ProviderDriver,
} from '../types/provider.js';
import type { DeliveryReceipt, ProviderId } from '../types/conversation.js';
import { loadEntry, resolveWithConfidence, recordSuccess, recordFailure, writeEntry } from '../core/registry.js';
import { resolveWithRebind } from '../core/fingerprint.js';
import { extractAssistantTurn, ASSISTANT_TURN_STRIPS } from '../providers/extraction.js';
import { detectCompletion } from '../providers/completion.js';
import { htmlToMarkdown } from '../providers/markdown.js';

/** FNV-1a 32-bit content hash (same as the P1/P2 drivers' local copies). */
function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

/** Composer heuristic fallback chain (same ladder as the P1/P2 drivers). */
const COMPOSER_FALLBACKS = [
  '[contenteditable="true"]',
  '[role="textbox"]',
  'textarea[placeholder*="Ask"]',
  'textarea',
  'input[type="text"]',
];

/** Generation-failure body-text patterns → degraded (never silent-empty, P6 gate). */
const ERROR_PATTERNS = [
  'something went wrong',
  'an error occurred',
  'failed to generate',
  'unable to generate',
  'could not generate',
];

/** Generic stop-control scan (same signal the P1/P2 drivers use). */
const STOP_SCAN = `(() => {
  for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"], button[title*="Stop"]')) {
    if (btn.offsetParent !== null && !btn.disabled) return true;
  }
  for (const btn of document.querySelectorAll('button')) {
    if (btn.querySelector('svg rect') && btn.offsetParent !== null && !btn.disabled) return true;
  }
  return false;
})()`;

const blockedReceipt = (details: string): { receipt: DeliveryReceipt } => ({
  receipt: {
    receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
    details,
  },
});

/**
 * Entry-driven base driver. Subclasses declare `provider` and MAY override narrow
 * hooks (onBeforeSubmit, onPoll, onReset, resolveResponseSelector) — the entry
 * stays the primary source of behavior.
 */
export abstract class BaseChatDriver implements ChatDriver {
  abstract readonly provider: ProviderId;
  /** preClean variant for markdown (defaults to driver.markdown ?? provider). */
  protected markdownVariant(): string {
    return this.driverSection()?.markdown ?? this.provider;
  }

  // -------------------------------------------------------------------------
  // shared helpers (entry-parameterized versions of the P1/P2 driver internals)
  // -------------------------------------------------------------------------

  protected entry(): ProviderEntry | null {
    return loadEntry(this.provider);
  }

  protected driverSection(): ProviderDriver | null {
    return this.entry()?.driver ?? null;
  }

  /** Resolve the per-tab CDP handle for a session (throws if the tab is not pooled). */
  protected handleFor(session: TabSession): TabCDPHandle {
    const handle = sessionPool.get(session.targetId);
    if (!handle) throw new Error(`no pooled CDP session for tab ${session.targetId} — reopen with provider_open`);
    return handle;
  }

  /** Wrap a pool handle's EvaluateResult into a bare value (or null). */
  protected async evalValue(handle: TabCDPHandle, expression: string): Promise<any> {
    try {
      const r: EvaluateResult = await handle.evaluate(expression);
      return r?.result?.value ?? null;
    } catch {
      return null;
    }
  }

  /** Resolve a control selector via registry confidence + fingerprint rebind. */
  protected async resolveControl(
    handle: TabCDPHandle,
    name: ProviderControlName,
    conditional = false,
  ): Promise<string | null> {
    const e = this.entry();
    if (!e) return null;
    const { selector, control } = resolveWithConfidence(e, name);
    if (!selector) return null;

    const resolved = await resolveWithRebind(
      (expr) => this.evalValue(handle, expr),
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

  /** Find a usable composer: entry selector first (with rebind), then fallbacks. */
  protected async findComposer(handle: TabCDPHandle): Promise<string | null> {
    const entrySel = await this.resolveControl(handle, 'composer');
    if (entrySel) return entrySel;
    for (const sel of COMPOSER_FALLBACKS) {
      const hit = await this.evalValue(handle, `document.querySelector(${JSON.stringify(sel)}) !== null`);
      if (hit === true) return sel;
    }
    return null;
  }

  /** Resolve the response-container selector (conditional — absent pre-first-answer).
   * Tries the entry control first (with rebind), then EACH entry responseSelector
   * against the live DOM — the loosest alias wins (claude's captured DOM only
   * matches `[class*="font-claude-response"]`, not the primary div selector). */
  protected async resolveResponseSelector(handle: TabCDPHandle): Promise<string | null> {
    const entrySel = await this.resolveControl(handle, 'responseContainer', true);
    if (entrySel) return entrySel;
    for (const sel of this.entry()?.responseSelectors ?? []) {
      const hit = await this.evalValue(handle, `document.querySelector(${JSON.stringify(sel)}) !== null`);
      if (hit === true) return sel;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // ChatDriver contract
  // -------------------------------------------------------------------------

  async open(): Promise<TabSession> {
    // P3: open/reuse the provider tab through the registry (pooled per-tab session).
    return tabRegistry.open(this.provider);
  }

  async ask(session: TabSession, prompt: string): Promise<{ receipt: DeliveryReceipt }> {
    const handle = this.handleFor(session);
    const driver = this.driverSection();
    const composer = await this.findComposer(handle);
    if (!composer) {
      return blockedReceipt(`Could not find input element for ${this.provider}. Navigate to the provider first.`);
    }

    const typed = await this.typeInto(handle, composer, driver?.typing ?? 'insertText', prompt);
    if (!typed) {
      return blockedReceipt(`Failed to type into the ${this.provider} composer`);
    }
    // 2026-08-10 (user report, perplexity fresh-tab): verify the prompt text
    // actually LANDED in the composer before submitting. composer-emptied as
    // the ONLY verification false-positives when the composer was ALREADY empty
    // (fresh tab, typeInto hit the wrong/not-ready element) — the ask then
    // claims 'sent' while nothing ever rendered, and the ADR 0011 reminder
    // injects technical prompts into a thread that never got the real question.
    const landed = await this.promptLandedIn(handle, composer, prompt);
    if (!landed) {
      return blockedReceipt(`Prompt text not detected in the ${this.provider} composer — NOT submitting (fresh-tab false-positive guard)`);
    }

    const submitted = await this.submitLadder(handle, composer, driver);
    return {
      receipt: {
        receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        status: submitted ? 'sent' : 'unknown', // uncertain delivery surfaced, never silently retried
        recordedAt: new Date().toISOString(),
        details: submitted
          ? `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`
          : 'Submission uncertain',
      },
    };
  }

  /**
   * 2026-08-10: confirm the typed prompt is actually present in the composer
   * element. Guards the fresh-tab false-positive where typeInto reports success
   * but the text never rendered (composer not ready / wrong element).
   */
  protected async promptLandedIn(handle: TabCDPHandle, composer: string, prompt: string): Promise<boolean> {
    const sample = prompt.slice(0, 30).replace(/[`\\$]/g, '');
    const v = await this.evalValue(handle, `(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return false;
      const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
      const val = (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT')
        ? (editable.value || '') : (editable.innerText || '');
      return val.includes(${JSON.stringify(sample)});
    })()`);
    return v === true;
  }

  /** Type into the composer per driver.typing mode. */
  protected async typeInto(
    handle: TabCDPHandle,
    composer: string,
    mode: ProviderDriver['typing'],
    prompt: string,
  ): Promise<boolean> {
    if (mode === 'value-input') {
      const r = await this.evalValue(handle, `(() => {
        const el = document.querySelector(${JSON.stringify(composer)});
        if (!el) return { success: false };
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          el.focus();
          el.value = ${JSON.stringify(prompt)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
        return { success: false };
      })()`);
      return r?.success === true;
    }

    // insertText (contenteditable/Quill/ProseMirror) — plus the mandatory real
    // InputEvent: execCommand('insertText') sets the DOM but does NOT fire the
    // app's change detection (React/Angular/Quill), so the send button stays
    // disabled and the prompt never submits. The perplexity submission fix
    // (0cc93db, 2026-08-10) dispatched a real InputEvent unconditionally —
    // propagated here so EVERY entry-driven driver (gemini/chatgpt/claude)
    // follows the SAME proven pattern (user rule: one pattern, all drivers).
    // 2026-08-13 (perplexity live-verified): the InputEvent MUST NOT carry
    // `data` — with data the editor ALSO inserts the text on top of
    // execCommand's copy, doubling the prompt. Data-less input event only
    // triggers change detection (value read from the DOM = 1 copy).
    const r = await this.evalValue(handle, `(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return { success: false };
      const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
      editable.focus();
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return { success: ok !== false };
    })()`);
    return r?.success === true;
  }

  /**
   * Entry-driven submit ladder (driver.submit): click | enter | click-after-type,
   * with the mandatory verification step before claiming `sent` (Grok review).
   * Claude's contract (enterSends: false): button appears only after typing;
   * Enter alone must NEVER be used.
   */
  protected async submitLadder(
    handle: TabCDPHandle,
    composer: string,
    driver: ProviderDriver | null,
  ): Promise<boolean> {
    if (!driver?.submit) return false;
    const method = driver.submit.method;
    const verify = driver.submit.verify;

    const verifyFn = async (): Promise<boolean> => {
      switch (verify) {
        case 'composer-emptied': {
          const v = await this.evalValue(handle, `(() => {
            const el = document.querySelector(${JSON.stringify(composer)});
            if (!el) return false;
            const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
            const val = (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT')
              ? (editable.value || '') : (editable.innerText || '');
            return val.trim().length < 5;
          })()`);
          return v === true;
        }
        case 'loading-indicator': {
          const v = await this.evalValue(handle, `(() => {
            return document.querySelector('[class*="animate"], [class*="loading"]') !== null;
          })()`);
          return v === true;
        }
        case 'response-started': {
          const sel = await this.resolveResponseSelector(handle);
          if (!sel) return false;
          const v = await this.evalValue(handle, `document.querySelector(${JSON.stringify(sel)}) !== null`);
          return v === true;
        }
        default:
          return false;
      }
    };

    const clickButton = async (): Promise<boolean> => {
      // Conditional send buttons render after typing with latency (live-verified:
      // claude /new needed ~2s post-open + the button appears after text lands).
      // Retry resolve+click so a slow render doesn't strand the ask.
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 600 : 800));
        const sendSel = await this.resolveControl(handle, 'sendButton', true);
        if (sendSel) {
          const clicked = await this.evalValue(handle, `(() => {
            const b = document.querySelector(${JSON.stringify(sendSel)});
            if (!b || b.disabled) return false;
            b.click(); return true;
          })()`);
          if (clicked === true) {
            await new Promise((r) => setTimeout(r, 700));
            if (await verifyFn()) return true;
          }
        }
      }
      return false;
    };

    if (method === 'click') {
      if (await clickButton()) return true;
      if (driver.submit.enterSends) {
        await this.evalValue(handle, `(() => { const el = document.querySelector(${JSON.stringify(composer)}); if (el) el.focus(); return true; })()`);
        await handle.pressKey('Enter');
        await new Promise((r) => setTimeout(r, 600));
        return verifyFn();
      }
      return false;
    }

    if (method === 'enter') {
      await this.evalValue(handle, `(() => { const el = document.querySelector(${JSON.stringify(composer)}); if (el) el.focus(); return true; })()`);
      await handle.pressKey('Enter');
      await new Promise((r) => setTimeout(r, 600));
      return verifyFn();
    }

    if (method === 'click-after-type') {
      // Claude: click the button; NEVER fall back to Enter (enterSends: false).
      return clickButton();
    }

    return false;
  }

  /** Build the in-page probe: response texts/htmls, stop/indicator, login/blocked body, messageId. */
  protected buildPollScript(driver: ProviderDriver | null, responseSel: string | null): string {
    const working = driver?.signals?.working;
    const stopExpr = working?.selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(working.selector)}); return el !== null && el.offsetParent !== null; })()`
      : STOP_SCAN;
    const messageIdExpr = driver?.messageId
      ? `const last = els[els.length - 1]; if (last) messageId = last.getAttribute(${JSON.stringify(driver.messageId.attr)}) || '';`
      : '';
    return `(() => {
      const body = document.body.innerText || '';
      const sel = ${JSON.stringify(responseSel)};
      const els = sel ? [...document.querySelectorAll(sel)] : [];
      const texts = els.map(el => (el.innerText || '').trim()).filter(t => t.length > 0);
      const htmls = els.map(el => el.innerHTML);
      const hasStopButton = ${stopExpr};
      let messageId = '';
      ${messageIdExpr}
      return {
        bodyText: body, texts, htmls,
        hasStopButton,
        hasResponseContainer: els.length > 0,
        messageId,
      };
    })()`;
  }

  /**
   * Determine poll state from the probe. P6 gate: `completed` requires non-empty
   * response text; an empty container after generation degrades instead of
   * reporting a silent empty response.
   *
   * 2026-08-10 (user rule): the COMPLETION verdict (state/confidence/via) comes
   * from the ONE shared detector (src/providers/completion.ts) — same for all
   * drivers, parameterized by provider. This method keeps only the
   * provider-entry-state checks (login/blocked/degraded — availability, not
   * completion) and delegates the rest.
   */
  protected determineState(driver: ProviderDriver | null, probe: PollProbe): { state: ProviderState; completionConfidence?: 'heuristic' | 'weak' } {
    const body = (probe.bodyText ?? '').toLowerCase();
    const login = driver?.signals?.login ?? [];
    const blocked = driver?.signals?.blocked ?? [];
    if (login.some((p) => body.includes(p.toLowerCase()))) return { state: 'login_required' };
    if (blocked.some((p) => body.includes(p.toLowerCase()))) return { state: 'blocked' };

    const verdict = detectCompletion({
      provider: this.provider as any,
      currentTurnText: probe.texts?.[probe.texts.length - 1] ?? '',
      bodyText: probe.bodyText ?? '',
      hasActiveStopButton: probe.hasStopButton === true,
      hasLoadingSpinner: false,
      hasWorkingSignal: !!driver?.signals?.working,
    });
    if (verdict.state === 'working') return { state: 'streaming' };
    if (verdict.state === 'completed') {
      return { state: 'completed', completionConfidence: (verdict.completionConfidence ?? 'weak') as 'heuristic' | 'weak' };
    }
    if (ERROR_PATTERNS.some((p) => body.includes(p))) return { state: 'degraded' };
    // response container exists but is empty (or missing after a completed ask) —
    // never a silent empty completion (P6 gate)
    if (probe.hasResponseContainer === true) return { state: 'degraded' };
    return { state: 'idle' };
  }

  /** Live login check (body-text patterns). */
  protected async loginRequired(handle: TabCDPHandle, driver: ProviderDriver | null): Promise<boolean> {
    const patterns = driver?.signals?.login ?? [];
    if (patterns.length === 0) return false;
    const body = await this.evalValue(handle, `document.body.innerText || ''`);
    const lower = String(body ?? '').toLowerCase();
    return patterns.some((p) => lower.includes(p.toLowerCase()));
  }

  async poll(session: TabSession): Promise<PollResult> {
    const handle = this.handleFor(session);
    const driver = this.driverSection();
    const responseSel = await this.resolveResponseSelector(handle);

    const raw = await handle.safeEvaluate(this.buildPollScript(driver, responseSel));
    const probe = ((raw?.result?.value ?? {}) as PollProbe);

    const decided = this.determineState(driver, probe);
    const state = decided.state;
    const extraction = state === 'completed' && (probe.texts?.length ?? 0) > 0
      ? extractAssistantTurn(probe.texts ?? [], {
          preferLast: driver?.extraction?.preferLast,
          strip: ASSISTANT_TURN_STRIPS[this.provider],
        })
      : null;
    const markdown = state === 'completed' && (probe.htmls?.length ?? 0) > 0
      ? htmlToMarkdown(this.markdownVariant(), probe.htmls![probe.htmls!.length - 1])
      : null;
    // 2026-08-10 (user rule): completionVia comes from the ONE shared detector
    // (via determineState → detectCompletion): 'sentinel' when the status line /
    // sentinel contract was observed in the current turn, 'fallback' otherwise.
    // The gate's bounded reminder fires on 'fallback'.
    const completionVia = this.completionViaFor(driver, probe);

    return {
      state,
      steps: [],
      currentStep: '',
      response: extraction?.response ?? '',
      markdown,
      hasStopButton: probe.hasStopButton === true,
      agentBrowsingUrl: await this.agentBrowsingUrl(),
      messageId: probe.messageId || undefined,
      contentHash: extraction ? simpleHash(extraction.response) : undefined,
      // 2026-08-09 latency fix: stop-absent on providers with a working signal ⇒ heuristic
      completionConfidence: decided.completionConfidence,
      // 2026-08-10 (user rule, same pattern as every driver): the shared
      // detector's completionVia — sentinel vs fallback
      completionVia,
      extraction: extraction
        ? {
            joinedProseBlocks: extraction.joinedProseBlocks,
            truncatedFromEnd: extraction.truncatedFromEnd,
            dedupedByContainment: extraction.dedupedByContainment,
          }
        : undefined,
    };
  }

  /**
   * 2026-08-10 (user rule): completionVia from the ONE shared detector —
   * 'sentinel' when the status line / sentinel contract was observed in the
   * current turn (the completionMarker triggered), 'fallback' otherwise.
   * The gate's bounded reminder fires on 'fallback' for a completionMarker ask.
   */
  protected completionViaFor(driver: ProviderDriver | null, probe: PollProbe): 'sentinel' | 'fallback' {
    return detectCompletion({
      provider: this.provider as any,
      currentTurnText: probe.texts?.[probe.texts.length - 1] ?? '',
      bodyText: probe.bodyText ?? '',
      hasActiveStopButton: probe.hasStopButton === true,
      hasLoadingSpinner: false,
      hasWorkingSignal: !!driver?.signals?.working,
    }).completionVia;
  }

  /** Agent-browsing URL with sibling-provider-tab exclusion (P3 fix, shared). */
  protected async agentBrowsingUrl(): Promise<string> {
    try {
      const { cometClient } = await import('../cdp-client.js');
      const tabs = await cometClient.listTabsCategorized();
      const registeredTabIds = tabRegistry.list().map((s) => s.targetId);
      if (tabs.agentBrowsing && !registeredTabIds.includes(tabs.agentBrowsing.id)) {
        return tabs.agentBrowsing.url;
      }
    } catch { /* continue without URL */ }
    return '';
  }

  async stop(session: TabSession): Promise<boolean> {
    const handle = this.handleFor(session);
    const result = await handle.evaluate(STOP_SCAN.replace('return false;', 'btn.click(); return true;'));
    return (result?.result?.value as boolean) ?? false;
  }

  async reset(session: TabSession): Promise<void> {
    const handle = this.handleFor(session);
    const driver = this.driverSection();
    const method = driver?.reset?.method;
    // 2026-08-10 (ADR 0012): a fresh session starts at the URL the user opened
    // this tab at (project/Gem with the status-line Custom Instruction — read
    // live at session open), falling back to the entry reset URL.
    const targetUrl = session.sessionUrl ?? driver?.reset?.url;
    if (method === 'navigate') {
      if (targetUrl) {
        await handle.navigate(targetUrl, true);
        await new Promise((r) => setTimeout(r, 1500));
        return;
      }
    }
    if (method === 'control') {
      const newChatSel = await this.resolveControl(handle, 'newChat', true);
      if (newChatSel) {
        const clicked = await this.evalValue(handle, `(() => {
          const b = document.querySelector(${JSON.stringify(newChatSel)});
          if (!b) return false; b.click(); return true;
        })()`);
        if (clicked === true) {
          await new Promise((r) => setTimeout(r, 1200));
          return;
        }
      }
    }
    // default / 'url': scoped registry reset (navigates to the session URL when
    // set — the project/Gem with the Custom Instruction — else the entry URL)
    if (targetUrl) {
      await handle.navigate(targetUrl, true);
      await new Promise((r) => setTimeout(r, 1500));
      return;
    }
    await tabRegistry.reset(session.targetId);
  }

  /** Structured health (P6 gate): per-control source/confidence, working signal, login probe. */
  async health(session: TabSession): Promise<HealthReport> {
    const handle = this.handleFor(session);
    const e = this.entry();
    const driver = this.driverSection();
    const checks: HealthReport['hookResolution'] = [];
    let healthy = true;
    let lastVerifiedSec = 0;
    for (const name of ['composer', 'sendButton', 'modelPicker', 'newChat', 'responseContainer'] as const) {
      const control = e?.controls[name];
      if (!control?.selector) continue;
      const resolved = await resolveWithRebind(
        (expr) => this.evalValue(handle, expr),
        control.selector,
        control.fingerprint,
      );
      const ok = resolved !== null;
      checks.push({
        control: name,
        source: ok ? (resolved!.rebound ? 'override' : 'known-selector') : (control.fingerprint ? 'override' : 'missing'),
        confidence: control.confidence,
        foundVia: ok ? (resolved!.rebound ? 'fingerprint-rebind' : 'discovery') : (control.fingerprint ? 'override' : 'heuristic'),
      });
      if (control.last_validated && control.last_validated > lastVerifiedSec) lastVerifiedSec = control.last_validated;
      if (!ok && name !== 'sendButton') healthy = false; // sendButton conditional
    }

    const workingProbe = await this.evalValue(handle, STOP_SCAN);
    const loginReq = await this.loginRequired(handle, driver);

    return {
      provider: this.provider,
      healthy: healthy && !loginReq,
      loginRequired: loginReq,
      degraded: !healthy || loginReq,
      hookResolution: checks,
      workingSignal: {
        observed: workingProbe === true,
        kind: driver?.signals?.working?.kind,
      },
      lastVerifiedAt: lastVerifiedSec > 0
        ? new Date(lastVerifiedSec * 1000).toISOString()
        : new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
    };
  }
}

/** Shape of the in-page probe value (buildPollScript return). */
export interface PollProbe {
  bodyText?: string;
  texts?: string[];
  htmls?: string[];
  hasStopButton?: boolean;
  hasResponseContainer?: boolean;
  messageId?: string;
}
