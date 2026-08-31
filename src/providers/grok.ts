/**
 * Grok provider registry entry — discovered live against the authenticated Comet profile.
 *
 * Source: test/integration/grok-discover.mjs (offline/on-demand selector miner,
 * per build plan "Discovery and repair workflow" — NOT in the hot path).
 *
 * Verified 2026-08-06T20:37Z against grok.com (Comet = Chrome/150.0.7871.230,
 * CDP Protocol 1.3) with a live `Say only: PONG` submission (response: "PONG").
 * Confidence: HIGH — composer, send, model picker, new chat, response containers,
 * and the idle/typing/streaming/completed state machine all verified end-to-end.
 *
 * Selector drift policy: when health reports flag missing hooks, re-run
 * `node test/integration/grok-discover.mjs --diff` and commit the updated entry.
 * Fixtures for synthetic testing: test/fixtures/grok/{idle,typing,streaming,completed}.html
 */

import type { ProviderState } from '../types/provider.js';

/** CSS selector that resolves to a control, with aliases and render preconditions. */
export interface ProviderControl {
  selector: string;
  aliases?: string[];
  /** True when the control only exists after a precondition (e.g. text typed). */
  conditional?: boolean;
  condition?: string;
}

/**
 * A provider registry entry: known selectors + constrained heuristics + capability
 * evidence. Produced by discovery; consumed by drivers to resolve controls.
 */
export interface ProviderEntry {
  provider: 'grok';
  url: string;
  /** Browser version at discovery time — selector drift sentinel. */
  version: string;
  discoveredAt: string;
  method: string;
  confidence: 'high' | 'medium' | 'low';
  controls: {
    /** Composer — contenteditable div. Focus its editable child before insertText. */
    composer: ProviderControl;
    /** Send button — rendered ONLY after text is present. */
    sendButton: ProviderControl;
    /** Model picker — inspection only; no activation in discovery. */
    modelPicker: ProviderControl;
    /** New chat — inspection only; no activation in discovery. */
    newChat: ProviderControl;
    /** User question container. */
    userMessage: ProviderControl;
    /** Assistant response container — take the LAST match for current turn. */
    assistantMessage: ProviderControl;
    /** Streaming indicator element (canvas) — text "Working for Xs". */
    workingIndicator: ProviderControl;
  };
  heuristics: {
    composerFallback: string;
    sendButtonFallback: string;
    responseFallback: string;
    /** Verified: Grok Fast model never renders a stop button during generation. */
    stopDetection: string;
    /** Only the states this provider can express (Grok: idle/typing/streaming/completed). */
    stateMachine: Partial<Record<ProviderState, string>>;
  };
}

export const grokEntry: ProviderEntry = {
  provider: 'grok',
  url: 'https://grok.com/',
  version: 'Chrome/150.0.7871.230',
  discoveredAt: '2026-08-06T20:37:16.362Z',
  method: 'live-CDP-inventory + PONG validation',
  confidence: 'high',
  controls: {
    composer: {
      selector: '[data-testid="chat-input"]',
      aliases: ['[aria-label="Ask Grok anything"]'],
      conditional: true,
      condition: 'always present; editable child must be focused before Input.insertText',
    },
    sendButton: {
      selector: '[data-testid="chat-submit"]',
      aliases: ['[data-testid="chat-submit"][aria-label="Submit"]', 'button[type="submit"]'],
      conditional: true,
      condition: 'rendered only after composer has text',
    },
    modelPicker: {
      selector: '#model-select-trigger',
      aliases: ['[aria-label="Model select"]'],
    },
    newChat: {
      selector: '[aria-label="New chat"]',
    },
    userMessage: {
      selector: '[data-testid="user-message"]',
    },
    assistantMessage: {
      selector: '[data-testid="assistant-message"]',
    },
    workingIndicator: {
      selector: '[data-testid="canvas-working-indicator"]',
      aliases: ['text: "Working for Ns" in body'],
    },
  },
  heuristics: {
    composerFallback: 'any [role="textbox"] or textarea visible near the bottom of the viewport',
    sendButtonFallback: '[data-testid="chat-submit"] (rendered only after text is typed); Enter-key fallback works',
    responseFallback: '[data-testid="assistant-message"] (last element)',
    stopDetection:
      'NONE on Fast model — verified: no stop button ever renders during generation; use the "Working for Xs" indicator instead',
    stateMachine: {
      idle: 'no working indicator, composer empty',
      typing: 'composer has text, no working indicator',
      streaming: 'body text contains "Working for Xs" (canvas-working-indicator) and/or assistant-message text growing',
      completed: 'no working indicator and assistant-message text stable for 3s',
    },
  },
};
