/**
 * Gemini ChatDriver (P6) — entry-driven via BaseChatDriver.
 *
 * All behavior lives in the entry's driver section
 * (src/providers/entries/gemini.driver.json, merged at load):
 *  - composer: Quill contenteditable div [aria-label="Enter a prompt for Gemini"]
 *    → insertText;
 *  - submit: click [aria-label="Send message"] (conditional, appears after text),
 *    Enter fallback verified (entry heuristics), verify composer-emptied;
 *  - signals: stop-control working, stop-absent completed, Google sign-in → login,
 *    rate-limit phrases → blocked;
 *  - markdown: 'gemini' preClean variant (disclaimer + citation-card stripping).
 *
 * Discovery inventory: src/providers/entries/gemini.json (HIGH, 2026-08-07).
 */

import { BaseChatDriver } from './base.js';

export class GeminiDriver extends BaseChatDriver {
  readonly provider = 'gemini' as const;
}

export const geminiDriver = new GeminiDriver();
