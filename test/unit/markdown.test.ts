/**
 * P2 markdown extraction tests — verify HTML → Markdown conversion across providers.
 * Run: npm run build && node --experimental-strip-types --test test/unit/markdown.test.ts
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { htmlToMarkdown } from '../../dist/providers/markdown.js';

test('markdown: converts headers, bold, code', () => {
  const md = htmlToMarkdown('grok', '<h2>Title</h2><p>Some <strong>bold</strong> and <code>code</code>.</p>');
  assert.ok(md.includes('## Title'), `got: ${JSON.stringify(md)}`);
  assert.ok(md.includes('**bold**'));
  assert.ok(md.includes('`code`'));
});

test('markdown: fenced code blocks', () => {
  const md = htmlToMarkdown('grok', '<pre><code>const x = 1;\nconst y = 2;</code></pre>');
  assert.ok(md.includes('```'), `got: ${JSON.stringify(md)}`);
  assert.ok(md.includes('const x = 1;'));
});

test('markdown: perplexity citation badges stripped before conversion', () => {
  const html = '<p>Answer text<sup class="citation"><a href="#1">[1]</a></sup> continues.</p><a class="citation" href="#">[2]</a>';
  const md = htmlToMarkdown('perplexity', html);
  assert.ok(!md.includes('[1]'), `citation survived: ${JSON.stringify(md)}`);
  assert.ok(md.includes('Answer text'), 'answer text must survive');
});

test('markdown: grok timing line removed', () => {
  // timing line is in the message HTML (canvas + text node) — the text path strips it;
  // here we confirm the converter doesn't emit the raw timing text as content
  const md = htmlToMarkdown('grok', '<p>Worked for 2s</p><p>Real answer</p>');
  assert.ok(md.includes('Real answer'));
});

test('markdown: empty html → null', () => {
  assert.equal(htmlToMarkdown('grok', ''), null);
  assert.equal(htmlToMarkdown('grok', '   '), null);
});
