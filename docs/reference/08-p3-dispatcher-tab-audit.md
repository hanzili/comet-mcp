# P3 Dispatcher Tab-Addressing Audit

- **Date:** 2026-08-07
- **Status:** COMPLETE — findings confirmed from code (fork `main` @ `58dd895`)
- **Trigger:** Perplexity critique (2026-08-07): *"P3 has a hidden prerequisite: the P2 dispatcher shipped provider_ask/poll/stop before the registry exists, so it likely encodes a one-tab-per-provider singleton assumption. Audit it before P3, since the registry changes addressing from providerKey to tabId."*
- **Related:** [ADR 0001](../adr/0001-browser-tab-transport-and-relay-defaults.md), [P0 concurrency findings](../p0-cdp-concurrency-findings.md), [Perplexity critique](../reference/06-provider-critiques/2026-08-07-perplexity-critique.md)

## Verdict

**Confirmed: the P2 dispatcher encodes a hard one-tab-per-provider singleton, and worse — a one-tab-*global* singleton shared across ALL providers.** Two providers cannot operate concurrently on the current code. The audit finds exactly what the critique suspected, plus one structural root cause that makes the fix non-trivial: the drivers do not own their CDP connection at all.

## Findings

### F1. One global CDP connection, one global target (root cause)

`src/cdp-client.ts` exports a **module-level singleton** `cometClient = new CometCDPClient()`. The class holds a **single** `private client: CDP.Client | null` and a single `lastTargetId`. `connect(targetId?)`:

```ts
async connect(targetId?: string): Promise<string> {
  if (this.client) {
    await this.disconnect();   // <-- any existing session is torn down
  }
  ...
  this.client = await CDP(options);
```

So at any moment there is exactly **one CDP WebSocket to exactly one tab**, and calling `connect()` for provider B silently kills provider A's session. There is no session pool, no multi-target routing. `safeEvaluate`, `evaluate`, `pressKey`, `navigate`, `screenshot` all operate on that single client — they are **not** session-scoped.

### F2. Both drivers call the global connect() in open(), with no per-tab routing

`src/drivers/perplexity.ts` `open()`:

```ts
await cometClient.connect();              // no targetId — "best target" fallback
const tabs = await cometClient.listTabsCategorized();
const targetId = tabs.main?.id ?? undefined;   // then reads which tab it *happened* to get
return { provider: 'perplexity', tabId: targetId ?? 'unknown', targetId: targetId ?? '', cdpSessionId: 'comet-client', ... };
```

Two problems:
- `connect()` with no target falls back to *"first perplexity.ai page, else first non-about:blank page"* (`reconnect()`/`connect()` best-target logic). It does **not** verify the connected tab is a Perplexity tab.
- `tabId`/`targetId` are **read back after the fact** rather than driving the connection. The session claims `cdpSessionId: 'comet-client'` — a hardcoded constant, not a real CDP session id, and it's identical for every provider.

`src/drivers/grok.ts` `open()` is slightly better — it locates a `grok.com` tab first:

```ts
const targets = await cometClient.listTargets();
const grokTab = targets.find((t) => t.type === 'page' && /grok\.com/.test(t.url));
if (grokTab) await cometClient.connect(grokTab.id);
```

…but it still routes through the same single global connection, and still hardcodes `cdpSessionId: 'comet-client'`.

### F3. Concurrent use = silent cross-tab interference (the P3 gate breaker)

`askAndWait` (`src/drivers/index.ts`) calls `driver.open()` at the start, then `driver.poll(session)` in a loop. Every `open()` re-runs `connect()`. Sequence that breaks:

1. `provider_ask perplexity` → `open()` connects to perplexity tab, starts polling.
2. `provider_ask grok` (or any second call) → `grok.open()` → `connect(grokTab.id)` **disconnects the perplexity session**.
3. Perplexity's next `poll()` evaluates the Grok poll script against the Grok tab (wrong selectors → empty extraction) or throws "not connected".

Result: two providers cannot be asked concurrently, and a second ask **corrupts** the first — silent cross-tab interference, which is exactly the failure the P3 gate forbids and the P0 spike proved avoidable (5 independent sessions, 0 cross-tab events) when each tab owns its WebSocket.

### F4. cdpSessionId is not a real session id

`TabSession.cdpSessionId` is typed as the CDP session identifier (ADR 0002 `TabSession` contract) but both drivers write the literal `'comet-client'`. With the single global client there is no per-session id to record. When the pool lands, this field must carry the real per-target session handle (or the WebSocket URL), otherwise dedup/reconnect logic (P3 task: `lastKnownMessageId`, cursor, hash) has no addressing anchor.

### F5. comet_connect hardcodes single-tab cleanup

`src/index.ts` `comet_connect` **closes all tabs except one** and navigates to Perplexity:

```ts
// Close extra tabs, keep only one
if (pageTabs.length > 1) { for (let i = 1; i < pageTabs.length; i++) { await cometClient.closeTab(pageTabs[i].id); } }
// Always navigate to Perplexity home for clean state
await cometClient.navigate("https://www.perplexity.ai/", true);
```

This is the "global close-all / new-chat" behavior P3 must replace with scoped tab reset. Calling `comet_connect` while a Grok tab is open destroys the Grok session — provider failure is not isolated by tab (violates ADR 0001 §Operational safeguards 2: *"A selector failure, expired login, or stalled generation in one provider must not reset or close sibling provider tabs"*).

### F6. Session state fields exist but are never populated

`TabSession` already declares `lastKnownMessageId`, `lastCompletedAt`, `lastContentHash`, `extractionCursor`, `state: 'connected' | 'degraded' | 'closed'`. **No code path sets any of them.** `askAndWait` re-derives a local snapshot (`beforeHash`, `beforeLen`) per call instead of consulting session anchors — which is why reconnect-dedup is impossible today and why the event store (P1 Half 2) is a prerequisite for the reconnect-dedup gate.

## Implications for the P3 build

1. **The CDP session pool is the core change** — not just a registry. Drivers must acquire/own a per-tab CDP session instead of calling the global `cometClient`. The P0 spike + discovery.ts's local `CDPSession` class (WebSocket per target via `webSocketDebuggerUrl`) already prove the pattern and the cap (5).
2. **Tab addressing flips from providerKey → tabId.** `provider_ask/poll/stop` currently resolve `driver.open()` implicitly. P3's `provider_open` must return a `tabId`, and ask/poll/stop/reset/close must take it.
3. **`TabSession.cdpSessionId` becomes real** — the per-target WebSocket/session handle, unique per tab.
4. **`comet_connect` loses its tab cleanup** — replaced by scoped per-tab open/close; the MCP tool becomes "ensure Comet is running", not "wreck the workspace".
5. **Reconnect-dedup stays blocked on P1 event store** (durable extraction cursor). The registry/pool/tools can ship first; the dedup gate remains the P3 item that depends on P1 Half 2.

## Confirmed scope for the P3 implementation (this branch)

- [x] Audit (this document)
- [ ] `src/cdp-pool.ts`: per-target CDP session pool, `Map<targetId, session>`, cap=5, health check, release, auto-reconnect per session
- [ ] `src/tab-registry.ts`: `Map<tabId, TabSession>` + per-provider tab resolution, last-tab protection, scoped reset
- [ ] Refactor `perplexity.ts` / `grok.ts` to route all CDP ops through the session obtained from the pool
- [ ] `askAndWait` uses the opened session across ask+poll (no per-poll reconnect)
- [ ] MCP tools: `provider_open`, `provider_list`, `provider_close`, `provider_health`, `provider_override`
- [ ] Per-tab poll backoff + circuit breaker (Perplexity critique: P0 measured evaluate/insert load, not sustained 5-tab streaming extraction)
- [ ] Populate dedup anchors on TabSession; reconnect-dedup gate deferred to P1 event store

## References

- Perplexity critique lines 16, 28, 37, 46 (`docs/reference/06-provider-critiques/2026-08-07-perplexity-critique.md`)
- P0 spike: `test/integration/cdp-concurrency-spike.mjs`, `docs/p0-cdp-concurrency-findings.md`
- Turn-02 P3 task list: `docs/design/02-turn-02-complete-synthesis-phases-and-task-list.md`
