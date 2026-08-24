/**
 * P3 — tab registry: Map<tabId, TabSession> + per-provider tab resolution.
 *
 * Audit findings F2/F3/F5 (docs/reference/08-p3-dispatcher-tab-audit.md): the P2
 * dispatcher had no tab identity — open() reconnected a global CDP client to whatever
 * tab it happened to find, and comet_connect closed ALL tabs except one. This module is
 * the addressing layer the critique demanded: providerKey → tabId → session.
 *
 * Responsibilities:
 *  - Resolve a provider's tab (existing → reuse; missing → open entry URL).
 *  - Register TabSession records with REAL per-target session ids (cdpSessionId = wsUrl).
 *  - Last-tab protection: never close the last open tab of a provider — reset it instead
 *    (closing it would log the user out / lose the session; ADR 0001 §Safeguards 2).
 *  - Scoped reset: reset() touches only the target tab, never sibling provider tabs.
 *  - Dedup anchors on TabSession are populated by drivers via updateSession().
 */

import { sessionPool, TabCapExceededError } from './cdp-pool.js';
import { cometClient } from './cdp-client.js';
import { loadEntry } from './core/registry.js';
import { getCursor } from './core/event-store.js';
import type { TabSession } from './types/provider.js';
import type { ProviderId } from './types/conversation.js';
import type { CDPTarget } from './types.js';

/** Provider → URL for opening tabs. 2026-08-10 (ADR 0012): the session URL is
 * READ from the live tab the user started (project/Gem with the status-line
 * Custom Instruction) — captured on TabSession at pool time, used by reset /
 * new-tab opens. This function is the FALLBACK (no session URL known yet):
 * entry URL, then per-provider fallbacks.
 */
function entryUrlFor(provider: ProviderId): string {
  const e = loadEntry(provider);
  if (e?.url) return e.url;
  const FALLBACKS: Record<ProviderId, string> = {
    perplexity: 'https://www.perplexity.ai/',
    grok: 'https://grok.com/',
    gemini: 'https://gemini.google.com/app',
    chatgpt: 'https://chatgpt.com/',
    claude: 'https://claude.ai/new',
  };
  return FALLBACKS[provider] ?? 'https://www.perplexity.ai/';
}

/** URL pattern for recognizing a provider's tab among open targets. */
function urlPatternFor(provider: ProviderId): RegExp {
  const PATTERNS: Record<ProviderId, RegExp> = {
    perplexity: /perplexity\.ai/,
    grok: /grok\.com/,
    gemini: /gemini\.google/,
    chatgpt: /chatgpt\.com/,
    claude: /claude\.ai/,
  };
  return PATTERNS[provider] ?? /perplexity\.ai/;
}

export class TabRegistry {
  /** tabId → session. tabId is the CDP target id — the address key (audit F4). */
  private tabs = new Map<string, TabSession>();
  /** provider → tabId (one registered tab per provider in v1; multiple allowed). */
  private providerTabs = new Map<ProviderId, string[]>();
  /**
   * Reset observers (2026-08-10, ADR 0011 session-sentinel bug): called after a
   * tab reset navigates to a fresh thread. The per-tab session sentinel is a
   * THREAD convention — a reset kills the thread, so the next ask must re-inject
   * the status-line instruction with a NEW sentinel. Without this, the first ask
   * in a reset tab was sent RAW (no status-line section) and the ADR 0011
   * reminder fired on the tokenless completion (perplexity live bug).
   */
  private resetObservers: Array<(tabId: string) => void> = [];

  /** Subscribe to tab resets (drivers use this to invalidate per-thread state). */
  onReset(observer: (tabId: string) => void): void {
    this.resetObservers.push(observer);
  }


  // ---------------------------------------------------------------------------
  // query
  // ---------------------------------------------------------------------------

  list(): TabSession[] {
    return [...this.tabs.values()];
  }

  get(tabId: string): TabSession | null {
    return this.tabs.get(tabId) ?? null;
  }

  /**
   * Default tab for a provider: prefer the most-recently-completed tab (fix
   * 2026-08-07 — the old first-tab-wins default made default asks hit a stale tab
   * and gateway-timeout while a fresher tab would have answered), falling back to
   * the first non-closed tab.
   */
  getProviderTab(provider: ProviderId): TabSession | null {
    const ids = this.providerTabs.get(provider);
    if (!ids?.length) return null;
    const open = ids.map((id) => this.tabs.get(id)).filter((s): s is TabSession => !!s && s.state !== 'closed');
    if (open.length === 0) return null;
    // most recent completed wins; tie-break by newest openedAt
    return [...open].sort((a, b) => {
      const aDone = a.lastCompletedAt ?? '';
      const bDone = b.lastCompletedAt ?? '';
      if (aDone !== bDone) return aDone < bDone ? 1 : -1;
      return a.openedAt < b.openedAt ? 1 : -1;
    })[0];
  }

  /** All target ids (pool keys) for a provider. */
  targetsFor(provider: ProviderId): string[] {
    return this.providerTabs.get(provider) ?? [];
  }

  // ---------------------------------------------------------------------------
  // open / close / reset
  // ---------------------------------------------------------------------------

  /**
   * Open (or reuse) the provider's tab and ensure a pooled CDP session. Returns the
   * registered TabSession. Throws TabCapExceededError when the pool cap is hit.
   */
  async open(provider: ProviderId, opts: { newTab?: boolean } = {}): Promise<TabSession> {
    // reuse an existing registered session when not forcing a new tab
    if (!opts.newTab) {
      const existing = this.getProviderTab(provider);
      if (existing) {
        // ensure the pool still holds a live session for it
        if (!sessionPool.get(existing.targetId)) {
          await this.poolTab(provider, existing.targetId);
        }
        return existing;
      }
    }

    // Cap guard BEFORE creating a browser tab: a new-tab open creates the tab via
    // cometClient.newTab() first, so if the pool acquire throws afterward the tab
    // leaks as an unregistered browser target (found live 2026-08-07: 6th open
    // left an orphan claude.ai/new tab that closeTab could not close). Check the
    // cap up front — fail clean, no side effects.
    if (sessionPool.size >= sessionPool.cap) {
      throw new TabCapExceededError(sessionPool.cap);
    }

    const target = opts.newTab
      ? await this.openNewProviderTab(provider)
      : (await this.findProviderTab(provider)) ?? (await this.openNewProviderTab(provider));

    await this.poolTab(provider, target.id);
    return this.tabs.get(target.id)!;
  }

  /** Pool an existing target (already registered or discovered in the browser). */
  async poolTab(provider: ProviderId, targetId: string): Promise<TabSession> {
    const targets = await cometClient.listTargets();
    const target = targets.find((t) => t.id === targetId);
    if (!target) throw new Error(`target not found: ${targetId}`);
    const handle = await sessionPool.acquire(target);

    const existing = this.tabs.get(targetId);
    const session: TabSession = existing ?? {
      provider,
      tabId: targetId,
      targetId,
      cdpSessionId: handle.wsUrl, // real per-target session address (audit F4)
      openedAt: new Date().toISOString(),
      state: 'connected',
    };
    session.provider = provider;
    session.state = 'connected';
    // 2026-08-10 (ADR 0012 user directive): READ the session URL from the LIVE
    // tab — the user starts the session in a perplexity PROJECT or gemini GEM
    // where the status-line Custom Instruction is set up manually. Never
    // hardcoded; new sessions (newChat / reset / fresh tab) start at this URL.
    if (target.url && target.url !== 'about:blank') {
      session.sessionUrl = target.url;
    }
    // P3 reconnect-dedup: hydrate dedup anchors from the DURABLE store so a
    // re-opened / reconnected session starts from the last recorded extraction
    // cursor — "unchanged content produces no new response event".
    const durableCursor = getCursor(provider, targetId);
    if (durableCursor) {
      session.extractionCursor = durableCursor;
      session.lastContentHash = durableCursor; // cursor == contentHash convention
    }
    this.tabs.set(targetId, session);

    const list = this.providerTabs.get(provider) ?? [];
    if (!list.includes(targetId)) list.push(targetId);
    this.providerTabs.set(provider, list);
    return session;
  }

  /**
   * P3 reconnect-dedup: force a fresh pooled CDP session for a provider's tab and
   * re-hydrate its dedup anchors from the durable store. Returns the session.
   * If the tab is gone, falls back to opening a fresh one.
   */
  async reconnect(provider: ProviderId): Promise<TabSession> {
    const session = this.getProviderTab(provider);
    if (!session) return this.open(provider);
    try {
      await sessionPool.reconnect(session.targetId);
    } catch {
      // target gone — open a fresh tab
      this.tabs.delete(session.targetId);
      this.providerTabs.set(provider, (this.providerTabs.get(provider) ?? []).filter((id) => id !== session.targetId));
      return this.open(provider);
    }
    session.state = 'connected';
    const durableCursor = getCursor(provider, session.targetId);
    if (durableCursor) {
      session.extractionCursor = durableCursor;
      session.lastContentHash = durableCursor;
    }
    return session;
  }

  /**
   * Close a tab with last-tab protection: the LAST open tab of a provider is reset
   * (navigated to entry URL) instead of closed — closing it would destroy the user's
   * login session and orphan the provider. Returns {closed, reset}.
   */
  async close(tabId: string, opts: { force?: boolean } = {}): Promise<{ closed: boolean; reset: boolean; session: TabSession | null }> {
    const session = this.tabs.get(tabId);
    if (!session) return { closed: false, reset: false, session: null };

    const provider = session.provider;
    const providerIds = (this.providerTabs.get(provider) ?? []).filter((id) => this.tabs.get(id)?.state !== 'closed');
    const isLastForProvider = providerIds.length <= 1 || (providerIds.length === 1 && providerIds[0] === tabId);

    if (isLastForProvider && !opts.force) {
      // last-tab protection: reset instead of close
      await this.reset(tabId);
      session.state = 'connected';
      return { closed: false, reset: true, session };
    }

    this.tabs.delete(tabId);
    this.providerTabs.set(provider, (this.providerTabs.get(provider) ?? []).filter((id) => id !== tabId));
    const released = await sessionPool.release(tabId);
    if (released) {
      try { await cometClient.closeTab(tabId); } catch { /* tab may be gone */ }
    }
    return { closed: released, reset: false, session: { ...session, state: 'closed' } };
  }

  /** Scoped reset: only the target tab is navigated; sibling provider tabs untouched. */
  async reset(tabId: string): Promise<void> {
    const session = this.tabs.get(tabId);
    if (!session) throw new Error(`no session for tab: ${tabId}`);
    const handle = sessionPool.get(tabId);
    if (!handle) throw new Error(`no pooled session for tab: ${tabId} — reopen with provider_open`);
    // 2026-08-10 (ADR 0012): start the new session at the URL the user started
    // this one at (the project/Gem with the Custom Instruction) — read from the
    // live tab at open, never hardcoded; fall back to the entry URL.
    await handle.navigate(session.sessionUrl ?? entryUrlFor(session.provider), true);
    await new Promise((r) => setTimeout(r, 1500));
    // 2026-08-10: the thread is dead — notify observers so per-thread state
    // (session sentinel) is invalidated before the next ask re-injects it.
    for (const observer of this.resetObservers) {
      try { observer(tabId); } catch { /* observer errors must not break the reset */ }
    }
  }

  /** Drop all registry entries and pooled sessions (server shutdown). */
  async closeAll(): Promise<void> {
    await sessionPool.closeAll();
    this.tabs.clear();
    this.providerTabs.clear();
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private async findProviderTab(provider: ProviderId): Promise<CDPTarget | null> {
    const targets = await cometClient.listTargets();
    const re = urlPatternFor(provider);
    return targets.find((t) => t.type === 'page' && re.test(t.url) && t.url !== 'about:blank') ?? null;
  }

  private async openNewProviderTab(provider: ProviderId): Promise<CDPTarget> {
    // 2026-08-10 (ADR 0012): a fresh tab starts at the provider's SESSION URL
    // (the project/Gem with the Custom Instruction, read from the live tab the
    // user opened) when one is known — else the entry URL.
    const sessionUrl = (this.providerTabs.get(provider) ?? [])
      .map((id) => this.tabs.get(id))
      .filter((s): s is TabSession => !!s && !!s.sessionUrl)
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0]?.sessionUrl;
    const url = sessionUrl ?? entryUrlFor(provider);
    return cometClient.newTab(url);
  }
}

/** Singleton registry — the P3 addressing layer. */
export const tabRegistry = new TabRegistry();
