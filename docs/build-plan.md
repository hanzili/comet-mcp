# Comet-MCP Build Plan

## Objective

Evolve the Perplexity-only Comet MCP bridge into a multi-provider conversation backbone. An MCP client can operate independent Comet tabs for Perplexity, Grok, Gemini, ChatGPT, and Claude.ai, collect their responses concurrently, and perform policy-controlled relays between them.

The complete rationale, architecture, detailed task list, phase gates, and test matrix are in [the complete Turn-02 synthesis](design/02-turn-02-complete-synthesis-phases-and-task-list.md). [The executive synthesis](design/00-multi-provider-backbone-executive-synthesis.md) is a concise entry point; the original Codex review is retained in [the Turn-01 critique](design/01-turn-01-critique-and-outline.md).

## Architectural rule

Browser-tab automation is a provider transport. The durable product core is a conversation fabric that records envelopes, provenance, policy decisions, and delivery receipts.

```text
MCP client -> control plane -> conversation fabric -> provider adapters -> Comet tabs
```

## Delivery phases

| Phase | Deliverable | Completion gate | Status |
| --- | --- | --- | --- |
| P0 | Architecture decision record and CDP concurrency spike | Measured safe concurrent-tab ceiling | ✅ DONE (ADR 0001, findings doc, cap=5) |
| P1 | Conversation fabric and Perplexity contract refactor | Existing behavior preserved; replay-safe deliveries | ✅ DONE — types + Perplexity driver + event-store runtime (ADR 0002, `src/types/conversation.ts`, `src/drivers/perplexity.ts`, `src/core/event-store.ts` — append-only JSONL + idempotency index + durable cursors + receipt stream, 357f7ea); replay-safety proven live (p1-replay-smoke: same idempotencyKey → prior outcome, no dup send) |
| P2 | Grok adapter and discovery pipeline | Ask/poll/stop/health PONG validation passes | ✅ DONE — Perplexity + Grok drivers live-validated (ADR 0004: markdown via turndown, provider dispatcher + `provider_ask/poll/stop` MCP tools, `comet_*` aliases); 28 tests; verified in pi |
| P3 | Concurrent tab registry and CDP session pool | Perplexity and Grok operate independently | ✅ DONE — audit + registry/pool + 6 provider tools + reconnect-dedup (2026-08-07: bfe1a24, 5333aea, 8a90456, f8a98c7); live gates PASSED: pool 5/5 real tabs, independent operation, reconnect-dedup (unchanged content → no new response event), cap-leak fixed |
| P4 | Approval-required relay with provenance and receipts | Safe relay succeeds or fails explicitly | ⬜ not started — substrate ready (receipt stream + idempotency in event store) |
| P5 | `wait_any` and bounded scheduler | Plans halt/resume without duplicate sends | ⬜ not started (P5a wait_any is the ship-boundary demo) |
| P6 | Gemini, ChatGPT, and Claude.ai adapters | Each has structured degradation handling | 🟡 discovery done for all 5 (entries HIGH; claude discovery now completes via button-click submit, 774e875); driver impls pending — only perplexity+grok askable |
| P7 | Optional fanout, critique, routing, and debate | All features obey budgets and relay policy | ⬜ not started |
| P8 | Observability and operational hardening | Drift, failures, and delivery state are diagnosable | 🟡 drift tooling exists (provider_verify/ADRs 0002-0003); hardening pending |

## Discovery is a shipped tool (2026-08-07)

Provider discovery is no longer a test artifact — it ships as part of comet-mcp
(PR #10, ADR 0002): the engine (`src/core/discovery.ts`), registry
(`src/core/registry.ts`), CLI (`comet-mcp discover|verify|list`), and MCP tools
(`provider_discover`, `provider_verify`). Entries are data (`src/providers/entries/*.json`),
written directly by discovery — DOM-drift repair is `discover → commit new JSON`.

Self-healing provider controls (ADR 0003): confidence-scored selectors (verify is a
learning loop) + structural fingerprint rebind (re-renders survive without discovery).
Resolution order: known → fingerprint-rebind → heuristic → discovery escalation.

## Multi-provider runtime is wired (2026-08-07)

`src/drivers/index.ts` is a driver registry + provider-neutral helpers (ADR 0004):
`provider_ask` / `provider_poll` / `provider_stop` MCP tools dispatch via `getDriver`;
`comet_ask` / `comet_poll` / `comet_stop` are Perplexity aliases over the same code.
Markdown extraction (innerHTML + turndown in Node) works across all providers.
Legacy `src/comet-ai.ts` retired. Verified live in pi: `provider_ask {provider: grok}`
returns text + markdown; `provider_verify` HEALTHY for perplexity and grok.

## Tab registry + CDP session pool is live (P3, 2026-08-07)

Providers are isolated per-tab: `src/cdp-pool.ts` (one CDP session per target,
cap=5 measured, `TabCapExceededError`, per-tab health/reconnect) and
`src/tab-registry.ts` (`Map<tabId, TabSession>`, providerKey→tabId addressing,
last-tab protection, scoped reset, most-recent-completed default selection,
reconnect-dedup re-hydration). MCP tools: `provider_open / provider_reconnect /
provider_list / provider_close / provider_health / provider_override`, plus
`provider_ask/poll/stop` accept `tabId`. `comet_connect` no longer destroys
tabs. Live-verified through pi: pool 5/5 with real provider tabs.

## Async ask dispatch (2026-08-07, c206970)

Long provider asks survive the pi gateway RPC window: `provider_ask` dispatches
fire-and-forget and returns `{status:"in_progress", correlationId,
idempotencyKey}` immediately; `provider_poll` advances the ask server-side
(8s completion-stability window, per-tab backoff, dedup, delivery receipt);
`provider_response` fetches the stored full response in chunks. Fixes the
previous -32001 gateway timeout that stranded prompts mid-submit.

## Discovery is hardened (2026-08-07)

- Ephemeral framework IDs (`base-ui-_r_*`, `radix-*`) never become selectors or
  rebind targets (isEphemeralId).
- Fingerprints are seeded at discovery time for every control (rebind anchor
  exists from day one — fixes the broken-selector/never-acquires-anchor deadlock).
- Visible-composer ranking (a hidden 0x0 a11y textarea no longer wins over the
  real contenteditable).
- Conditional controls (sendButton, responseContainer) detected by observation
  and flagged so verify skips idle absence.
- Downgrade guard: a low-confidence/partial run cannot overwrite a strictly
  better existing entry (sendButton loss, fewer controls, lower confidence, or
  dropped conditional flags → write refused).
- Claude discovery now completes (send button is `button[aria-label="Send
  message"]`, appears after typing, click submits) — all 5 entries HIGH.


## Initial source layout

```text
src/
  core/          Conversation fabric, delivery, tab registry, CDP pool, policy, scheduler
  providers/     Provider registry entries and limited adapter overrides
  tools/         MCP tool implementations
  types/         Conversation, provider, and driver contracts
test/
  fixtures/      Sanitized DOM/state snapshots per provider
  unit/          Contract, policy, extraction, and scheduler tests
  integration/   CDP and live opt-in integration tests
docs/
  reference/     Read-only background documents copied from Downloads
  adr/           Architecture decisions
  runbooks/      Discovery, repair, and release procedures
```

## Core safety defaults

- Cross-provider relay requires client approval.
- Every send has an idempotency key and delivery receipt.
- Plans require a turn limit and wall-clock deadline.
- A provider failure never retries an uncertain conversational send automatically.
- Provider browser UI automation may be rate-limited, blocked, or subject to provider terms; keep it opt-in and observable.

## Reference-material copy map

Copy source files from `C:\Users\Janos\Downloads` into the following folders without renaming their original contents:

| Source file | Destination |
| --- | --- |
| `doc - 07-27-26 comet-mcp-multi-agent-backbone-outline - Sonnet 5.md` | `docs/reference/01-sonnet/` |
| `doc - 07-27-26 comet-mcp-multi-agent-backbone-outline - GPT-5p6.md` | `docs/reference/02-gpt-5p6/` |
| `doc - 07-27-26 comet-mcp-multi-agent-backbone-outline - Grok 4p5.txt` | `docs/reference/03-grok-4p5/` |
| `doc - 07-27-26 comet-mcp-final-synthesis-and-task-list - Sonnet 5.md` | `docs/reference/04-sonnet-synthesis/` |
| `doc - 07-28-26 comet-mcp-final-synthesis-Expanded-task-list - Sonnet 5.md` | `docs/reference/05-expanded-synthesis/` |

Keep these documents as read-only source material. New decisions belong in `docs/adr/`; discovery results and operating instructions belong in `docs/runbooks/`.
