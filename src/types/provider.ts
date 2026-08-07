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
}

/** One CDP session bound to one provider tab, with per-tab state. */
export interface TabSession {
  provider: ProviderId;
  tabId: string;
  targetId: string;
  cdpSessionId: string;
  openedAt: string;
  /** Dedup/reconnect anchors (P3): prevent duplicate response events. */
  lastKnownMessageId?: string;
  lastCompletedAt?: string;
  lastContentHash?: string;
  extractionCursor?: string;
  state: 'connected' | 'degraded' | 'closed';
}

/** Structured health (ADR 0001 §Operational safeguards 3). */
export interface HealthReport {
  provider: ProviderId;
  healthy: boolean;
  loginRequired: boolean;
  degraded: boolean;
  /** Per-control resolution source — drives drift detection (P8). */
  hookResolution: {
    control: string;
    source: 'known-selector' | 'heuristic' | 'override' | 'missing';
  }[];
  lastCheckedAt: string;
  note?: string;
}

/**
 * A CSS selector that resolves a control, with aliases and render preconditions.
 * Produced by live discovery (src/core/discovery.ts); consumed by drivers via
 * src/core/registry.ts (known selector → heuristic → persisted override).
 */
export interface ProviderControl {
  selector: string;
  aliases?: string[];
  /** True when the control only exists after a precondition (e.g. text typed). */
  conditional?: boolean;
  condition?: string;
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
