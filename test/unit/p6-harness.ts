/**
 * P6 state-machine test harness (Grok design review D3 — approved): run the
 * drivers' REAL in-page scripts against fixture HTML via jsdom, instead of
 * string-matching fakes. The driver methods execute through a fake TabCDPHandle
 * whose evaluate() evaluates the injected expression inside a jsdom window.
 */

import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TabCDPHandle } from '../../src/cdp-pool.js';
import type { EvaluateResult } from '../../src/types.js';

export interface FakeHandle extends TabCDPHandle {
  pressCalls: string[];
  dom: JSDOM;
}

/**
 * Build a fake CDP handle backed by fixture HTML.
 * - evaluate() runs expressions inside the jsdom window (the real scripts).
 * - execCommand is shimmed (jsdom does not implement it) so insertText typing
 *   succeeds, mirroring a real browser.
 * - pressKey records calls; with `pressClearsComposer` set to a selector, it also
 *   clears that composer (simulating a real Enter-submit).
 */
export function makeHandle(
  fixtureHtml: string,
  opts: { pressClearsComposer?: string } = {},
): FakeHandle {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${fixtureHtml}</body></html>`, {
    runScripts: 'dangerously', // fixtures are ours — inline onclick handlers (send buttons) must execute
    url: 'https://fixture.test/',
  });
  const win = dom.window as unknown as Window & { execCommandShim: boolean };
  (win.document as any).execCommand = (cmd: string, _ui: unknown, text?: string) => {
    // jsdom has no execCommand. Simulate insertText by writing into the focused
    // editable (browser semantics) — the real in-page scripts and the
    // promptLandedIn guard (2026-08-10) read innerText back after typing.
    if (cmd === 'insertText' && typeof text === 'string') {
      const active = (win as any).document.activeElement;
      if (active && (active.getAttribute('contenteditable') === 'true' || active.matches('[contenteditable]'))) {
        active.textContent = (active.textContent || '') + text;
      } else if (active && ('value' in active)) {
        active.value = (active.value || '') + text;
      }
    }
    return true;
  };

  // jsdom lacks innerText and always-null offsetParent — shim to browser semantics
  // so the real in-page scripts (which read innerText / offsetParent) behave as
  // they would in Chrome. textContent approximates innerText (fixtures have no
  // visibility-hidden content); offsetParent is null only for display:none/fixed.
  (win.HTMLElement.prototype as any).__defineGetter__('innerText', function (this: any) {
    return this.textContent;
  });
  (win.HTMLElement.prototype as any).__defineSetter__('innerText', function (this: any, v: string) {
    this.textContent = v;
  });
  (win.HTMLElement.prototype as any).__defineGetter__('offsetParent', function (this: any) {
    const cs = win.getComputedStyle(this);
    if (cs.display === 'none' || cs.position === 'fixed') return null;
    return this.parentElement;
  });

  const pressCalls: string[] = [];

  const evalInPage = (expression: string): EvaluateResult => {
    try {
      const value = (win as any).eval(expression);
      return { result: { type: 'object', value } } as EvaluateResult;
    } catch {
      return { result: { value: null } } as EvaluateResult;
    }
  };

  const handle: FakeHandle = {
    pressCalls,
    dom,
    async evaluate(expression: string): Promise<EvaluateResult> {
      return evalInPage(expression);
    },
    async safeEvaluate(expression: string): Promise<EvaluateResult> {
      return evalInPage(expression);
    },
    async pressKey(key: string): Promise<void> {
      pressCalls.push(key);
      if (opts.pressClearsComposer) {
        const el = (win as any).document.querySelector(opts.pressClearsComposer);
        if (el) {
          if ('value' in el) el.value = '';
          if ('innerText' in el) el.innerText = '';
        }
      }
    },
    async navigate(): Promise<{ ok: boolean }> {
      return { ok: true };
    },
  };
  return handle;
}

/** Minimal TabSession for driver calls (pool lookup is patched by the tests). */
export function testSession(provider: string): any {
  return {
    provider,
    tabId: 'test-tab',
    targetId: 'test-target',
    cdpSessionId: 'test-cdp',
    openedAt: new Date().toISOString(),
    state: 'connected',
  };
}

export const FIXTURES = 'C:/Dev/comet-mcp/test/fixtures';

export function fixture(provider: string, name: string): string {
  const p = join(FIXTURES, provider, name);
  if (!existsSync(p)) throw new Error(`fixture missing: ${p}`);
  return readFileSync(p, 'utf8');
}
