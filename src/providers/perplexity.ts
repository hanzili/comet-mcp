/**
 * Perplexity provider registry entry — extracted from the existing CometAI adapter
 * contract (src/comet-ai.ts), live-verified per the 2026-08-06 session handoff
 * (Bug #1 join+dedupe extraction and Bug #2 slice(-8000) truncation both confirmed
 * fixed on live threads).
 *
 * This entry is the P1 "refactor Perplexity behavior into the provider contract" seed:
 * the driver implementation (ChatDriver) will resolve controls through this entry
 * instead of hard-coded selectors in CometAI.
 *
 * Confidence: MEDIUM — selectors come from code + handoff evidence, not a fresh live
 * discovery run with PONG. Re-run the discovery workflow for Perplexity to upgrade.
 */

import type { ProviderState } from '../types/provider.js';

export interface ProviderControl {
  selector: string;
  aliases?: string[];
  conditional?: boolean;
  condition?: string;
}

export interface ProviderEntry {
  provider: 'perplexity';
  url: string;
  version: string;
  discoveredAt: string;
  method: string;
  confidence: 'high' | 'medium' | 'low';
  controls: {
    composer: ProviderControl;
    sendButton: ProviderControl;
    stopButton: ProviderControl;
    newChat: ProviderControl;
    /** Response prose blocks — extraction joins ALL, dedupes by containment, keeps newest. */
    responseContainer: ProviderControl;
  };
  heuristics: {
    composerFallback: string;
    sendButtonFallback: string;
    responseFallback: string;
    stopDetection: string;
    stateMachine: Partial<Record<ProviderState, string>>;
  };
}

export const perplexityEntry: ProviderEntry = {
  provider: 'perplexity',
  url: 'https://www.perplexity.ai/',
  version: 'unknown (Chrome/150 Comet at discovery time)',
  discoveredAt: '2026-08-06',
  method: 'code-contract extraction from src/comet-ai.ts + session-handoff live verification',
  confidence: 'medium',
  controls: {
    composer: {
      selector: '[contenteditable="true"]',
      aliases: [
        'textarea[placeholder*="Ask"]',
        'textarea[placeholder*="Search"]',
        'textarea',
        'input[type="text"]',
      ],
      conditional: true,
      condition: 'contenteditable primary; textarea fallbacks in selector order',
    },
    sendButton: {
      selector: 'button[aria-label*="Submit"], button[aria-label*="Send"], button[aria-label*="Ask"], button[type="submit"]',
      conditional: true,
      condition: 'Enter-key is strategy 1 (most reliable); button click is strategy 2; rightmost-SVG-in-parent walk as final fallback',
    },
    stopButton: {
      selector: 'button[aria-label*="Stop"], button[aria-label*="Cancel"], button svg rect',
      condition: 'only present while working',
    },
    newChat: {
      selector: '[aria-label*="New"], [aria-label*="new chat"]',
    },
    responseContainer: {
      selector: '[class*="prose"]',
      aliases: ['main [class*="prose"]'],
      condition: 'skip elements inside nav/aside/header/footer/form; skip UI text (Library, Discover, Spaces, Upgrade…)',
    },
  },
  heuristics: {
    composerFallback: 'first of: [contenteditable="true"], textarea[placeholder*="Ask"], textarea[placeholder*="Search"], textarea, input[type="text"]',
    sendButtonFallback: 'Enter key, then aria-label Submit/Send/Ask, then rightmost enabled SVG button within 4 ancestor levels of the composer',
    responseFallback: 'join all [class*="prose"] texts, dedupe by containment (drop text fully contained in a longer block), then replace UI phrases and collapse whitespace',
    stopDetection: 'button[aria-label*="Stop"/"Cancel"] or button with svg rect, visible and enabled',
    stateMachine: {
      idle: 'no stop button, no spinner',
      working: 'stop button or animate-spin/pulse spinner present, or working text (Searching, Reviewing sources, Clicking, Typing:…)',
      completed: 'steps completed marker, or Finished without stop button, or "Ask a follow-up" with prose content (wins over working text — the answer itself often contains words like "Working"/"Analyzing")',
    },
  },
};
