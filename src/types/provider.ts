/**
 * Provider driver contracts (P1).
 *
 * Provider-neutral types for the adapter layer. Browser-tab automation is a transport
 * (ADR 0001 §Transport 1-3): the control plane and conversation fabric depend on these
 * contracts, so official API transports can join later without rewriting routing,
 * policy, persistence, or scheduling.
 *
 * Discovery data (P2, verified live 2026-08-06/07 across Perplexity, Grok, Gemini,
 * ChatGPT, Claude) informs these types directly — notably that Grok's Fast model NEVER
 * renders a stop button, that several send buttons are conditional on typed text, and
 * that provider entries are DATA (JSON), loaded via src/core/registry.ts, not code.
 */

import type { ProviderId } from './conversation.js';

/**
 * Normalized poll-observable state. The union of what Perplexity (idle|working|completed)
 * and Grok (idle|typing|streaming|completed, working-indicator-based) can express, plus
 * failure states the fabric must distinguish.
 */
export type ProviderState =
  | 'idle'            // no work in flight
  | 'typing'          // composer has text, not yet submitted (Grok: chat-input non-empty)
  | 'working'         // Perplexity: stop button / spinner present (agentic steps)
  | 'streaming'       // Grok: "Working for Xs" indicator active, response text growing
  | 'completed'       // final response present and stable
  | 'login_required'  // provider session expired / needs auth
  | 'degraded'        // hook resolution failing, operating on fallback heuristics
  | 'blocked';        // provider refused (CAPTCHA, plan wall, payment prompt, policy)

/** Result of one poll of a provider tab. */
export interface PollResult {
  state: ProviderState;
  /** Agentic step descriptions (Perplexity); empty for Grok. */
  steps: string[];
  currentStep: string;
  /** Extracted answer text (normalized). */
  response: string;
  /** P2: Markdown rendering of the response (from innerHTML via turndown). Optional — null when not available. */
  markdown?: string | null;
  /**
   * Verified discovery finding (2026-08-06): Grok Fast model never renders a stop
   * button. Perplexity: true while working. Drivers report truthfully; the fabric must
   * not assume a stop control exists.
   */
  hasStopButton: boolean;
  /** URL the provider agent is currently browsing, if observable. */
  agentBrowsingUrl: string;
  /** Dedup anchors (P3): provider-native message id when available. */
  messageId?: string;
  /** Content hash for dedup / replay safety. */
  contentHash?: string;
  /** Extraction cursor/version for the current turn. */
  cursor?: string;
  /** Which extraction behaviors were applied (preserves P1 fix provenance). */
  extraction?: {
    joinedProseBlocks: boolean;   // Perplexity fix: join all prose blocks, not just last
    truncatedFromEnd: boolean;    // Perplexity fix: slice(-8000), keep newest
    dedupedByContainment: boolean;
  };
  /**
   * P4 latency fix (2026-08-09, consult-validated): HOW confidently the driver
   * knows this poll is COMPLETE, per-marker and message-scoped. Absent ⇒ the
   * gate treats it as 'weak' (full stability window) — fail-closed.
   *  - 'authoritative': a provider-native, end-of-answer marker was observed in
   *    the SAME message node the response was extracted from (Grok "Worked for
   *    Xs", Perplexity "Ask a follow-up"/"Finished"). No wall-clock needed.
   *  - 'heuristic': stop-absent + content present (providers with real stop
   *    buttons), or Perplexity "N steps completed" alone. Short window.
   *  - 'weak': response-present with no marker and no stop control. Full 8s.
   */
  completionConfidence?: 'authoritative' | 'heuristic' | 'weak';
  /**
   * 2026-08-10 (user rule): HOW the driver determined completion. 'sentinel'
   * = the status-line / sentinel contract was observed (the completionMarker
   * triggered); 'fallback' = the driver had to complete via other signals
   * (native markers / steps / stop-absent). For a completionMarker ask, a
   * completion reached via fallback means the model skipped the sentinel — the
   * gate's bounded reminder fires on exactly that. The driver KNOWS which one
   * it used; the gate never re-derives it.
   */
  completionVia?: 'sentinel' | 'fallback';
}

/** One CDP session bound to one provider tab, with per-tab state. */
export interface TabSession {
  provider: ProviderId;
  tabId: string;
  targetId: string;
  cdpSessionId: string;
  openedAt: string;
  /**
   * 2026-08-10 (ADR 0012 user directive): the URL the user STARTED the session
   * at — for perplexity a PROJECT, for gemini a GEM — where the status-line
   * Custom Instruction is set up manually. READ from the live tab at session
   * open, never hardcoded. New sessions (newChat / reset / fresh tab) start at
   * this URL so the sentinel contract applies. Absent ⇒ fall back to the entry
   * URL.
   */
  sessionUrl?: string;
  /** Dedup/reconnect anchors (P3): prevent duplicate response events. */
  lastKnownMessageId?: string;
  lastCompletedAt?: string;
  lastContentHash?: string;
  extractionCursor?: string;
  state: 'connected' | 'degraded' | 'closed';
}

/** Structured health (ADR 0001 §Operational safeguards 3; P6-gate surface, Grok review). */
export interface HealthReport {
  provider: ProviderId;
  healthy: boolean;
  loginRequired: boolean;
  degraded: boolean;
  /** Per-control resolution source — drives drift detection (P8). */
  hookResolution: {
    control: string;
    source: 'known-selector' | 'heuristic' | 'override' | 'missing';
    /** P6: learned confidence of the control (0..1). */
    confidence?: number;
    /** P6: how the selector was located (mirrors source). */
    foundVia?: 'discovery' | 'fingerprint-rebind' | 'override' | 'heuristic';
  }[];
  /** P6: live probe of the working signal (stop control / indicator). */
  workingSignal?: { observed: boolean; kind?: string; note?: string };
  /** P6: last time controls were verified successfully (epoch of newest last_validated, or lastCheckedAt). */
  lastVerifiedAt?: string;
  lastCheckedAt: string;
  note?: string;
}

/**
 * A CSS selector that resolves a control, with aliases and render preconditions.
 * Produced by live discovery (src/core/discovery.ts); consumed by drivers via
 * src/core/registry.ts (known selector → heuristic → persisted override).
 *
 * Runtime feedback fields (ADR 0003): confidence is learned by provider_verify —
 * success +0.05, failure −0.15 (asymmetric), learn only from success, evict < 0.3.
 * High confidence (≥ 0.7) controls resolve directly on the hot path; low ones fall
 * back to heuristics and flag discovery.
 */
export interface ProviderControl {
  selector: string;
  aliases?: string[];
  /** True when the control only exists after a precondition (e.g. text typed). */
  conditional?: boolean;
  condition?: string;
  /** ADR 0003: runtime confidence (0..1). Starts at discovery-time value. */
  confidence?: number;
  /** ADR 0003: successful resolves (each bumps confidence +0.05). */
  success_count?: number;
  /** ADR 0003: failed resolves (each decrements confidence −0.15). */
  fail_count?: number;
  /** ADR 0003: epoch seconds of last successful validation. */
  last_validated?: number;
  /** ADR 0003: structural fingerprint (FNV-1a of ancestor chain+tag+children+attrs). 0 = unknown. */
  fingerprint?: number;
  /** ADR 0003: signature string (role|name|ordinal) last successfully resolved. */
  last_sig?: string;
}

/** Control names a provider entry can carry (provider-specific subsets). */
export type ProviderControlName =
  | 'composer'
  | 'sendButton'
  | 'modelPicker'
  | 'newChat'
  | 'userMessage'
  | 'assistantMessage'
  | 'workingIndicator'
  | 'responseContainer';

// ---------------------------------------------------------------------------
// P6: driver-contract section (Grok design review 2026-08-08 — approved).
// Hand-authored behavioral config, stored SEPARATELY from the discovery-owned
// entry (src/providers/entries/<p>.driver.json, merged at load). Discovery
// regenerates only <p>.json and never touches the driver file (R1 closed).
// ---------------------------------------------------------------------------

/** How the driver types into the composer. key-events = execCommand-interception escape hatch. */
export type DriverTyping = 'insertText' | 'value-input' | 'key-events';

/** Submit contract. Claude: click-after-type (button appears after typing; Enter alone does NOT submit — 774e875). */
export interface DriverSubmit {
  method: 'enter' | 'click' | 'click-after-type';
  /** Overrides sendButton for submit when present. */
  selector?: string;
  /** Mandatory verification before a receipt may claim `sent` (Grok review). */
  verify: 'composer-emptied' | 'loading-indicator' | 'response-started';
  /** False when Enter alone does not submit (claude). */
  enterSends?: boolean;
}

/** Poll-observable signals that drive the state machine. */
export interface DriverSignals {
  /** Presence of this signal ⇒ streaming/working. Generic stop-control scan when no selector given. */
  working?: { kind: 'stop-control' | 'indicator' | 'growing-content'; selector?: string };
  /** Absence of this condition ⇒ completed (default path: stop-control absent + hash stable). */
  completed?: { kind: 'stop-absent' | 'hash-stable' | 'response-present' };
  /** Body-text / URL patterns that ⇒ login_required. */
  login?: string[];
  /** Body-text / URL patterns that ⇒ blocked (CAPTCHA, rate limit). */
  blocked?: string[];
}

/** P6 driver contract — everything the shared BaseChatDriver needs to be entry-driven. */
export interface ProviderDriver {
  typing: DriverTyping;
  submit: DriverSubmit;
  signals?: DriverSignals;
  /** Native message-id attribute on the response element (chatgpt: data-message-id). Optional — contentHash is the durable anchor. */
  messageId?: { attr: string };
  /** preClean variant name in src/providers/markdown.ts. */
  markdown?: string;
  /** claude: /recents has no composer → fresh chat via /new navigation. */
  freshChatByNavigation?: boolean;
  reset?: { method: 'url' | 'control' | 'navigate'; url?: string };
  /** Response container selection: take the LAST matching element (common pattern). */
  extraction?: { preferLast?: boolean };
  /**
   * 2026-08-10 (user directive): whether this provider accepts the ADR 0010/0011
   * status-line sentinel contract. Default true. Set false for providers that
   * REFUSE the standing instruction (claude: "I'm not going to comply with this
   * one" — flags it as a jailbreak; refusing fabricated turn counters). When
   * false the ask is sent WITHOUT the sentinel instruction, no sentinel is
   * established, and the ADR 0011 reminder NEVER fires — completion runs purely
   * on the driver's native signals (stop-absent / response-present).
   * NOTE (2026-08-10 ADR 0012): the session URL is NOT configured here — it is
   * READ from the live tab where the user started the session (perplexity
   * project / gemini Gem with the Custom Instruction).
   */
  completionMarker?: boolean;
}

/**
 * A provider registry entry: known selectors + constrained heuristics + capability
 * evidence + discovery metadata. Stored as JSON in src/providers/entries/ and loaded
 * by src/core/registry.ts — discovery writes it directly, so regeneration is
 * repeatable and git-diffable when a provider changes its DOM.
 */
export interface ProviderEntry {
  provider: ProviderId;
  url: string;
  /** Browser version at discovery time — selector drift sentinel. */
  version: string;
  discoveredAt: string;
  method: string;
  confidence: 'high' | 'medium' | 'low';
  /** Controls discovered for this provider (not all providers have all controls). */
  controls: Partial<Record<ProviderControlName, ProviderControl>>;
  /** Selector list the discovery probe used to find response containers. */
  responseSelectors?: string[];
  heuristics: {
    composerFallback: string;
    sendButtonFallback: string;
    responseFallback: string;
    stopDetection: string;
    /** Only the states this provider can express. */
    stateMachine: Partial<Record<ProviderState, string>>;
  };
  /** P6: hand-authored driver contract (merged from entries/<p>.driver.json at load). */
  driver?: ProviderDriver;
}

/**
 * Provider-neutral driver contract. One implementation per provider adapter
 * (Perplexity refactor P1, Grok P2, Gemini/ChatGPT/Claude.ai P6).
 */
export interface ChatDriver {
  readonly provider: ProviderId;
  /** Open/ensure the provider tab; returns a TabSession bound to one CDP session. */
  open(): Promise<TabSession>;
  /** Send a prompt; returns a receipt. Never claims completion. */
  ask(session: TabSession, prompt: string): Promise<{ receipt: import('./conversation.js').DeliveryReceipt }>;
  /** Poll the current turn. */
  poll(session: TabSession): Promise<PollResult>;
  /** Stop current generation if the provider supports it (Grok Fast: no-op false). */
  stop(session: TabSession): Promise<boolean>;
  /** Reset to a new chat scoped to this provider's tab. */
  reset(session: TabSession): Promise<void>;
  /** Structured health. */
  health(session: TabSession): Promise<HealthReport>;
}
