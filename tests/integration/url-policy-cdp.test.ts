import { describe, it, expect } from 'vitest';
import { assertUrlAllowed, checkUrl, DEFAULT_POLICY } from '../../src/safety/url-policy.js';

describe('integration: policy gates Comet-style navigations', () => {
  it('default policy allows normal https navigation', () => {
    const r = checkUrl('https://www.perplexity.ai/search?q=hello');
    expect(r.allowed).toBe(true);
  });

  it('default policy blocks file:// access to credential stores', () => {
    const r = checkUrl('file:///C:/Users/x/AppData/Local/Google/Chrome/User Data/Default/Login Data');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('file-scheme');
  });

  it('default policy blocks downloading an .exe from any host', () => {
    const r = checkUrl('https://download.perplexity.ai/agent/installer.exe');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('dangerous-extension');
  });

  it('default policy does NOT block chrome:// (opt-in only)', () => {
    // Per current decision: internal URLs are off by default. Caller can
    // opt in via comet_set_url_policy with blockInternal: true.
    expect(checkUrl('chrome://settings').allowed).toBe(true);
    expect(checkUrl('chrome://password-manager/passwords').allowed).toBe(true);
  });

  it('opt-in: blockInternal: true blocks chrome:// settings', () => {
    const r = checkUrl('chrome://settings', { ...DEFAULT_POLICY, blockInternal: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('internal-scheme');
  });

  it('opt-in: blockInternal: true blocks chrome:// password-manager', () => {
    const r = checkUrl('chrome://password-manager/passwords', { ...DEFAULT_POLICY, blockInternal: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('internal-scheme');
  });

  it('assertUrlAllowed throws BlockedUrlError with useful message on a blocked URL', () => {
    let caught: unknown;
    try {
      assertUrlAllowed('https://x.com/installer.exe');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain('Refusing');
    expect((caught as Error).message).toContain('https://x.com/installer.exe');
  });

  it('confirm default policy is permissive on internal URLs', () => {
    expect(DEFAULT_POLICY.blockInternal).toBe(false);
    expect(DEFAULT_POLICY.blockFile).toBe(true);
    expect(DEFAULT_POLICY.blockDangerousExtensions).toBe(true);
  });
});
