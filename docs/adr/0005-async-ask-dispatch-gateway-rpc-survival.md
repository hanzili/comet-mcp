# ADR 0005: Async ask dispatch — provider_ask survives the gateway RPC window

- **Status:** Accepted
- **Date:** 2026-08-07
- **Decision owners:** Comet-MCP project

## Context

The pi MCP gateway caps the RPC round-trip window (~150s). `provider_ask` used to
block inside `askAndWaitOn` for the whole window while polling the provider tab.
For long generations (agentic research, multi-phase answers), the gateway
abandoned the call (`-32001`) **mid-ask**, stranding the typed prompt in the
composer (observed live: 1047-char review prompt typed but never submitted, tab
left dirty). The file-backed response store (commits 4b5dd56/790fd90, ADR 0004
family) solved the *result-size* cap (500B gateway limit) but never the
*RPC-window* cap: it only helps after completion.

## Decision

Split `provider_ask` into dispatch + advance:

1. **`dispatchAsk(driver, session, prompt)`** — runs the durable lifecycle up to
   `send.accepted` (envelope.created → send.queued → pre-send snapshot → ask →
   send.accepted), registers a server-side `PendingAsk` keyed by idempotencyKey,
   and returns **immediately** with `{status:"in_progress", correlationId,
   idempotencyKey}`. The client never holds the RPC open.

2. **`advanceAsk(key)`** — driven by `provider_poll`: performs ONE poll step,
   applying the same 8s completion-stability window, per-tab backoff + circuit
   breaker, response dedup (`response.deduplicated`), durable cursor checkpoint,
   and delivery receipt. On completion the full response is stored server-side
   (fetched via `provider_response` chunked retrieval) and the pending entry is
   removed. On budget expiry, records `send.timed_out` + a `timed_out` receipt.

3. **`lastDispatchedFor(provider)`** — `provider_poll` finds the pending ask to
   advance; falls back to a plain poll when none.

Replay guard unchanged: a retry with the same idempotencyKey returns the prior
outcome (no duplicate send — P1 gate preserved).

## Consequences

### Positive

- Long asks survive the gateway RPC window; the client polls at its own pace.
- The ask lifecycle (stability window, dedup, receipt) still runs server-side —
  no loss of correctness, identical event-log semantics to the blocking path.
- This is the exact async model a workflow-orchestration adapter needs (the
  pi-extensible-workflows migration target: `workflow → typed adapter → CDP →
  multi-tab observation → durable artifacts`).

### Costs and risks accepted

- The MCP client must poll (`provider_poll`) and fetch (`provider_response`)
  instead of a single blocking call — a protocol change for consumers.
- A dispatched ask that is never polled stays pending until its timeout budget
  expires (then `timed_out` receipt). No automatic reaper beyond the budget.
- The pending registry is in-memory; a server restart loses in-flight asks
  (the durable event log still records what was sent/recorded up to restart).

## Validation

- Unit tests (70 total, async-ask suite): dispatch returns immediately, advance
  completes after the stability window, unknown keys return null, stability
  constant is 8s.
- Live through the MCP server: `provider_ask` → immediate `in_progress` (no
  `-32001`); `provider_poll` advances; `provider_response` fetches.

## Related documents

- [Build plan](../build-plan.md) — "Async ask dispatch" section
- [ADR 0004](0004-markdown-extraction-and-provider-dispatcher.md) — file-backed
  responses (result-size cap); this ADR addresses the RPC-window cap
- Migration synthesis: `responses/migration-solution-synthesis.md`
