# From Perplexity-Only Bridge to Multi-Agent Communication Backbone
## Outline: Applying Grok's chrome-agent / BrowserSmith Findings to comet-mcp

**Goal:** Evolve comet-mcp from a single-provider (Perplexity), single-tab MCP server into a backbone that lets an MCP client (Claude) orchestrate conversations across *several AI providers simultaneously* (Grok, Gemini, ChatGPT, Claude.ai, Perplexity), each living in its own Comet tab, and optionally relay messages *between* those providers — not just between Claude and one provider at a time.

---

## 1. Where comet-mcp stands today (baseline, from current session history)

- Single active CDP session (`this.client`); no concurrent multi-tab control exposed to the MCP client.
- Every `comet_connect` / `newChat: true` aggressively closes all tabs but one and forces navigation back to `perplexity.ai` — actively hostile to a multi-tab future.
- Single debug port (9222), single Comet process — no concept of multiple browser instances.
- All DOM logic (selectors, typing, submit, completion detection, extraction) is hard-coded to Perplexity's UI inside `comet-ai.ts`.
- Known fragility already surfaced in bug-fixing to date: prose-block extraction order, character-cap truncation direction, whitespace collapsing undoing fixes, escaping bugs in the injected-script template literal, and a stop-button/steps status model that's easy to break silently (`status.steps is not iterable`).
- No raw `evaluate` tool exposed to the MCP client — every DOM investigation so far has required editing source and rebuilding, not live inspection.
- Recovery today = full quit/reopen of Claude Desktop; no live health signal when a selector goes stale.

This baseline matters because every enhancement below has to be layered onto (or replace) code that is already known to be brittle in exactly the ways Grok's research flags as generic risks for any chat-UI driver.

---

## 2. Core architectural shift: Provider Registry + Pluggable ChatDriver

Replace hard-coded Perplexity logic with a **registry of provider entries**, each implementing a common driver interface. Adopt BrowserSmith's three-tier hook model (known → heuristic → override) rather than comet-mcp's current single-tier hard-coded selectors:

```
providers/
  perplexity.js
  grok.js
  gemini.js
  chatgpt.js
  claude.js
```

Each entry carries:
- Identity: `key`, `name`, `home` URL, `freshChatByNavigation` (prefer URL nav over clicking "New chat")
- Auth: cookie/profile hints for a login-health check
- Hooks: `composer`, `send`, `stop`, `output`, `response`, optional `model` / `newChat`, each with `known` selector lists **and** a `heuristic` fallback (e.g. "lowest large textbox", "rightmost enabled button near composer")
- `status`: explicit `working` vs `completed` signals, with the stop-button (re-resolved every poll, never cached) as the primary "still generating" signal rather than "text stopped changing"
- `overrides`: runtime-supplied CSS selectors, so a broken provider can be re-taught without a code change or rebuild

This is the single biggest change: it turns "add a provider" from a source-edit-and-rebuild exercise (comet-mcp's current fix-delivery pattern) into a JSON/config addition.

---

## 3. Discovery phase: use chrome-agent to *populate* the registry, not to stay in the hot path

chrome-agent isn't meant to replace comet-mcp's CDP runtime — it's the offline/on-demand tool that mines each provider's selectors so comet-mcp doesn't have to hand-roll DOM archaeology per site.

Recommended one-time (or periodic) pipeline per provider:
1. **Session setup** — `--copy-cookies` or `--connect` to an already-logged-in Chrome/Comet profile (most of these UIs require auth).
2. **Map the idle surface** — `inspect --filter "textbox,button,combobox"` plus a targeted `eval` over `[contenteditable=true], textarea, [role=textbox]` to record stable identifiers (prefer `aria-label`, `placeholder`, `role`, short unique class fragments over hashed classnames).
3. **Discover the submit path** — try `Enter` first, fall back to scanning visible, non-disabled buttons with SVG icons for a send control.
4. **Capture streaming/working/completed states** — repeated `inspect`/`text`/`diff`/`eval` snapshots looking for a stop/cancel control, spinners, "thinking/searching" text, and end-of-turn markers ("Ask a follow-up", "Regenerate").
5. **Extract the response container** — candidate scan over prose/markdown/message-role containers, take the last non-UI match (same heuristic comet-mcp already uses for Perplexity's prose blocks).
6. **Emit a registry JSON object** matching the schema in §2, validated by actually sending a test prompt (e.g. "Say only the word PONG") and confirming the reply appears.

Practical notes carried over directly from the findings:
- chrome-agent's stable `backendNodeId`-based UIDs survive re-inspects on the same page — useful for validating a selector across the idle → typing → streaming → done sequence without re-querying from scratch each time.
- Keep discovery scoped and cheap: `--filter`, `--max-depth`, `--max-chars`, `--json`.
- Re-run this pipeline (and diff against the stored registry entry) whenever a provider's UI changes, rather than debugging live in production.

---

## 4. Runtime resilience upgrades (BrowserSmith lessons comet-mcp currently lacks)

Apply these to the generalized server regardless of provider count:

- **Never cache the stop-button node across polls** — re-resolve every time; sites reuse the same node and just swap attributes.
- **Stop-visible is the only hard "working" signal** — text growth and spinners are secondary/corroborating, not authoritative.
- **`provider_health` tool** — structured status per hook (`found via: known | heuristic | override | missing`) so degradation is visible before a 15s timeout, not discovered after the fact.
- **Hard reset path** — if the composer disappears or a reply never arrives, navigate to a fresh chat URL and reseed rather than retrying into a dead tab. Comet-mcp's current "close everything, force home" behavior is *too* aggressive for multi-provider use (see §5) but the underlying instinct — self-heal instead of infinite retry — is right and should be scoped per-tab.
- **Runtime override tool** — expose an argument (or short-lived "pick mode") that accepts a CSS selector override per hook, so a broken provider is re-teachable without a rebuild/redeploy. This directly addresses the current fix-delivery pain (patch → `npm run build` → validate → replace file → full app relaunch).
- **Typing strategy** — prefer `Input.insertText`/real key events over `execCommand('insertText')` where a provider uses a ProseMirror-like editor; BrowserSmith had to move typing into the main process for exactly this reason.
- **Escaping/validation discipline for any injected script** — comet-mcp's own regression history (the double-escaping bug that broke `status.steps`) argues for a standing rule: extract the injected browser-script string and run it through `node --check` before shipping, plus unit-test any text-processing logic (join/dedupe/truncation) against synthetic fixtures, for *every* provider driver, not just Perplexity's.

---

## 5. Multi-tab / multi-provider session model

This is the section that turns "supports other providers" into "supports several providers *at once*," which is what a communication backbone requires.

- **Tab registry, not tab destruction.** Replace comet-mcp's current policy (close all tabs but one, force-navigate home on every connect/newChat) with a small registry mapping `tabId → providerKey → sessionState`. One Comet instance can host several providers as separate tabs/pages concurrently — this is exactly the model BrowserSmith already runs (four concurrent ChatGPT tabs on a shared session partition).
- **Session isolation where needed.** Most providers can share one logged-in Comet profile if the user is already signed into each site (mirrors chrome-agent's `--copy-cookies`/`--connect` pattern). Use per-partition profiles only if a provider requires session isolation (e.g. testing multiple accounts on the same service).
- **Concurrent CDP sessions.** comet-mcp's current design holds exactly one active CDP session (`this.client`) and switches tabs by disconnect/reconnect. This needs to become N concurrent sessions (or a session pool keyed by tab/provider), since a communication backbone needs to poll/read from tab A while writing to tab B.
- **Tool surface generalization.** Rename or parameterize: `comet_ask(prompt, provider?, tabId?, newChat?, timeout?)`, `comet_poll(tabId?)`, plus new tools: `list_provider_tabs`, `open_provider_tab(providerKey)`, `close_provider_tab(tabId)`, `provider_health(tabId)`.
- **Last-tab protection** and explicit list/switch/close semantics (an enhanced fork of comet-mcp already adds a `comet_tabs` tool along these lines — worth reviewing as a starting point rather than building from zero).

---

## 6. New layer: the multi-agent *communication backbone* itself

Everything above generalizes comet-mcp to "any provider, any number of tabs." The backbone layer is what's new relative to Grok's research (which stopped at single-provider-at-a-time driving) and is the part that actually serves the user's stated goal — models talking to *each other*, mediated through Claude/MCP.

Design elements to spec out:

- **Message routing / relay tool.** A tool like `relay_message(fromProvider, toProvider, content, mode)` that reads the last response from one provider's tab and submits it (verbatim, summarized, or transformed) as the next prompt into another provider's tab. This is the core "backbone" primitive — everything else exists to make this reliable.
- **Turn-taking / conversation state.** A lightweight shared conversation log (outside any single provider's own chat history) that Claude/the MCP client maintains: who said what, in what order, and which provider tab it came from. This is necessary because each provider only sees its own thread — the cross-provider "conversation" only exists in the orchestrator's state.
- **Round/loop control.** Tools or conventions for "run N rounds between provider A and B," "broadcast this prompt to all connected providers and collect responses," or "have provider A critique provider B's last answer." These are orchestration patterns layered on top of `relay_message` + `provider_health`, not new DOM logic.
- **Provenance and formatting.** Decide whether relayed content gets wrapped (e.g. "Here is what \[Provider A] said: ...") or passed raw — raw relay risks tripping a provider's own prompt-injection classifier (comet-mcp has already hit this: Perplexity's security layer flagged a request to relay another thread's content as looking like page-embedded content masquerading as a user instruction). Build relay-wrapping conventions deliberately so cross-agent traffic doesn't get silently blocked as a security event.
- **Failure isolation.** One provider's tab going degraded (selector drift, login expiry, paywalled agentic mode) shouldn't stall the whole backbone. `provider_health` per tab plus a hard-reset-that-provider-only path is what makes multi-provider orchestration survivable long-run, rather than one flaky Comet tab taking down the whole session (comet-mcp's current single-session model would do exactly that today).
- **Timeout/streaming semantics per provider.** Since `comet_ask`'s documented "blocking" behavior already doesn't match its actual immediate-return-then-poll behavior for Perplexity, the backbone needs one consistent async contract across all providers (submit → poll → complete) rather than assuming each provider behaves identically. Different providers will have very different generation-time profiles (a quick Grok reply vs. a multi-minute deep-research run), so the backbone's round-control logic needs per-provider timeout/poll tuning, not a single global timeout.

---

## 7. Suggested build order

1. **Registry + single-provider refactor first.** Pull Perplexity's existing hard-coded logic into the registry/driver shape (§2) without changing behavior — proves the abstraction before adding new providers.
2. **Add one second provider end-to-end** (Grok is a reasonable first pick given it's already referenced) using the chrome-agent discovery pipeline (§3), including the runtime-resilience items (§4). This validates the whole discovery→registry→driver loop on real, different DOM.
3. **Multi-tab session model** (§5) — tab registry, concurrent CDP sessions, generalized tool surface. Validate with two providers open simultaneously, polled independently.
4. **Backbone primitives** (§6) — `relay_message`, shared conversation log, round control — built on top of the now-stable multi-tab foundation.
5. **Harden and expand provider list** — add Gemini/ChatGPT/Claude.ai using the same discovery pipeline; treat each addition as a config/registry change, not a code change, per the whole point of §2.

---

## 8. Open risks to flag explicitly (carried over, not new)

- Ongoing selector maintenance burden scales with provider count — this is the reason BrowserSmith's degrade-not-break philosophy (known → heuristic → override, plus health reporting) is treated as load-bearing rather than optional polish.
- Markdown/structure preservation (headers, tables, code fences) vs. flattened `innerText` is still an open, deprioritized question for Perplexity alone — it will need a decision (hand-rolled walker vs. `innerHTML` + `turndown`) *before* scaling to multiple providers, since inconsistent formatting across providers will make cross-agent relay harder to reason about.
- No live DOM-inspection tool currently exists inside comet-mcp itself — discovery/redebugging depends on chrome-agent or manual DevTools work. Worth deciding whether a minimal `evaluate`-style debug tool belongs in comet-mcp itself for faster in-place diagnosis, separate from the offline chrome-agent discovery pipeline.
- Security classifiers (per §6) are a real, not hypothetical, constraint on relay design — the existing Perplexity indirect-injection block is direct evidence this needs deliberate handling, not an afterthought.
