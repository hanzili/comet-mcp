import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getAuditLog,
  recordDecision,
  recordDenial,
  recordAllow,
  setMaxEntries,
} from '../../src/safety/audit-log.js';

describe('audit log', () => {
  beforeEach(() => {
    getAuditLog().clear();
  });

  afterEach(() => {
    // Reset cap so other test files aren't affected.
    setMaxEntries(500);
  });

  it('records a deny with reason and message', () => {
    const e = recordDenial(
      'comet_navigate',
      'chrome://settings',
      'internal-scheme',
      'Refusing to navigate to internal browser URL: chrome://settings',
    );
    expect(e.outcome).toBe('deny');
    expect(e.reason).toBe('internal-scheme');
    expect(e.url).toBe('chrome://settings');
    expect(e.caller).toBe('comet_navigate');
    expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records an allow without a reason', () => {
    const e = recordAllow('comet_navigate', 'https://example.com');
    expect(e.outcome).toBe('allow');
    expect(e.reason).toBeUndefined();
  });

  it('recent() returns newest-first', () => {
    recordAllow('a', 'https://1');
    recordAllow('b', 'https://2');
    recordAllow('c', 'https://3');
    const r = getAuditLog().recent(10);
    expect(r.map((e) => e.url)).toEqual(['https://3', 'https://2', 'https://1']);
  });

  it('respects the recent(n) limit', () => {
    for (let i = 0; i < 5; i++) recordAllow('a', `https://${i}`);
    expect(getAuditLog().recent(2).length).toBe(2);
  });

  it('filters by predicate', () => {
    recordAllow('a', 'https://good.com');
    recordDenial('a', 'chrome://x', 'internal-scheme', 'msg');
    recordDenial('b', 'file:///etc', 'file-scheme', 'msg');
    const denies = getAuditLog().filter((e) => e.outcome === 'deny');
    expect(denies.length).toBe(2);
    expect(denies.every((e) => e.reason !== undefined)).toBe(true);
  });

  it('ring buffer caps at maxEntries (FIFO eviction)', () => {
    // Tighten the cap so we don't have to insert 600 entries to test eviction.
    setMaxEntries(10);
    for (let i = 0; i < 25; i++) recordAllow('a', `https://${i}`);
    expect(getAuditLog().size()).toBe(10);
    const r = getAuditLog().recent(10);
    expect(r[0]?.url).toBe('https://24');
    expect(r[r.length - 1]?.url).toBe('https://15');
  });

  it('clear() wipes the buffer', () => {
    recordAllow('a', 'https://x');
    expect(getAuditLog().size()).toBe(1);
    getAuditLog().clear();
    expect(getAuditLog().size()).toBe(0);
  });

  it('caller field is recorded exactly as supplied', () => {
    recordDecision('my-custom-caller', 'https://x', 'allow');
    const r = getAuditLog().recent(1);
    expect(r[0]?.caller).toBe('my-custom-caller');
  });
});
