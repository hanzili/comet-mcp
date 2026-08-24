/**
 * P2 fixture-driven tests — run the extraction + markdown pipelines against the
 * REAL sanitized DOM fixtures captured from live conversations
 * (test/fixtures/<provider>/completed.html), not synthetic strings.
 *
 * This protects against extraction logic drifting from the actual DOM shape the
 * drivers encounter. Run:
 *   npm run build && node --experimental-strip-types --test test/unit/fixture-driven.test.ts
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractGrokResponse, extractResponse } from '../../dist/providers/extraction.js';
import { htmlToMarkdown } from '../../dist/providers/markdown.js';

/** Minimal HTML → text, mirroring what the in-page collector gets via innerText. */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const fixtures = join('C:/Dev/Comet-mcp', 'test', 'fixtures');

test('fixture: grok completed.html — text extraction finds the answer', () => {
  const path = join(fixtures, 'grok', 'completed.html');
  assert.ok(existsSync(path), 'grok completed fixture must exist');
  const html = readFileSync(path, 'utf8');
  const text = htmlToText(html);
  assert.ok(text.includes('Paris'), `fixture text missing answer: "${text.slice(0, 120)}"`);
  // the extraction pipeline handles the raw text
  const { response } = extractGrokResponse([text]);
  assert.ok(response.includes('Paris'), `extraction lost answer: "${response.slice(0, 120)}"`);
});

test('fixture: grok completed.html — markdown conversion produces bullets', () => {
  const path = join(fixtures, 'grok', 'completed.html');
  const html = readFileSync(path, 'utf8');
  const md = htmlToMarkdown('grok', html);
  assert.ok(md, 'markdown must be produced');
  assert.ok(/^[-*] /m.test(md), `expected bullet list, got: ${JSON.stringify((md || '').slice(0, 200))}`);
  assert.ok((md || '').includes('Paris'));
});

test('fixture: perplexity completed.html — text extraction finds the answer', () => {
  const path = join(fixtures, 'perplexity', 'completed.html');
  assert.ok(existsSync(path), 'perplexity completed fixture must exist');
  const html = readFileSync(path, 'utf8');
  const text = htmlToText(html);
  assert.ok(text.includes('Paris'), `fixture text missing answer: "${text.slice(0, 120)}"`);
  const { response } = extractResponse([text]);
  assert.ok(response.includes('Paris'), `extraction lost answer: "${response.slice(0, 120)}"`);
});

test('fixture: perplexity completed.html — markdown conversion works', () => {
  const path = join(fixtures, 'perplexity', 'completed.html');
  const html = readFileSync(path, 'utf8');
  const md = htmlToMarkdown('perplexity', html);
  assert.ok(md && md.length > 0, 'markdown must be produced');
  assert.ok((md || '').includes('Paris'));
});

test('fixture: grok streaming.html — shows the working indicator (state fixture integrity)', () => {
  const path = join(fixtures, 'grok', 'streaming.html');
  const html = readFileSync(path, 'utf8');
  assert.ok(/Working for \d+s/.test(htmlToText(html)), 'streaming fixture must contain the working indicator');
});

test('fixture: all providers have completed fixtures (capability evidence)', () => {
  for (const prov of ['perplexity', 'grok', 'gemini', 'chatgpt', 'claude']) {
    assert.ok(existsSync(join(fixtures, prov, 'completed.html')), `${prov} completed fixture missing`);
  }
});
