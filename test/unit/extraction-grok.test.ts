/**
 * P2 Grok extraction tests — verify the Grok-specific extraction and status logic.
 * Run: npm run build && node --experimental-strip-types --test test/unit/extraction-grok.test.ts
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { extractGrokResponse, determineGrokStatus } from '../../dist/providers/extraction.js';

test('Grok: takes the LAST assistant-message (current turn)', () => {
  const { response } = extractGrokResponse([
    'Worked for 2s\n\nEarlier answer content here',
    'Worked for 3s\n\nThe capital of France is Paris.',
  ]);
  assert.ok(response.includes('The capital of France is Paris.'), `got: ${JSON.stringify(response)}`);
  assert.ok(!response.includes('Earlier answer'), 'old turn must not appear');
});

test('Grok: strips the timing line from the response', () => {
  const { response } = extractGrokResponse(['Worked for 5s\n\nGravity is the fundamental force.']);
  assert.ok(!/Worked for \d+s/.test(response), `timing line survived: ${JSON.stringify(response)}`);
  assert.ok(response.includes('Gravity is the fundamental force.'));
});

test('Grok: handles multiple timing lines (working then worked)', () => {
  const { response } = extractGrokResponse(['Working for 1s\nWorking for 2s\nWorked for 3s\n\nFinal answer.']);
  assert.ok(!/Work(?:ing|ed) for \d+s/.test(response), `timing lines survived: ${JSON.stringify(response)}`);
  assert.ok(response.includes('Final answer.'));
});

test('Grok: empty messages produce empty response with no flags', () => {
  const { response, joinedProseBlocks } = extractGrokResponse([]);
  assert.equal(response, '');
  assert.equal(joinedProseBlocks, false);
});

test('Grok status: "Working for Xs" → streaming', () => {
  assert.equal(determineGrokStatus({ bodyText: 'Working for 3s', lastMessageLen: 0 }), 'streaming');
});

test('Grok status: "Worked for Xs" → completed', () => {
  assert.equal(determineGrokStatus({ bodyText: 'Worked for 3s\n\nAnswer', lastMessageLen: 20 }), 'completed');
});

test('Grok status: message present without timing line → completed', () => {
  assert.equal(determineGrokStatus({ bodyText: 'something', lastMessageLen: 10 }), 'completed');
});

test('Grok status: nothing happening → idle', () => {
  assert.equal(determineGrokStatus({ bodyText: '', lastMessageLen: 0 }), 'idle');
});
