import { describe, it, expect } from 'vitest';
import { extractSteps } from '../../src/util/steps.js';

describe('extractSteps', () => {
  it('returns empty array for empty body', () => {
    expect(extractSteps('')).toEqual([]);
  });

  it('returns empty array when no step patterns match', () => {
    expect(extractSteps('Just some plain text about a webpage.')).toEqual([]);
  });

  it('drops UI-only matches shorter than 12 chars', () => {
    // "Searching" alone is 9 chars — typical UI label.
    expect(extractSteps('Searching')).toEqual([]);
    expect(extractSteps('Reading')).toEqual([]);
    expect(extractSteps('Clicking')).toEqual([]);
  });

  it('keeps real steps with trailing context', () => {
    const body = 'Searching for NYTimes article about Comet';
    expect(extractSteps(body)).toEqual(['Searching for NYTimes article about Comet']);
  });

  it('preserves insertion order across patterns', () => {
    const body = 'Preparing to assist with query\nTyping: hello world';
    expect(extractSteps(body)).toEqual([
      'Preparing to assist with query',
      'Typing: hello world',
    ]);
  });

  it('deduplicates identical step text', () => {
    const body = 'Searching for foo\n\nSearching for foo\nSearching for bar';
    expect(extractSteps(body)).toEqual([
      'Searching for foo',
      'Searching for bar',
    ]);
  });

  it('truncates very long steps to 100 chars', () => {
    const long = 'Searching for ' + 'x'.repeat(200);
    const result = extractSteps(long);
    expect(result.length).toBe(1);
    expect(result[0]?.length).toBe(100);
    expect(result[0]?.startsWith('Searching for xxxx')).toBe(true);
  });

  it('captures all 7 action verbs', () => {
    const body = [
      'Preparing to assist with research',
      'Clicking submit button now',
      'Typing: the prompt text here',
      'Navigating to https://x.test',
      'Reading the article body',
      'Searching for cats videos',
      'Found 3 matches in document',
    ].join('\n');
    expect(extractSteps(body)).toHaveLength(7);
  });

  it('handles real-world Comet body with both signal and noise', () => {
    const body = `
      Library  Discover  Spaces  Finance  Account
      Searching
      Searching for Comet browser features
      Clicking next page
      Reading https://docs.perplexity.ai/features
      3 sources reviewed
      Clicking next page
    `.trim();
    const result = extractSteps(body);
    // "Searching" alone (UI label, 9 chars) is filtered.
    // "Searching for Comet browser features" is kept.
    // "Clicking next page" appears twice; dedup keeps one.
    // "Reading https://docs.perplexity.ai/features" is kept.
    expect(result).toEqual([
      'Searching for Comet browser features',
      'Clicking next page',
      'Reading https://docs.perplexity.ai/features',
    ]);
  });
});
