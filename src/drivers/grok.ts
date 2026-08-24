/**
 * Grok ChatDriver (P2) — first heterogeneous adapter, proving the discovery-to-runtime
 * pipeline against a materially different UI (P2 task list).
 *
 * Grok-specific behaviors captured during live discovery (2026-08-06, grok.com):
 *  - composer is a contenteditable div `[data-testid="chat-input"]` — type via
 *    execCommand insertText (same technique as Perplexity; validated live);
 *  - send button `[data-testid="chat-submit"]` renders ONLY after text is typed
 *    (conditional control — skipped by verify, exercised by ask);
 *  - **no stop button ever** on the Fast model — stop() is a no-op returning false;
 *    streaming/completion is signaled by the "Working for Xs" → "Worked for Xs"
 *    timing line (canvas-working-indicator), which Grok renders INSIDE the message;
 *  - one answer = one `[data-testid="assistant-message"]` element — extraction takes
 *    the LAST one and strips the timing line (src/providers/extraction.ts).
 *
 * Controls resolve through src/providers/entries/grok.json + ADR 0003 fingerprint
 * rebind, same as the Perplexity driver.
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
import { extractGrokResponse } from '../providers/extraction.js';
import { detectCompletion } from '../providers/completion.js';
import { htmlToMarkdown } from '../providers/markdown.js';

const entry = () => loadEntry('grok');

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
async function resolveControl(handle: TabCDPHandle, name: 'composer' | 'sendButton' | 'modelPicker' | 'newChat' | 'responseContainer', conditional = false): Promise<string | null> {
  const e = entry();
  if (!e) return null;
  const { selector, control } = resolveWithConfidence(e, name);
  if (!selector) return null;

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

  // genuine miss — record failure (conditional controls skipped)
  if (!conditional && control) {
    const { control: updated } = recordFailure(control);
    (e.controls as any)[name] = updated;
    writeEntry(e);
  }
  return null;
}

/** Find the Grok composer (entry selector first, role=textbox fallback). */
async function findComposer(handle: TabCDPHandle): Promise<string | null> {
  const entrySel = await resolveControl(handle, 'composer');
  if (entrySel) return entrySel;
  const hit = await evalValue(handle, `document.querySelector('[role="textbox"]') !== null`);
  return hit === true ? '[role="textbox"]' : null;
}

/** Find the send button (conditional — only after text exists). */
async function findSendButton(handle: TabCDPHandle): Promise<string | null> {
  return resolveControl(handle, 'sendButton', true);
}

// ---------------------------------------------------------------------------
// In-page collection script (Grok) — status signals + assistant-message texts.
// Extraction happens Node-side in src/providers/extraction.ts (testable).
// ---------------------------------------------------------------------------
const POLL_SCRIPT = `(() => {
  const body = document.body.innerText;
  const msgs = [...document.querySelectorAll('[data-testid="assistant-message"]')];
  const texts = msgs.map(el => (el.innerText || '').trim()).filter(t => t.length > 0);
  // P2 markdown: last assistant-message's innerHTML for conversion (timing line stripped in markdown.ts)
  const htmls = msgs.map(el => el.innerHTML);
  return { bodyText: body, assistantMessages: texts, assistantHtmls: htmls };
})()`;

export class GrokDriver implements ChatDriver {
  readonly provider = 'grok' as const;

  async open(): Promise<TabSession> {
    // P3: open/reuse the provider tab through the registry (pooled per-tab session).
    return tabRegistry.open('grok');
  }

  async ask(session: TabSession, prompt: string): Promise<{ receipt: DeliveryReceipt }> {
    const handle = handleFor(session);
    const composer = await findComposer(handle);
    if (!composer) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
          details: 'Could not find Grok composer. Is the grok.com tab open and logged in?',
        },
      };
    }

    // type into the contenteditable composer (focus editable child, execCommand)
    const typed = await evalValue(handle, `(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return { success: false };
      const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
      editable.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, ${JSON.stringify(prompt)});
      // 2026-08-15 (live bug, verified on the grok tab): execCommand('insertText')
      // sets the DOM but does NOT fire React's onChange — the send button never
      // renders, Enter no-ops, and the composer-emptied check fails (send.unknown,
      // prompt never submitted). Same bug class perplexity had (0cc93db). Dispatch
      // a DATA-LESS InputEvent so React registers the value and enables submit —
      // with data, the editor ALSO inserts the text itself, doubling the prompt.
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return { success: true };
    })()`);
    if (typed?.success !== true) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'blocked', recordedAt: new Date().toISOString(),
          details: 'Failed to type into Grok composer',
        },
      };
    }

    // submit — send button (conditional) or Enter fallback
    await new Promise((r) => setTimeout(r, 500));
    let submitted = false;
    const sendSel = await findSendButton(handle);
    if (sendSel) {
      const clicked = await evalValue(handle, `(() => {
        const b = document.querySelector(${JSON.stringify(sendSel)});
        if (!b || b.disabled) return false;
        b.click(); return true;
      })()`);
      submitted = clicked === true;
    }
    if (!submitted) {
      await evalValue(handle, `(() => { const el = document.querySelector(${JSON.stringify(composer)}); if (el) el.focus(); return true; })()`);
      await handle.pressKey('Enter');
      submitted = true;
    }

    // 2026-08-10 (live council test): VERIFY the prompt actually left the composer.
    // grok.com may render the send button for a moment after typing but the click
    // can land before the chat-input is ready (fresh tab), or Enter on the wrong
    // focus silently no-ops. Claiming 'sent' without proof made dispatchAsk record
    // send.accepted for a prompt that never appeared — then the advancer's reminder
    // loop compounded it. Proof = composer emptied within a short window.
    await new Promise((r) => setTimeout(r, 800));
    const emptied = await evalValue(handle, `(() => {
      const el = document.querySelector(${JSON.stringify(composer)});
      if (!el) return false;
      const editable = el.matches('[contenteditable]') ? el : (el.querySelector('[contenteditable]') || el);
      return (editable.innerText || '').trim().length === 0;
    })()`);
    if (emptied !== true) {
      return {
        receipt: {
          receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(), status: 'unknown', recordedAt: new Date().toISOString(),
          details: 'Grok submit not verified — composer still has text after send attempt; prompt may not have rendered',
        },
      };
    }

    return {
      receipt: {
        receiptId: crypto.randomUUID(), envelopeId: 'local', correlationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        status: 'sent',
        recordedAt: new Date().toISOString(),
        details: 'Prompt sent + verified (composer emptied)',
      },
    };
  }

  async poll(session: TabSession): Promise<PollResult> {
    const handle = handleFor(session);
    const raw = await handle.safeEvaluate(POLL_SCRIPT);
    const value = (raw?.result?.value ?? {}) as {
      bodyText?: string;
      assistantMessages?: string[];
      assistantHtmls?: string[];
    };
    const bodyText = value.bodyText ?? '';
    const messages = value.assistantMessages ?? [];
    const lastMessageText = messages[messages.length - 1] ?? '';

    // 2026-08-10 (user rule): ONE completion detector shared by ALL drivers.
    // grok's config: status line scoped to the current turn (last message),
    // "Working for Xs" = still generating, "Worked for Xs" = native fallback
    // completion marker. completionVia = 'sentinel' when the status line /
    // sentinel contract was observed, else 'fallback' (timing line only).
    const verdict = detectCompletion({
      provider: 'grok',
      currentTurnText: lastMessageText,
      bodyText,
      hasActiveStopButton: false,
      hasLoadingSpinner: false,
      hasWorkingSignal: false,
    });
    const state = verdict.state;
    const extraction = state === 'completed' ? extractGrokResponse(messages) : null;
    // P2 markdown: convert the LAST assistant-message's innerHTML when completed
    const markdown = state === 'completed' && (value.assistantHtmls?.length ?? 0) > 0
      ? htmlToMarkdown('grok', value.assistantHtmls![value.assistantHtmls!.length - 1])
      : null;

    return {
      state: state as ProviderState,
      steps: [],
      currentStep: '',
      response: extraction?.response ?? '',
      markdown,
      // Verified finding: Grok Fast model NEVER renders a stop button.
      hasStopButton: false,
      agentBrowsingUrl: '',
      contentHash: extraction ? simpleHash(extraction.response) : undefined,
      // 2026-08-09 latency fix: "Worked for Xs" (native marker) ⇒ authoritative
      completionConfidence: verdict.completionConfidence,
      // 2026-08-10 (user rule): sentinel with fallback — same as every driver
      completionVia: verdict.completionVia,
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
    // Verified discovery finding: Grok Fast model never renders a stop button.
    // No-op — the fabric must not assume a stop control exists.
    return false;
  }

  async reset(session: TabSession): Promise<void> {
    // P3: scoped reset via the registry — only this provider's tab is touched.
    // newChat entry control first, fallback to entry-URL navigation.
    const handle = handleFor(session);
    const newChatSel = await resolveControl(handle, 'newChat', true);
    if (newChatSel) {
      const clicked = await evalValue(handle, `(() => {
        const b = document.querySelector(${JSON.stringify(newChatSel)});
        if (!b) return false; b.click(); return true;
      })()`);
      if (clicked === true) {
        await new Promise((r) => setTimeout(r, 1200));
        return;
      }
    }
    await tabRegistry.reset(session.targetId);
  }

  async health(session: TabSession): Promise<HealthReport> {
    const handle = handleFor(session);
    const e = entry();
    const checks: HealthReport['hookResolution'] = [];
    let healthy = true;
    for (const name of ['composer', 'sendButton', 'modelPicker', 'newChat', 'responseContainer'] as const) {
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
        source: ok ? 'known-selector' : (control.fingerprint ? 'override' : 'missing'),
      });
      if (!ok && name !== 'sendButton') healthy = false; // sendButton conditional
    }
    return {
      provider: 'grok',
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

export const grokDriver = new GrokDriver();
