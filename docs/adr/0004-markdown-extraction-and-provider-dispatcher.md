# ADR 0004: Markdown extraction strategy and provider dispatcher

- **Status:** Accepted
- **Date:** 2026-08-07
- **Decision owners:** Comet-MCP project

## Context

Two P2 decisions needed recording:

1. **Markdown extraction.** The 2026-08-06 handoff explicitly framed the choice:
   preserve Markdown structure instead of flattened `innerText`, with two options —
   (a) a hand-rolled HTML→Markdown walker inside the risky injected browser script
   (higher risk, same fragile double-escaping context that caused Bug #1's regression),
   or (b) capture `innerHTML` and convert via the `turndown` library in ordinary Node
   code (lower risk, new dependency, needs custom handling for Perplexity's citation
   badges). The handoff recommended (b).

2. **Multi-provider MCP surface.** Perplexity and Grok drivers exist (P1/P2); exposing
   them from MCP tools could mean either a parallel `comet_grok_ask` (duplicating the
   surface) or a provider-parameterized dispatcher.

## Decision

### 1. Markdown = innerHTML + turndown in Node (handoff option b)

- Drivers capture the response container's **innerHTML** alongside innerText; the
  in-page scripts remain pure collectors.
- `src/providers/markdown.ts` converts via `turndown` (atx headings, fenced code)
  with **provider-specific pre-cleanup**: Perplexity citation badges (`<sup>`,
  `<a class="citation">`) are stripped before conversion; Grok's timing line handled
  in the text path.
- **Provider-neutral by design**: every driver (Perplexity, Grok, future Gemini/
  ChatGPT/Claude) captures innerHTML and converts through the same module — no
  per-provider markdown code.
- `PollResult` gains an optional `markdown` field; the flattened-text `response`
  stays primary (non-breaking).
- New dependency: `turndown@^7.2.4` (+ `@types/turndown`).

### 2. Provider dispatcher over a driver registry

- `src/drivers/index.ts` is a **registry** (`getDriver`, `listDrivers`) plus
  provider-neutral helpers: `askAndWait` (the ask→wait→respond loop, implemented
  once over the `ChatDriver` contract), `renderPoll`, `renderInProgress`,
  `normalizePrompt`.
- New MCP tools **`provider_ask` / `provider_poll` / `provider_stop`** take a
  `provider` param and dispatch via the registry.
- **`comet_ask` / `comet_poll` / `comet_stop` become thin Perplexity aliases** over
  the same helpers, preserving external behavior — completing the P1
  `comet_*` → `provider_*` migration path.
- Legacy code retired: the `CometAI` compat layer in `drivers/perplexity.ts` and
  `src/comet-ai.ts` (superseded by the drivers; net −566 lines).

## Consequences

### Positive

- Markdown works across all providers with one shared converter; the risky in-page
  conversion path is avoided entirely.
- One ask/poll/stop implementation serves every provider — adding a driver (Gemini,
  ChatGPT, Claude) automatically gives it the full MCP surface.
- `comet_*` keeps working (migration path honored) while `provider_*` becomes the
  canonical surface.

### Costs and risks accepted

- `turndown` is a new runtime dependency (Node-side only; no browser risk).
- The `len > 5` filter in text extraction (preserved from the original) still drops
  short validation tokens — markdown path has no such filter, but short answers like
  "OK"/"PONG" won't surface as text.
- `markdown` is a best-effort conversion of provider-rendered HTML; exotic elements
  may not round-trip perfectly.

## Validation

- 28 unit tests pass (9 Perplexity extraction + 8 Grok extraction + 5 markdown + 6
  fixture-driven against real captured DOM).
- Live: `provider_ask {provider: grok}` via pi's MCP bridge returned text + markdown
  ("The capital of Japan is Tokyo." / "- Python\n- JavaScript" bullet lists).
- `provider_verify` HEALTHY for perplexity and grok through pi; server starts clean
  with 11 tools.

## Related documents

- [ADR 0002: Conversation fabric type contracts](0002-conversation-fabric-type-contracts.md)
- [ADR 0003: Self-healing provider controls](0003-self-healing-provider-controls.md)
- [Provider discovery runbook](../runbooks/grok-provider-discovery.md)
- Session handoff (SRC-2026-08-06-002): markdown preservation options
