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
import type { TabCDPHandle } from '../cdp-pool.js';
import type { EvaluateResult } from '../types.js';
import type {
  ChatDriver, PollResult, TabSession, HealthReport, ProviderState,
} from '../types/provider.js';
import type { DeliveryReceipt } from '../types/conversation.js';
import { loadEntry, resolveWithConfidence, recordSuccess, recordFailure, writeEntry } from '../core/registry.js';
import { resolveWithRebind } from '../core/fingerprint.js';
import {
  extractResponse, extractSteps, determineStatus, filterProseTexts,
} from '../providers/extraction.js';
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

  // collect RAW prose texts (filtering happens Node-side)
  const mainContent = document.querySelector('main') || document.body;
  const proseTexts = [];
  const proseHtmls = [];
  for (const el of mainContent.querySelectorAll('[class*="prose"]')) {
    if (el.closest('nav, aside, header, footer, form')) continue;
    const t = el.innerText.trim();
    if (t.length > 0) proseTexts.push(t);
    // P2 markdown: capture the LAST prose element's innerHTML for conversion
    proseHtmls.push(el.innerHTML);
  }

  return { hasActiveStopButton, hasLoadingSpinner, bodyText: body, proseTexts, proseHtmls };
})()`;

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

    // Strategy 1: Enter key (most reliable for Perplexity)
    await evalValue(handle, `(() => { const el = document.querySelector(${JSON.stringify(composer)}); if (el) el.focus(); return true; })()`);
    await handle.pressKey('Enter');
    await new Promise((r) => setTimeout(r, 500));

    // check submitted (composer emptied or loading)
    const submitted = await evalValue(handle, `(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (el) {
        const v = el.isContentEditable || el.tagName === 'DIV' ? el.innerText : (el.value || '');
        if (v.trim().length < 5) return true;
      }
      return document.querySelector('[class*="animate"]') !== null;
    })()`);
    if (submitted === true) return true;

    // Strategy 2: click submit button (from entry, with rebind)
    const sendSel = await findSendButton(handle);
    if (sendSel) {
      const clicked = await evalValue(handle, `(() => {
        const b = document.querySelector(${JSON.stringify(sendSel)});
        if (!b || b.disabled) return false;
        b.click(); return true;
      })()`);
      if (clicked === true) {
        await new Promise((r) => setTimeout(r, 500));
        return true;
      }
    }

    // Last resort: Enter one more time
    await handle.pressKey('Enter');
    return true;
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

    const raw = await handle.safeEvaluate(POLL_SCRIPT);
    const value = (raw?.result?.value ?? {}) as {
      hasActiveStopButton?: boolean;
      hasLoadingSpinner?: boolean;
      bodyText?: string;
      proseTexts?: string[];
      proseHtmls?: string[];
    };

    const bodyText = value.bodyText ?? '';
    const status = determineStatus({
      hasActiveStopButton: value.hasActiveStopButton === true,
      hasLoadingSpinner: value.hasLoadingSpinner === true,
      bodyText,
    });
    const { steps, currentStep } = extractSteps(bodyText);
    const extraction = status === 'completed' ? extractResponse(value.proseTexts ?? []) : null;
    // P2 markdown: convert the LAST prose container's innerHTML when completed
    const markdown = status === 'completed' && (value.proseHtmls?.length ?? 0) > 0
      ? htmlToMarkdown('perplexity', value.proseHtmls![value.proseHtmls!.length - 1])
      : null;

    return {
      state: status as ProviderState,
      steps,
      currentStep,
      response: extraction?.response ?? '',
      markdown,
      hasStopButton: value.hasActiveStopButton === true,
      agentBrowsingUrl,
      contentHash: extraction ? simpleHash(extraction.response) : undefined,
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
