# ADR 0007 — Async-ask late reconciliation (soft expiry + poll-independent reaper)

**Status:** accepted (2026-08-08, four-opinion design)
**Design doc:** `docs/design/04-async-ask-timeout-reconciliation.md`
**Consultations:** Gemini, Claude, Grok (`responses/*-async-ask-timeout-consultation-2026-08-08.md`)

## Context

`dispatchAsk`/`advanceAsk` (ADR 0005) recorded a pending ask with
`timeoutMs: 15000` and, on budget expiry, **deleted** the pending entry —
recording `send.timed_out` + a `timed_out` receipt and dropping the correlation
key. The browser-side generation is unaffected (CDP keeps streaming), so a
delivered answer becomes unreachable via `provider_response`: idempotency and
reconnect-dedup for that ask are lost, and the client sees the contradictory
"Task in progress … Status: TIMED_OUT". Reproduced live 2026-08-08 (claude PONG
delivered, bridge reported TIMED_OUT).

Root cause (three-provider consensus): `timeoutMs` conflates two clocks — the
client's wait budget and the correlation-key lifetime. The 15s default merely
determines how often the collision happens; **destructive expiry is the bug**.

## Decision

1. **Soft expiry is non-destructive**: on budget expiry an ask transitions from
   `phase: 'active'` to `phase: 'watching'` — the key is retained, and the
   `timed_out` receipt fires **exactly once** (guarded by `phase === 'active'`).
2. **Late recovery**: while `watching`, each poll runs the tab; on a completed,
   stable, new response the ask finalizes normally but the receipt status is
   **`completed_late`** and the outcome carries `late: true`. Both receipts
   coexist in the append-only stream ("deadline expired, response later
   confirmed"). The existing `beforeHash`/`sawNewResponse`/8s stability window
   and `hasResponseHash` dedup machinery apply unchanged.
3. **Poll-independent reaper**: a `setInterval` (60s cadence) purges entries
   past `HARD_TTL_MS` (30 min — sized against the longest realistic generation
   plus margin, Grok guidance) and records an `abandoned` receipt. A lazy sweep
   on polling would not bound memory — an abandoned ask is by definition never
   polled again. `reapExpired(now)` is exported/testable; `startReaper()` is
   called at server startup (unref'd).
4. **Default budget** `?? 15000 → ?? 120000` — a UX knob (when the client first
   sees a deadline), not a correctness control; per-call `timeout` override stays.
5. **Honest rendering**: `renderInProgress` distinguishes `timed_out` (soft
   expiry — still watched), `watching` (deadline passed, tab still running), and
   `abandoned` (hard TTL). The comet-bridge wrapper may carry its own copy of
   this render — verify/mirror there when its source is available.

## Consequences

- A delivered-but-late answer is always recoverable; the receipt trail is
  truthful (one `timed_out` + optionally one `completed_late`/`abandoned`).
- `provider_response`, replay (`response.received` keyed), and reconnect-dedup
  work across the soft-expiry transition unchanged.
- The pending-ask registry is bounded by the reaper even with no client polling.
- Behavior change vs ADR 0005: entries are no longer hard-deleted on budget
  expiry — tests updated accordingly (98/98 green).
