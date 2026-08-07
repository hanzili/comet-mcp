// Pure step extraction from `document.body.innerText`. Mirrors the logic
// previously inlined inside comet-ai.ts's getAgentStatus() template string.
// Extracted so tests can exercise it without spinning up CDP.

/**
 * Single combined regex matching any of the step-prefix verbs. Alternation
 * order is irrelevant for correctness — `match()` walks left-to-right and
 * finds each prefix at its position in the body.
 */
const STEP_REGEX = /(Preparing to assist|Reading|Clicking|Typing:|Navigating|Searching|Found)[^\n]*/g;

/**
 * Min chars after the action verb before a match counts as a real step.
 * Single-word matches like "Searching" alone (sidebar labels) are dropped.
 */
const MIN_STEP_LEN = 12;

const MAX_LEN = 100;

/**
 * Extract ordered, de-duplicated agent step strings from a body of text.
 *
 * Order is preserved by position within `body` (so "Searching, then
 * Clicking, then Searching again" comes out in that order, not all
 * "Searching" matches first). Duplicates are removed by a `Set` lookup.
 */
export function extractSteps(body: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  STEP_REGEX.lastIndex = 0;
  const matches = body.match(STEP_REGEX) ?? [];
  for (const m of matches) {
    const trimmed = m.trim();
    if (trimmed.length < MIN_STEP_LEN) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed.substring(0, MAX_LEN));
  }
  return ordered;
}
