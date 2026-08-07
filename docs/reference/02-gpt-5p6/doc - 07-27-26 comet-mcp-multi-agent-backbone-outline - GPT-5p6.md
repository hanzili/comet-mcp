<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# @GitHub Turn-01 Comet-mcp 07-27-26 Query:

1. Study github repos: [https://github.com/hanzili/comet-mcp](https://github.com/hanzili/comet-mcp) [https://github.com/sderosiaux/chrome-agent](https://github.com/sderosiaux/chrome-agent) [https://github.com/soufian3hm/BrowserSmith](https://github.com/soufian3hm/BrowserSmith)
2. reflect, comment, critique, improve the attached doc...md and synthesize an outline to realize the Goal: Evolve comet-mcp from a single-provider (Perplexity), single-tab MCP server into a backbone that lets an MCP client (Claude) orchestrate conversations across several AI providers simultaneously (Grok, Gemini, ChatGPT, Claude.ai, Perplexity), each living in its own Comet tab, and optionally relay messages between those providers — not just between Claude and one provider at a time.

Turn-1 07-27-26
Concept Tags: multi-agent, backbone, provider-registry, CDP, relay, tab-session, chrome-agent, BrowserSmith, comet-mcp, discovery-pipeline

***

The attached document is strong — well-structured, grounded in real code, and honest about existing fragility. Below is a critique, reflection, and a synthesized, improved outline that sharpens the weak spots and adds what's currently missing.

***

## Critique of the Existing Doc

**What it does well:**

- Accurate baseline diagnosis of [comet-mcp's](https://github.com/hanzili/comet-mcp) current limitations: single CDP session, single port, aggressive tab destruction, all DOM logic hard-coded in `comet-ai.ts`, and the brittle `status.steps is not iterable` failure mode[^1]
- BrowserSmith's three-tier hook model (known → heuristic → override) is correctly identified as the most durable selector strategy, borrowed from the right source[^2]
- The chrome-agent discovery pipeline is correctly scoped as *offline/on-demand* tool, not hot-path[^1]
- Build order in §7 is pragmatic and incremental

**What's weak or missing:**

1. **No TypeScript interface definition** — The registry "schema" is described in prose and a JSON blob, but the doc never shows the actual `ChatDriver` interface that each `providers/grok.ts` must implement. Without this contract written in TypeScript, the abstraction stays conceptual.
2. **Relay security is mentioned once, not designed** — §6 notes that Perplexity's security classifier blocked cross-thread relay content. This deserves its own section: the relay-wrapping format, how to prefix injected content so it reads as user instruction rather than embedded page content, and a fallback for providers that block it.
3. **Concurrent CDP session management is underspecified** — §5 says "N concurrent sessions" but doesn't address what happens when Comet's CDP server (single port 9222) returns multiple `targetId`s and whether `chrome-remote-interface` can maintain N simultaneously active sessions without dropping events.
4. **No mention of the RapierCraft fork** — The prior Grok research explicitly noted that [RapierCraft/Perplexity-Comet-MCP](https://github.com/RapierCraft/Perplexity-Comet-MCP) already added `comet_tabs` with list/switch/close. The doc mentions it in passing in §5 but doesn't recommend forking from there rather than from `hanzili/comet-mcp` as the starting point.
5. **BrowserSmith's `webContents.insertText` vs CDP** — BrowserSmith runs in Electron (main process `insertText`); comet-mcp runs pure CDP. The typing strategy section correctly flags ProseMirror, but the CDP equivalent — `Input.dispatchKeyEvent` with `insertText` type — needs to be spelled out explicitly because `document.execCommand('insertText')` is deprecated and already causing fragility.[^2]
6. **No conversation-log data structure** — §6 mentions a "shared conversation log" but doesn't sketch what it looks like in memory or on disk. This matters for relay correctness and for resuming a multi-provider session after a crash.
7. **Wall-clock cost of multi-tab polling is unaddressed** — If Claude is simultaneously polling Grok (30s deep-research), Gemini (15s), and ChatGPT (10s), the MCP client's context window gets filled with polling round-trips. A batched-poll or push-notification model should be mentioned even if deferred.

***

## Synthesized Improved Outline

### Purpose \& Scope

Evolve [hanzili/comet-mcp](https://github.com/hanzili/comet-mcp) from a single-provider Perplexity bridge into an MCP backbone where Claude orchestrates simultaneous conversations across Grok, Gemini, ChatGPT, Claude.ai, and Perplexity — each in its own Comet tab — and relays messages between those providers.[^1]

***

### 1. Confirmed Baseline (Current `hanzili/comet-mcp`)

- Single active CDP session `this.client`; tab-switch requires disconnect/reconnect[^2]
- Every `comet_connect`/`newChat:true` destroys all tabs but one and navigates home — actively hostile to multi-tab[^2]
- All DOM logic hard-coded in `comet-ai.ts`: selectors, typing, submit, completion detection, extraction[^1]
- Known regressions: `status.steps is not iterable`, double-escaping in injected script template literals, prose-block extraction order, character-cap truncation direction[^1]
- No `evaluate` debug tool — every diagnosis requires rebuild[^1]
- **Starting point recommendation**: Use the [RapierCraft fork](https://github.com/RapierCraft/Perplexity-Comet-MCP) (already has `comet_tabs` with list/switch/close/last-tab-protection) rather than `hanzili/comet-mcp` directly, to avoid re-implementing what already exists[^2]

***

### 2. TypeScript Architecture: `ChatDriver` Interface + Provider Registry

Define the contract first, then implement per-provider:

```typescript
// src/types/chat-driver.ts
interface ProviderHook {
  known: string[];          // stable CSS selectors, prefer aria/data attrs
  heuristic: string;        // geometric/role description for fallback
  override?: string;        // runtime-supplied, wins over both
}

interface ProviderEntry {
  key: string;              // "perplexity" | "grok" | "gemini" | "chatgpt" | "claude"
  name: string;
  home: string;
  freshChatByNavigation: boolean;
  authCookieNames: string[];  // for login-health check only
  hooks: {
    composer: ProviderHook;
    send: ProviderHook;
    stop: ProviderHook;     // re-resolved every poll, NEVER cached
    output: ProviderHook;
    newChat?: ProviderHook;
    model?: ProviderHook;
  };
  status: {
    workingSignal: "stop-visible";   // always stop-button as primary
    completedSignal: string;         // e.g. "stop-gone + new-assistant-content"
    completedTextMarkers?: string[]; // secondary: "Ask a follow-up", "Regenerate"
  };
  typing: "execCommand" | "dispatchKeyEvent";  // ProseMirror → dispatchKeyEvent
  overrides?: Partial<Record<keyof ProviderEntry["hooks"], string>>;
}

interface ChatDriver {
  ask(prompt: string, tabSession: TabSession): Promise<string | "in-progress">;
  poll(tabSession: TabSession): Promise<PollResult>;
  stop(tabSession: TabSession): Promise<void>;
  health(tabSession: TabSession): Promise<HealthReport>;
  resetTab(tabSession: TabSession): Promise<void>;
}
```

Provider files (`src/providers/perplexity.ts`, `grok.ts`, etc.) export a `ProviderEntry` object. The runtime loads them from a `providers/` registry directory.[^1]

***

### 3. Multi-Tab Session Model

Replace tab-destruction policy with a tab registry:

```
tabRegistry: Map<tabId, { providerKey, sessionState, cdpSession }>
```

- **N concurrent CDP sessions**: `chrome-remote-interface` supports multiple simultaneous `CDP({ target })` connections to different `targetId`s on the same port. One session per provider tab, held open. Comet's CDP server at port 9222 returns all open targets via `listTargets()`.[^2]
- **Session isolation**: Single logged-in Comet profile covers all providers the user is already signed into (mirrors chrome-agent's `--copy-cookies` pattern). Per-partition profiles only for multi-account isolation.[^2]
- **New tool surface**:

| Tool | Signature | Purpose |
| :-- | :-- | :-- |
| `provider_open` | `(providerKey)` → `tabId` | Open/navigate a provider tab |
| `provider_ask` | `(tabId, prompt, newChat?)` | Submit prompt to a specific tab |
| `provider_poll` | `(tabId)` | Get current status/response |
| `provider_stop` | `(tabId)` | Cancel generation |
| `provider_health` | `(tabId?)` | Hook-resolution status per tab |
| `provider_list` | `()` | All open tabs + provider + status |
| `provider_close` | `(tabId)` | Close one tab, never last tab of provider |
| `provider_override` | `(tabId, hook, cssSelector)` | Runtime re-teach a broken selector |
| `relay_message` | `(fromTabId, toTabId, mode)` | Backbone primitive (see §6) |


***

### 4. Discovery Pipeline (chrome-agent as Offline Selector Miner)

One-time (or re-run on UI-change detection) per provider:[^2]

1. **Auth setup** — `chrome-agent --copy-cookies --stealth --browser <provider>` or attach via `--connect` to logged-in Comet
2. **Idle surface scan** — `inspect --filter "textbox,button,combobox" --max-depth 4 --json` + `eval` over `[contenteditable=true], textarea, [role=textbox]`; record `aria-label`, `placeholder`, `data-testid`, `role`, short non-hashed class fragments
3. **Submit path** — try `Enter`; if rejected, scan `button` nodes for SVG + `aria-label` containing "send/submit"
4. **State sequence** — snapshot idle → typing → streaming → completed; look for stop-button appearance/disappearance, spinner classes, text markers
5. **Response container** — `eval` over `[class*=prose], [data-message-author-role], [data-testid*=message], article`; take last non-UI match
6. **Validation probe** — send "Say only the word PONG"; confirm PONG appears in response container
7. **Emit `ProviderEntry` JSON** → drop into `src/providers/<key>.json`; hand-edit `heuristic` fallbacks; commit

Re-run the same pipeline and diff when a provider UI changes, rather than debugging live in production.[^1]

***

### 5. Runtime Resilience (BrowserSmith Lessons)

Every driver, regardless of provider, must obey these rules:[^2]

- **Never cache stop-button across polls** — re-resolve from DOM every iteration; sites swap attributes on the same node
- **Stop-visible = only hard "working" signal**; spinners and text-growth are secondary/corroborating
- **`provider_health` returns structured report**: `{ hook: "composer", foundVia: "known|heuristic|override|missing" }` for every hook — surfaces degradation *before* timeout, not after
- **Hard reset per tab**: if composer disappears or reply never arrives → navigate to fresh chat URL (scoped to that tab only, not global close-all)
- **Typing strategy**: use `Input.dispatchKeyEvent` with `insertText` type for ProseMirror editors (Grok, Claude.ai); `document.execCommand('insertText')` is deprecated and already fragile in comet-mcp for Perplexity[^2]
- **Injected script validation**: run every `eval` template literal through `node --check` before shipping; unit-test join/dedupe/truncation logic against synthetic fixtures (directly addresses the `status.steps is not iterable` regression class)[^1]

***

### 6. Relay \& Communication Backbone

The new layer that turns multi-tab into multi-*agent*:

**`relay_message(fromTabId, toTabId, content?, mode)`**

- `mode: "verbatim" | "wrapped" | "summarize"`
- `"wrapped"` prepends: `"[Relayed from {providerName}] {content}"` — deliberate format to avoid Perplexity/other security classifiers reading relayed content as page-embedded injection[^1]
- `"summarize"` calls Claude (the orchestrator) to compress before relay — preserves context window headroom

**Shared conversation log** (in-memory, optionally persisted to `~/.comet-mcp/session.json`):

```typescript
interface ConversationEntry {
  turn: number;
  timestamp: string;
  fromProvider: string;  // or "user" | "orchestrator"
  toProvider: string;
  content: string;
  mode: RelayMode;
}
```

This log is the only place the cross-provider conversation exists as a coherent thread — each provider tab only sees its own history.[^1]

**Orchestration patterns** (layered on `relay_message` + `provider_health`):

- `broadcast(prompt, providerKeys[])` — submit same prompt to N providers, collect all responses
- `critique(fromTabId, toTabId)` — relay last response of A as "critique this:" prompt to B
- `round_robin(providerKeys[], prompt, turns)` — N-turn chain, each provider responds to the previous

**Polling efficiency for concurrent long-running tasks**: Instead of Claude issuing sequential `provider_poll` calls (filling context window), implement a server-side `wait_any(tabIds[], timeoutMs)` tool that blocks until *any* tab completes and returns which one — Claude issues one call instead of N sequential polls.[^1]

***

### 7. Build Order

| Phase | Deliverable | Validates |
| :-- | :-- | :-- |
| **P1** | Refactor Perplexity into `ProviderEntry` + `ChatDriver` interface — behavior unchanged | Abstraction compiles, existing tests pass |
| **P2** | Add Grok end-to-end via chrome-agent discovery pipeline | Full discover→registry→driver→runtime loop on real different DOM |
| **P3** | Multi-tab session model: tab registry, N concurrent CDP sessions, new tool surface | Two providers open simultaneously, polled independently |
| **P4** | `relay_message` + shared conversation log + `broadcast`/`critique` primitives | Relay works; relay-wrapping blocks classifier false-positives |
| **P5** | Add Gemini, ChatGPT, Claude.ai via same pipeline; validate `provider_health` degradation path | Each addition is config, not code |
| **P6** | `wait_any` batched poll; optional `session.json` persistence | Context-window efficiency; crash recovery |


***

### 8. Open Risks (Explicit, Load-Bearing)

- **Selector maintenance scales with provider count** — BrowserSmith's degrade-not-break philosophy is not polish; it's structural. Known → heuristic → override is mandatory, not optional[^2]
- **Markdown fidelity decision deferred too long** — `innerText` flattening vs. `innerHTML`+`turndown` must be resolved *before* relay, because inconsistent formatting across providers corrupts cross-agent relay content[^1]
- **CDP concurrent session limits** — Comet's Chromium-based CDP at port 9222 should support N simultaneous `Target.attachToTarget` connections, but this needs an empirical test with 4–5 concurrent sessions before committing to the architecture
- **Relay security classifiers** — Perplexity's indirect-injection block is direct evidence; every provider's relay format should be tested with a benign probe before production use[^1]
- **Login expiry under automation** — providers will expire sessions; the backbone needs a `"login_required"` health state that surfaces clearly rather than silently returning empty responses or blocked content

<div align="center">⁂</div>

[^1]: doc-07-27-26-comet-mcp-multi-agent-backbone-outline-Sonnet-5.md

[^2]: thread-07-27-26-Comet-mcp-Chrome-Agent-BrowserSmith-grok.txt

