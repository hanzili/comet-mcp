import { describe, it, expect } from 'vitest';
import { redactUrls, isDebugEnabled, formatCaughtError } from '../../src/util/format.js';

describe('redactUrls', () => {
  it('replaces http URLs and the path that follows', () => {
    // The regex captures everything up to whitespace/parens, so the path
    // part of the URL is consumed too. That is intentional: we want to
    // strip session tokens that may appear in query strings.
    expect(redactUrls('GET http://127.0.0.1:9222/json/version failed'))
      .toBe('GET [url] failed');
  });

  it('replaces https URLs and the path that follows', () => {
    expect(redactUrls('WebSocket https://example.com:9222/path was closed'))
      .toBe('WebSocket [url] was closed');
  });

  it('replaces ws:// URLs and the path that follows', () => {
    expect(redactUrls('ws://127.0.0.1:9222/devtools/browser/abc CLOSED'))
      .toBe('[url] CLOSED');
  });

  it('leaves non-URL text alone', () => {
    expect(redactUrls('Permission denied on file'))
      .toBe('Permission denied on file');
  });

  it('stops at a closing parenthesis', () => {
    // Real CDP error: "WebSocket CLOSED (see ws://127.0.0.1:9222/log)"
    expect(redactUrls('WebSocket CLOSED (see ws://127.0.0.1:9222/log)'))
      .toBe('WebSocket CLOSED (see [url])');
  });

  it('redacts multiple URLs in one message', () => {
    const msg = 'Connect failed at http://a:1 and ws://b:2';
    expect(redactUrls(msg)).toBe('Connect failed at [url] and [url]');
  });

  it('does not match paths that look URL-ish but have no scheme', () => {
    expect(redactUrls('C:/Users/me/AppData/Comet')).toBe('C:/Users/me/AppData/Comet');
  });

  it('preserves trailing whitespace context', () => {
    // Text after URL on the same line is preserved; we only consume the URL itself.
    expect(redactUrls('Got 404 from http://api.test/users after timeout'))
      .toBe('Got 404 from [url] after timeout');
  });
});

describe('isDebugEnabled', () => {
  it('returns false when DEBUG is unset', () => {
    expect(isDebugEnabled({})).toBe(false);
  });

  it('returns false when DEBUG is empty', () => {
    expect(isDebugEnabled({ DEBUG: '' })).toBe(false);
  });

  it('returns false for common falsy literals', () => {
    expect(isDebugEnabled({ DEBUG: '0' })).toBe(false);
    expect(isDebugEnabled({ DEBUG: 'false' })).toBe(false);
    expect(isDebugEnabled({ DEBUG: 'no' })).toBe(false);
    expect(isDebugEnabled({ DEBUG: 'off' })).toBe(false);
  });

  it('returns true for common truthy literals', () => {
    expect(isDebugEnabled({ DEBUG: '1' })).toBe(true);
    expect(isDebugEnabled({ DEBUG: 'true' })).toBe(true);
    expect(isDebugEnabled({ DEBUG: 'yes' })).toBe(true);
    expect(isDebugEnabled({ DEBUG: 'on' })).toBe(true);
    expect(isDebugEnabled({ DEBUG: 'TRUE' })).toBe(true);
  });
});

describe('formatCaughtError', () => {
  it('returns the redacted message alone when debug is off', () => {
    const err = new Error('boom http://leak/x');
    expect(formatCaughtError(err, { debug: false })).toBe('boom [url]');
  });

  it('returns the raw input for non-Error throws when debug is off', () => {
    expect(formatCaughtError('plain string', { debug: false })).toBe('plain string');
  });

  it('appends stack frames when debug is on, skipping the first message line', () => {
    // Error.stack conventionally starts with "Error: <message>\n" then frames.
    // We want to surface only the frames, not the redundant message line.
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at a (a.ts:1:1)\n  at b (b.ts:2:2)\n  at c (c.ts:3:3)';
    const out = formatCaughtError(err, { debug: true, stackLines: 2 });
    expect(out).toBe('boom\n  at a (a.ts:1:1)\n  at b (b.ts:2:2)');
  });

  it('redacts URLs even when stack is present', () => {
    const err = new Error('fetch http://x.test/y');
    err.stack = 'Error: fetch http://x.test/y\n  at fetch (node:1:1)';
    const out = formatCaughtError(err, { debug: true });
    expect(out).not.toContain('http://');
    expect(out).toContain('[url]');
  });

  it('respects stackLines option', () => {
    const err = new Error('x');
    // No "Error:" prefix this time → split('\n').slice(0, 1) is the first frame only.
    err.stack = '1\n2\n3\n4\n5';
    const out = formatCaughtError(err, { debug: true, stackLines: 1 });
    expect(out).toBe('x\n1');
  });

  it('omits stack when debug is off even if err.stack exists', () => {
    const err = new Error('x');
    err.stack = 'x\n  at hidden';
    expect(formatCaughtError(err, { debug: false })).toBe('x');
  });

  it('handles non-Error throws', () => {
    expect(formatCaughtError(42, { debug: false })).toBe('42');
    expect(formatCaughtError({ toString: () => 'oops' }, { debug: false })).toBe('oops');
  });
});
