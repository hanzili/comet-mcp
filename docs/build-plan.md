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
| P4 | Approval-required relay with provenance and receipts | Safe relay succeeds or fails explicitly | ✅ DONE — 4-tool surface `relay_prepare/approve/send/reconcile` (2026-08-09: f652ed3, 194dc77, d625572, 86d8535, 4a13e0c, 0a95492, b3dd0e8, 2006ada; ADR 0008) — R1 envelope canonicalization + envelopeHash (content+provenance+destination+policy, policyVersion stamped), R2 ContentPersistenceMode wired into the append-only write path (relay⇒redacted default, native⇒full replay-safe; receipts carry mode), R3 policy fields + fail-closed enforcement (approval/attribution mandatory/size/deadline/enablement) + markdown trust boundary, R4 prepare (terminal-success source only, eager checks, approvalHash, no destination contact), R5 approve (append-only relay.approved/rejected, expiry, single-use CAS consume vs the store), R6 send (hash binding re-validation, surface-gone pre-flight preserves approval, provenance header, receipt every attempt), R7 reconciliation (inherits ADR 0007 soft-expiry, RELAY_SURFACE_GONE terminal, providerMessageId-primary + ambiguous bucket never auto-promoted, read-only probe), R8 crossed-axis matrix + no-leak audit; 199/199 tests |
| P5 | `wait_any` and bounded scheduler | Plans halt/resume without duplicate sends | ⬜ not started — **wait_any HELD until P4 reconciliation stabilizes** (single-item state must be trustworthy before composing over many items — Claude consultation, docs/design/05) |
| P6 | Gemini, ChatGPT, and Claude.ai adapters | Each has structured degradation handling | ✅ DONE — entry-driven adapters on BaseChatDriver (2026-08-08: 238f440, 4a4cd4d) — `ProviderDriver` schema + separate `entries/<p>.driver.json` merged at load (R1 closed), thin drivers, per-provider state-machine fixtures via jsdom harness, structured health surface (workingSignal/lastVerifiedAt/foundVia/confidence) = P6 gate; 99/99 unit tests; live-validated: gemini/chatgpt/claude PONG under the 8s window (opportunistic gate `test/integration/p6-live-gate.mjs`) |
| P7 | Optional fanout, critique, routing, and debate | All features obey budgets and relay policy | ⬜ not started |
| P8 | Observability and operational hardening | Drift, failures, and delivery state are diagnosable | 🟡 drift tooling exists (provider_verify/ADRs 0002-0003); hardening pending |

## Entry-driven adapter coverage is live (P6, 2026-08-08)

All five providers are askable. The three P6 adapters (gemini/chatgpt/claude)
are entry-driven on `src/drivers/base.ts` — a thin interpreter of a new
`ProviderDriver` section (`src/types/provider.ts`): typing mode, data-driven
submit contract (`{enter|click|click-after-type}`), working/completed/login/
blocked signals, messageId anchor, markdown preClean variant, reset method.
Driver sections live in `src/providers/entries/<p>.driver.json` and are merged
at load in the registry — discovery regenerates only `<p>.json` and never
clobbers them (ADR 0006, R1 closed by construction).

Live-validation findings folded back (2026-08-08): chatgpt's discovery entry
had caught the hidden fallback textarea — composer re-pointed at the visible
contenteditable (`[aria-label="Chat with ChatGPT"][contenteditable="true"]`,
typing insertText); claude's idle UI has an svg-rect button ("Use voice mode")
that the generic stop scan false-positived — claude now uses a scoped stop
selector; the submit ladder retries the conditional send button (hydration
latency, live-verified claude /new).

The P6 gate (Grok review): completed NEVER returns an empty response — a
missing/empty response container at completion detection degrades instead;
`provider_health` surfaces workingSignal + lastVerifiedAt + per-control
confidence/foundVia for all five drivers.

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

## Async ask dispatch (2026-08-07, c206970; late reconciliation 2026-08-08)

Long provider asks survive the pi gateway RPC window: `provider_ask` dispatches
fire-and-forget and returns `{status:"in_progress", correlationId,
idempotencyKey}` immediately; `provider_poll` advances the ask server-side
(8s completion-stability window, per-tab backoff, dedup, delivery receipt);
`provider_response` fetches the stored full response in chunks. Fixes the
previous -32001 gateway timeout that stranded prompts mid-submit.

2026-08-08 (ADR 0007, four-opinion design — Gemini/Claude/Grok): ask expiry is
SOFT and non-destructive — a budget breach transitions the ask to `watching`
(retained) instead of deleting it, so a late CDP answer is recovered and
recorded as `completed_late` (both receipts coexist in the append-only trail).
A poll-independent reaper (60s interval, 30 min hard TTL, `abandoned` receipt)
bounds the registry even when a client never polls again. Default ask budget
raised to 2 min (a UX knob, not a correctness control).

Closed-tab escalation (2026-08-08, 343a1c6, user-reported hang): when the
pooled session is dead (tab closed outside the bridge), `advanceAsk` escalates
to a terminal `TAB_CLOSED` state (blocked receipt, entry removed) instead of
treating poll failure as transient and watching a dead target forever — the
state P4 reconciliation inherits as its surface-gone analogue (docs/design/05).
Suite: 99/99.

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
