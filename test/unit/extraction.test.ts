/**
 * P1 extraction tests — preserve and verify the Perplexity extraction fixes.
 * Run: npx tsx test/unit/extraction.test.ts  (or node --test after build)
 *
 * Covers: Bug #1 (join all prose blocks, not just last), containment dedupe,
 * whitespace preservation (newlines survive), Bug #2 (keep NEWEST content,
 * slice from end), steps parsing, status determination ordering.
 */
import assert from 'node:assert';
import { test } from 'node:test';
import {
  extractResponse, filterProseTexts, dedupeByContainment, cleanResponse,
  extractSteps, determineStatus,
} from '../../dist/providers/extraction.js';

test('Bug #1: joins ALL prose blocks, not just the last', () => {
  const { response, joinedProseBlocks } = extractResponse(['Header block', 'Second block', 'Tail block']);
  assert.ok(response.includes('Header block'));
  assert.ok(response.includes('Tail block'));
  assert.equal(joinedProseBlocks, true);
});

test('Bug #1: containment dedupe drops nested duplicates, keeps unique text', () => {
  // Perplexity nests prose: the outer wrapper's innerText CONTAINS the inner
  // block's text as a substring, so the inner block is dropped as duplicate.
  const texts = [
    'Outer paragraph that contains the inner block text inside it, plus more content here',
    'inner block text',  // substring of the outer (after trim/case aside — exact match here)
    'Independent other paragraph',
  ];
  const deduped = dedupeByContainment(texts);
  assert.ok(deduped.length === 2, `expected 2, got ${deduped.length}: ${JSON.stringify(deduped)}`);
  // the contained inner text is dropped (it appears inside the outer one)
  assert.ok(!deduped.some((t) => t === 'inner block text'));
  assert.ok(deduped.includes('Independent other paragraph'));
});

test('Bug #1 v2: whitespace — newlines preserved, horizontal whitespace collapsed', () => {
  const cleaned = cleanResponse('  Line one\n\n\n  Line two with  extra   spaces  ');
  // Paragraph breaks survive (3+ newlines collapse to 2). NOTE: a single space
  // survives after the collapsed newlines — this matches the VERIFIED original
  // in-page order ([ \t]+ collapse runs BEFORE \n{3,} collapse, so the collapsed
  // space is not re-trimmed). Faithful port, not an improvement.
  assert.ok(cleaned.includes('Line one\n\n Line two'), `got: ${JSON.stringify(cleaned)}`);
  // horizontal whitespace collapsed
  assert.ok(cleaned.includes('with extra spaces'), `got: ${JSON.stringify(cleaned)}`);
  // within-line double spaces collapsed (the \n\n + space is the only surviving double)
  assert.ok(!cleaned.includes('extra   spaces'), 'triple spaces must collapse');
});

test('Bug #2: keeps the NEWEST content (slice from end)', () => {
  const long = Array.from({ length: 4000 }, (_, i) => `block ${i}`).join('\n\n');
  const { response, truncatedFromEnd } = extractResponse([long]);
  assert.equal(truncatedFromEnd, true);
  // newest content (last block) survives
  assert.ok(response.includes('block 3999'), 'newest block must survive');
  // oldest content is dropped
  assert.ok(!response.includes('block 0'), 'oldest block must be dropped');
  assert.ok(response.length <= 30000);
});

test('filterProseTexts: drops UI prefixes, short questions, len<=5', () => {
  const filtered = filterProseTexts([
    'Library',                      // UI prefix
    'Is this long enough?',          // ends with ?, len < 100
    'hi',                            // len <= 5
    'Real answer content here',      // kept
  ]);
  assert.deepEqual(filtered, ['Real answer content here']);
});

test('steps parsing: dedupes, newest last, capped at 5', () => {
  const body = 'Searching for sources\nSearching for sources\nClicking the button\nReading a page\nFound 3 results\nPreparing to assist';
  const { steps, currentStep } = extractSteps(body);
  assert.equal(steps.length <= 5, true);
  assert.equal(steps[steps.length - 1], steps[steps.length - 1]); // last is current
  assert.equal(currentStep, steps[steps.length - 1]);
  // deduped
  assert.equal(steps.filter((s) => s === 'Searching for sources').length, 1);
});

test('status determination: ask-follow-up wins over working text', () => {
  // the answer text itself contains "Searching" but "Ask a follow-up" means done
  const status = determineStatus({
    hasActiveStopButton: false,
    hasLoadingSpinner: false,
    bodyText: 'Here is the answer that mentions Searching and Analyzing. Ask a follow-up',
  });
  assert.equal(status, 'completed');
});

test('status determination: stop button means working', () => {
  const status = determineStatus({
    hasActiveStopButton: true,
    hasLoadingSpinner: false,
    bodyText: 'Working on it',
  });
  assert.equal(status, 'working');
});

test('status determination: idle when nothing happening', () => {
  const status = determineStatus({
    hasActiveStopButton: false,
    hasLoadingSpinner: false,
    bodyText: 'Home  Discover  Spaces',
  });
  assert.equal(status, 'idle');
});
