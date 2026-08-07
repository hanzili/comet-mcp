/**
 * P3 — per-target CDP session pool.
 *
 * Audit finding F1 (docs/reference/08-p3-dispatcher-tab-audit.md): the P2 dispatcher
 * routed every provider through ONE global CDP connection (cometClient singleton), so
 * a second provider's open() silently killed the first provider's session. The P0 spike
 * proved the endpoint sustains ≥5 independent per-target sessions with zero cross-tab
 * interference — this pool is that pattern made product.
 *
 * Design:
 *  - ONE chrome-remote-interface client PER TARGET, held in Map<targetId, handle>.
 *  - Browser-level (stateless HTTP) ops — listing tabs, opening tabs — stay on the
 *    shared CometCDPClient (they never touch the singleton's connection).
 *  - Per-target control (evaluate / safeEvaluate / pressKey / navigate / screenshot)
 *    goes through the pool handle, so providers are isolated by tab (ADR 0001 §Transport 2).
 *  - Cap enforcement (P0: default 5, configurable): the N+1 open fails with
 *    `tab_cap_exceeded` rather than silently degrading.
 */

import CDP from "chrome-remote-interface";
import { cometClient } from "./cdp-client.js";
import type { CDPTarget, EvaluateResult, NavigateResult, ScreenshotResult } from "./types.js";

export const DEFAULT_TAB_CAP = 5;

/** Enforced cap — overridable via COMET_TAB_CAP for opt-in stress testing (P0 decision). */
export const TAB_CAP = (() => {
  const raw = process.env.COMET_TAB_CAP;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TAB_CAP;
})();

export class TabCapExceededError extends Error {
  constructor(public cap: number) {
    super(`tab_cap_exceeded: ${cap} concurrent CDP sessions are the measured safe limit (COMET_TAB_CAP to override)`);
    this.name = 'TabCapExceededError';
  }
}

/**
 * One CDP session bound to one target. Mirrors the cometClient surface for exactly the
 * ops drivers use, so driver refactors are mechanical (cometClient.X → handle.X).
 */
export interface TabCDPHandle {
  targetId: string;
  /** Real per-target session address (WebSocket URL) — replaces the fake 'comet-client'. */
  wsUrl: string;
  /** Human label from the target list. */
  title: string;
  url: string;
  /** Raw CDP client (exposed for advanced use; drivers should prefer the wrapped methods). */
  cdp: CDP.Client;
  isHealthy(): Promise<boolean>;
  evaluate(expression: string): Promise<EvaluateResult>;
  safeEvaluate(expression: string): Promise<EvaluateResult>;
  pressKey(key: string): Promise<void>;
  navigate(url: string, waitForLoad?: boolean): Promise<NavigateResult>;
  screenshot(format?: 'png' | 'jpeg'): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

export class TabSessionPool {
  private sessions = new Map<string, TabCDPHandle>();
  readonly cap: number = TAB_CAP;

  /** All registered target ids (order of acquisition). */
  list(): string[] {
    return [...this.sessions.keys()];
  }

  get(targetId: string): TabCDPHandle | null {
    return this.sessions.get(targetId) ?? null;
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Acquire (or reuse) a CDP session for a target. Fails with TabCapExceededError when
   * the pool is at cap and the target is not already pooled — never silently degrades.
   */
  async acquire(target: CDPTarget): Promise<TabCDPHandle> {
    const existing = this.sessions.get(target.id);
    if (existing) return existing;

    if (this.sessions.size >= this.cap) {
      throw new TabCapExceededError(this.cap);
    }

    const handle = await this.open(target);
    this.sessions.set(target.id, handle);
    return handle;
  }

  /** Reconnect a pooled session after health failure (per-tab, siblings untouched). */
  async reconnect(targetId: string): Promise<TabCDPHandle> {
    const old = this.sessions.get(targetId);
    if (old) {
      try { await old.close(); } catch { /* ignore */ }
      this.sessions.delete(targetId);
    }
    const target = await this.findTarget(targetId);
    if (!target) throw new Error(`target gone: ${targetId}`);
    const handle = await this.open(target);
    this.sessions.set(targetId, handle);
    return handle;
  }

  /** Close and drop one tab's session. Returns false if it was not pooled. */
  async release(targetId: string): Promise<boolean> {
    const handle = this.sessions.get(targetId);
    if (!handle) return false;
    this.sessions.delete(targetId);
    try { await handle.close(); } catch { /* ignore */ }
    return true;
  }

  /** Close every pooled session (server shutdown / comet_connect). */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((h) => h.close().catch(() => {})));
    this.sessions.clear();
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private async open(target: CDPTarget): Promise<TabCDPHandle> {
    if (!target.webSocketDebuggerUrl) {
      throw new Error(`target ${target.id} has no webSocketDebuggerUrl — cannot open session`);
    }
    const cdp = await CDP({ host: '127.0.0.1', target: target.id });
    await Promise.all([
      cdp.Page.enable(),
      cdp.Runtime.enable(),
      cdp.DOM.enable(),
      cdp.Network.enable(),
    ]);
    // consistent window size (same as cometClient.connect) — best effort
    try {
      const { windowId } = await (cdp as any).Browser.getWindowForTarget({ targetId: target.id });
      await (cdp as any).Browser.setWindowBounds({
        windowId,
        bounds: { width: 1440, height: 900, windowState: 'normal' },
      });
    } catch {
      try {
        await (cdp as any).Emulation.setDeviceMetricsOverride({
          width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
        });
      } catch { /* continue */ }
    }

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try { await cdp.close(); } catch { /* ignore */ }
    };

    const evaluate = async (expression: string): Promise<EvaluateResult> => {
      const r = await cdp.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
      return r as unknown as EvaluateResult;
    };

    const isHealthy = async (): Promise<boolean> => {
      try {
        const r = await Promise.race([
          cdp.Runtime.evaluate({ expression: '1+1', returnByValue: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('health timeout')), 3000)),
        ]);
        return (r as any)?.result?.value === 2;
      } catch {
        return false;
      }
    };

    const safeEvaluate = async (expression: string): Promise<EvaluateResult> => {
      if (!(await isHealthy())) {
        throw new Error(`CDP session unhealthy (target ${target.id}) — call reconnect`);
      }
      return evaluate(expression);
    };

    const pressKey = async (key: string): Promise<void> => {
      await cdp.Input.dispatchKeyEvent({ type: 'keyDown', key });
      await cdp.Input.dispatchKeyEvent({ type: 'keyUp', key });
    };

    const navigate = async (url: string, waitForLoad = true): Promise<NavigateResult> => {
      const result = await cdp.Page.navigate({ url });
      if (waitForLoad) await cdp.Page.loadEventFired();
      return result as unknown as NavigateResult;
    };

    const screenshot = async (format: 'png' | 'jpeg' = 'png'): Promise<ScreenshotResult> => {
      return cdp.Page.captureScreenshot({ format }) as unknown as ScreenshotResult;
    };

    return {
      targetId: target.id,
      wsUrl: target.webSocketDebuggerUrl,
      title: target.title,
      url: target.url,
      cdp,
      isHealthy,
      evaluate,
      safeEvaluate,
      pressKey,
      navigate,
      screenshot,
      close,
    };
  }

  private async findTarget(targetId: string): Promise<CDPTarget | null> {
    const targets = await cometClient.listTargets();
    return targets.find((t) => t.id === targetId) ?? null;
  }
}

/** Singleton pool — the per-target counterpart to cometClient. */
export const sessionPool = new TabSessionPool();
