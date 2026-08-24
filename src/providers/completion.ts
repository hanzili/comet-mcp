/**
 * ONE completion detector shared by ALL drivers (2026-08-10 user rule).
 *
 * Previously each driver carried its own copy of the same completion logic:
 * perplexity.ts had hasStatusLine + determineStatus, grok.ts had
 * determineGrokStatus + its own status-line regex, base.ts had determineState
 * + its own status-line regex. Same algorithm, three implementations.
 *
 * This module is the SINGLE detector, parameterized by provider via the
 * PROVIDER_COMPLETION config table. Every driver calls detectCompletion() with
 * the same signal shape and gets the same verdict fields:
 *   - state (idle | working | completed)
 *   - completionConfidence (authoritative | heuristic | weak)
 *   - completionVia ('sentinel' when the status line / sentinel contract was
 *     observed — the completionMarker triggered; 'fallback' when the driver
 *     had to complete via other signals). The gate's bounded ADR 0011 reminder
 *     fires on 'fallback' for a completionMarker ask.
 *   - statusLine (the observed line, for the driver to append to the response)
 */

import type { ProviderId } from '../types/conversation.js';
import { WORKING_PATTERNS } from './extraction.js';

export type CompletionState = 'idle' | 'working' | 'completed';
export type CompletionConfidence = 'authoritative' | 'heuristic' | 'weak';
export type CompletionVia = 'sentinel' | 'fallback';

export interface CompletionSignals {
  provider: ProviderId;
  /** The current turn's scoped text (last prose element / last message / extracted response). */
  currentTurnText: string;
  /** Full page body text (status-line scope + working patterns + body-scoped markers). */
  bodyText: string;
  hasActiveStopButton: boolean;
  hasLoadingSpinner: boolean;
  /** Provider entry defines a working/stop signal (base drivers) — fallback confidence heuristic vs weak. */
  hasWorkingSignal: boolean;
}

export interface CompletionVerdict {
  state: CompletionState;
  completionConfidence?: CompletionConfidence;
  completionVia: CompletionVia;
  /** The observed status line, if any (driver appends it to the response). */
  statusLine?: string;
}

/**
 * The completionMarker contract — the status line, SAME for every provider:
 * a line starting with "Turn" and carrying the sentinel LAST. Other fields
 * (turn number, date, time, model, context%) are OPTIONAL (2026-08-10 user
 * directive: the model may estimate or skip them — claude refuses fabricated
 * counters). The SENTINEL is the only mandatory part; stripSentinel checks
 * it separately. The lookahead anchors to trailing UI chrome / EOF so an OLD
 * turn's line mid-thread cannot match.
 */
const STATUS_LINE_RE = /^Turn(?:\s|,|\|)[^\n]*(?=[\s\S]*?(?:Ask a follow-up|Sources|Search|$))/gm;

/** Last status-line match in a text (the current turn's line in a multi-turn thread). */
export function findStatusLine(text: string): string | null {
  const m = text.match(STATUS_LINE_RE);
  return m && m.length > 0 ? m[m.length - 1] : null;
}

interface ProviderCompletionConfig {
  /** Where the status line renders: 'bodyText' (perplexity — outside prose) or 'currentTurn' (grok/base). */
  statusLineScope: 'bodyText' | 'currentTurn';
  /** Provider-native still-generating marker (grok "Working for Xs"), checked on currentTurnText. */
  workingMarker?: RegExp;
  /** Provider-native end-of-answer marker (fallback completion), checked on currentTurnText. */
  nativeMarker?: RegExp;
  nativeConfidence?: CompletionConfidence;
  /** Native marker scope: 'currentTurn' (default) or 'bodyText' (perplexity markers live in body). */
  markerScope?: 'bodyText' | 'currentTurn';
}

const PROVIDER_COMPLETION: Record<ProviderId, ProviderCompletionConfig> = {
  perplexity: {
    // the status line renders OUTSIDE [class*="prose"] — bodyText only (observed live)
    statusLineScope: 'bodyText',
    nativeMarker: /Ask a follow-up|Finished/,
    nativeConfidence: 'authoritative',
    markerScope: 'bodyText',
  },
  grok: {
    statusLineScope: 'currentTurn',
    workingMarker: /^Working for \d+s/i,
    nativeMarker: /^Worked for \d+s/i,
    nativeConfidence: 'authoritative',
  },
  gemini: { statusLineScope: 'currentTurn' },
  chatgpt: { statusLineScope: 'currentTurn' },
  claude: { statusLineScope: 'currentTurn' },
};

/**
 * THE completion detector. Order matters (completion signals win over
 * working-text, because the answer itself can contain "Working"/"Searching"):
 *   1. status line / sentinel observed → completed + authoritative + 'sentinel'
 *      (the completionMarker triggered — same for every provider)
 *   2. stop button / spinner → working
 *   3. provider-native still-generating marker → working
 *   4. provider-native end-of-answer marker → completed (fallback)
 *   5. response present, no working signal → completed (heuristic if the
 *      provider has a real stop control, weak otherwise — anti-truncation)
 *   6. working-text patterns → working
 *   7. else idle
 */
export function detectCompletion(signals: CompletionSignals): CompletionVerdict {
  const cfg = PROVIDER_COMPLETION[signals.provider] ?? { statusLineScope: 'currentTurn' as const };
  const statusLineText = cfg.statusLineScope === 'bodyText' ? signals.bodyText : signals.currentTurnText;
  const statusLine = findStatusLine(statusLineText);

  // 1. THE completionMarker: the status line / sentinel contract, same for all.
  if (statusLine) {
    return { state: 'completed', completionConfidence: 'authoritative', completionVia: 'sentinel', statusLine };
  }
  // 2. Still generating?
  if (signals.hasActiveStopButton || signals.hasLoadingSpinner) {
    return { state: 'working', completionVia: 'fallback' };
  }
  // 3. Provider-native still-generating marker (grok timing line, present tense).
  if (cfg.workingMarker && cfg.workingMarker.test(signals.currentTurnText)) {
    return { state: 'working', completionVia: 'fallback' };
  }
  // 4. Provider-native end-of-answer marker (fallback completion).
  if (cfg.nativeMarker) {
    const markerText = cfg.markerScope === 'bodyText' ? signals.bodyText : signals.currentTurnText;
    if (cfg.nativeMarker.test(markerText)) {
      return { state: 'completed', completionConfidence: cfg.nativeConfidence ?? 'heuristic', completionVia: 'fallback' };
    }
  }
  // 5. Response present, no working signal → completed via fallback.
  if (signals.currentTurnText.trim().length > 0) {
    return {
      state: 'completed',
      completionConfidence: signals.hasWorkingSignal ? 'heuristic' : 'weak',
      completionVia: 'fallback',
    };
  }
  // 6. Working-text patterns → still generating.
  if (WORKING_PATTERNS.some((p) => signals.bodyText.includes(p))) {
    return { state: 'working', completionVia: 'fallback' };
  }
  // 7. Nothing to say.
  return { state: 'idle', completionVia: 'fallback' };
}
