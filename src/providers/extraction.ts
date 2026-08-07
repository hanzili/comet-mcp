/**
 * Perplexity response extraction (P1) — pure, Node-side, unit-testable.
 *
 * P1 requirement: "Preserve and test existing extraction fixes: ordering, truncation,
 * whitespace, escaping, and steps parsing." This module holds the EXACT semantics of
 * the extraction that lived inside the injected browser script in CometAI.getAgentStatus
 * (verified live 2026-08-06/07 against real Perplexity threads):
 *
 *  - join ALL prose blocks (not just the last)  — Bug #1 fix
 *  - dedupe by containment (nested prose elements) — Bug #1 fix
 *  - collapse horizontal whitespace but PRESERVE paragraph breaks — Bug #1 v2 fix
 *  - keep the NEWEST content (slice(-N), not substring(0,N)) — Bug #2 fix
 *
 * The in-page script (collectProseScript) only COLLECTS raw prose texts + status
 * signals; everything text-shaping happens here where it is testable.
 */

/** UI text that prefixes real content and must be skipped. */
export const UI_PREFIXES = [
  'Library', 'Discover', 'Spaces', 'Finance', 'Account',
  'Upgrade', 'Home', 'Search', 'Ask a follow-up',
] as const;

/** Phrases stripped from the joined response (Perplexity UI residue). */
export const UI_PHRASES = /View All|Show more|Ask a follow-up|\d+ sources?/gi;

/** Working-state text patterns used for status determination. */
export const WORKING_PATTERNS = [
  'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
  'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing',
] as const;

/** Step extraction patterns (Perplexity agentic steps). */
export const STEP_PATTERNS: RegExp[] = [
  /Preparing to assist[^\n]*/g, /Clicking[^\n]*/g, /Typing:[^\n]*/g,
  /Navigating[^\n]*/g, /Reading[^\n]*/g, /Searching[^\n]*/g, /Found[^\n]*/g,
];

/** Keep only the newest N chars of the joined response. */
export const RESPONSE_CAP = 30000;

/** A raw prose text collected from the page. */
export interface ProseText {
  text: string;
}

/**
 * Filter raw prose texts: skip nav/aside/header/footer/form context (caller drops
 * those elements), skip UI-prefixed text, skip short questions, keep len > 5.
 * `uiPrefixes` is provider-specific (Perplexity defaults; Grok passes its own).
 */
export function filterProseTexts(texts: string[], uiPrefixes: readonly string[] = UI_PREFIXES): string[] {
  return texts.filter((raw) => {
    const text = raw.trim();
    if (uiPrefixes.some((ui) => text.startsWith(ui))) return false;
    if (text.endsWith('?') && text.length < 100) return false;
    return text.length > 5;
  });
}

/**
 * Exact-dedupe then containment-dedupe, preserving first-seen order.
 * Perplexity nests prose elements (outer wrapper contains inner blocks); keeping
 * only texts not contained in a longer sibling avoids repeating content.
 */
export function dedupeByContainment(texts: string[]): string[] {
  const seen = new Set<string>();
  const unique = texts.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return unique.filter((t) => !unique.some((u) => u.length > t.length && u.includes(t)));
}

/**
 * Clean the joined response: strip UI phrases, collapse horizontal whitespace
 * (NOT newlines — paragraph breaks must survive), collapse 3+ newlines to 2.
 */
export function cleanResponse(response: string, uiPhrases: RegExp = UI_PHRASES): string {
  // Order matches the verified in-page script exactly: strip UI phrases, trim,
  // collapse horizontal whitespace (NOT newlines), collapse 3+ newlines to 2, trim.
  // The leading .trim() before the collapses matters: without it, edge whitespace
  // like "\n\n  Line" collapses to "\n\n Line" (a leading space survives).
  return response
    .replace(uiPhrases, '')
    .trim()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Full extraction pipeline: filter → dedupe → join → clean → keep newest.
 * Returns the response + the extraction-provenance flags (P1 fix lineage).
 */
export function extractResponse(proseTexts: string[]): {
  response: string;
  joinedProseBlocks: boolean;
  dedupedByContainment: boolean;
  truncatedFromEnd: boolean;
} {
  const filtered = filterProseTexts(proseTexts);
  const deduped = dedupeByContainment(filtered);
  let response = deduped.join('\n\n');
  if (response) response = cleanResponse(response);
  // Keep the NEWEST content: Perplexity keeps all prior turns in the DOM, so the
  // joined prose is oldest→newest. Slicing from the start would return stale
  // earlier turns and can drop the current answer entirely (Bug #2).
  const truncated = response.length > RESPONSE_CAP;
  response = response.slice(-RESPONSE_CAP);
  return {
    response,
    joinedProseBlocks: deduped.length > 0,
    dedupedByContainment: deduped.length < filtered.length || filtered.length > 0,
    truncatedFromEnd: truncated,
  };
}

/**
 * Extract agentic steps from body text (same patterns as the in-page script).
 * Returns deduped steps, newest last, capped at 5, each ≤100 chars.
 */
export function extractSteps(bodyText: string): { steps: string[]; currentStep: string } {
  const steps: string[] = [];
  for (const pattern of STEP_PATTERNS) {
    const matches = bodyText.match(pattern);
    if (matches) steps.push(...matches.map((s) => s.trim().substring(0, 100)));
  }
  const unique = [...new Set(steps)].slice(-5);
  return { steps: unique, currentStep: unique.length > 0 ? unique[unique.length - 1] : '' };
}

/**
 * Determine Perplexity status from page signals. Order matters — see the inline
 * comments (completion signals must win over working-text, because the answer
 * text itself often contains words like "Working"/"Searching"/"Analyzing").
 */
export function determineStatus(signals: {
  hasActiveStopButton: boolean;
  hasLoadingSpinner: boolean;
  bodyText: string;
}): 'idle' | 'working' | 'completed' {
  const { hasActiveStopButton, hasLoadingSpinner, bodyText: body } = signals;
  const hasStepsCompleted = /\d+ steps? completed/i.test(body);
  const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
  const hasReviewedSources = /Reviewed \d+ sources?/i.test(body);
  const hasAskFollowUp = body.includes('Ask a follow-up');
  const hasWorkingText = WORKING_PATTERNS.some((p) => body.includes(p));

  if (hasActiveStopButton || hasLoadingSpinner) return 'working';
  if (hasStepsCompleted || hasFinishedMarker) return 'completed';
  if (hasAskFollowUp && !hasActiveStopButton) return 'completed'; // "Ask a follow-up" appears only when done
  if (hasReviewedSources && !hasWorkingText && hasAskFollowUp) return 'completed';
  if (hasWorkingText) return 'working';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Grok-specific extraction (P2) — no stop button on the Fast model, so the
// streaming/completion signal is the "Working for Xs" / "Worked for Xs" timing
// line, which Grok renders INSIDE the assistant-message text. One answer = one
// [data-testid="assistant-message"] element (no nesting-dedupe problem).
// ---------------------------------------------------------------------------

/** Grok's streaming indicator ("Working for 3s") flips to "Worked for 3s" on completion. */
export const GROK_TIMING_LINE = /^(?:Work(?:ing|ed) for \d+s[\s\n]*)+/;

/**
 * Determine Grok status: "Working for Xs" → streaming; "Worked for Xs" (or
 * working indicator gone with non-empty message) → completed; else idle.
 */
export function determineGrokStatus(signals: {
  bodyText: string;
  lastMessageLen: number;
}): 'idle' | 'streaming' | 'completed' {
  const { bodyText, lastMessageLen } = signals;
  const hasWorking = /Working for \d+s/i.test(bodyText);
  const hasWorked = /Worked for \d+s/i.test(bodyText);
  if (hasWorking) return 'streaming';
  if (hasWorked || lastMessageLen > 0) return 'completed';
  return 'idle';
}

/**
 * Extract Grok's response: take the LAST assistant-message text (current turn),
 * strip the leading "Working for Xs"/"Worked for Xs" timing line, clean.
 * Returns response + provenance flags.
 */
export function extractGrokResponse(assistantMessages: string[]): {
  response: string;
  joinedProseBlocks: boolean;
  dedupedByContainment: boolean;
  truncatedFromEnd: boolean;
} {
  const last = assistantMessages[assistantMessages.length - 1] ?? '';
  // strip the timing line that Grok renders at the start of the message
  let response = last.replace(GROK_TIMING_LINE, '');
  if (response) response = cleanResponse(response);
  const truncated = response.length > RESPONSE_CAP;
  response = response.slice(-RESPONSE_CAP);
  return {
    response,
    joinedProseBlocks: response.length > 0,
    dedupedByContainment: assistantMessages.length > 1,
    truncatedFromEnd: truncated,
  };
}
