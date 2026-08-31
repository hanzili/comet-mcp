# ADR 0002: Conversation fabric type contracts

- **Status:** Accepted
- **Date:** 2026-08-06
- **Decision owners:** Comet-MCP project

## Context

P1 requires durable commands and events under existing single-provider behavior. The
executive synthesis fixes the central rule: *the primary abstraction is a conversation
event and delivery receipt, not a raw message copied from one tab into another.* The
type contracts for that fabric must be provider-neutral (browser-tab automation is a
transport) while still expressing the behavioral differences observed during P2
discovery — in particular, that Grok's Fast model never renders a stop button and that
its send button only exists once text is typed.

## Decision

### 1. Conversation types (`src/types/conversation.ts`)

- `ConversationEnvelope` carries `idempotencyKey` (unique per logical send) and
  `correlationId` (groups one logical exchange across providers). These are distinct;
  a relay chain is one correlation, many envelopes.
- Every send produces a `DeliveryReceipt` with one of:
  `queued | sent | accepted | completed | blocked | timed_out | unknown`.
  `unknown` is the honest answer to "did it land?" — **the server must never silently
  resend** conversational content whose delivery outcome is uncertain (ADR 0001 §5).
- The event log is **append-only** (`ConversationEvent` with a monotonic `seq`) and
  records envelope creation, each send outcome, responses (with `contentHash` /
  provider `messageId` dedup anchors), deduplicated responses, relay approvals and
  rejections, and plan halts.
- `Provenance` carries attribution for every envelope; its `safetyClaimed` field is a
  literal constant `false` — the attribution header is an audit control, never a claim
  of safety or classifier bypass (ADR 0001 §4).
- Conversation content persistence supports `full | redacted | none` modes
  (ADR 0001 §Persistence 3).
- Conservative defaults: relay is `approval-required` and not approved; every send has
  a bounded budget (max turns + wall-clock deadline) even before a plan exists.

### 2. Provider contracts (`src/types/provider.ts`)

- `ProviderState` is the normalized union of what Perplexity (`idle|working|completed`)
  and Grok (`idle|typing|streaming|completed`) express, plus failure states the fabric
  must distinguish: `login_required`, `degraded`, `blocked`.
- `PollResult` exposes `hasStopButton` truthfully per provider. **The fabric must not
  assume a stop control exists** — verified: Grok Fast model never renders one, so
  streaming state is derived from the "Working for Xs" indicator
  (`canvas-working-indicator`), not a stop button.
- `PollResult.extraction` records which extraction behaviors were applied
  (joined prose blocks, truncated-from-end, containment dedup) — this preserves the
  P1 fix provenance (Bug #1/Bug #2 from the 2026-08-06 handoff) so tests can assert
  the exact extraction path.
- `TabSession` carries dedup/reconnect anchors (`lastKnownMessageId`,
  `lastCompletedAt`, `lastContentHash`, `extractionCursor`) — the P3 reconnect
  contract is typed now so the fabric persists them from day one.
- `HealthReport` reports per-control hook resolution source
  (`known-selector | heuristic | override | missing`) plus `loginRequired` /
  `degraded` (ADR 0001 §Operational safeguards 3) — this is the drift-detection input
  for P8.
- `ChatDriver` is the provider-neutral adapter contract:
  `open / ask / poll / stop / reset / health`. Browser-tab drivers implement it today;
  official-API drivers can implement it later without touching the fabric.

### 3. Provider registry entries (`src/providers/`)

- Each provider ships a typed registry entry (selectors + constrained heuristics +
  capability evidence + discovery metadata) that drivers resolve controls through,
  instead of hard-coded selectors.
- Entries are produced by the offline discovery workflow
  (`test/integration/grok-discover.mjs`) and refreshed via `--diff` on drift.
- Fixtures per state live in `test/fixtures/<provider>/` for synthetic testing.

## Consequences

### Positive

- The fabric is decoupled from browser mechanics: relay, recovery, scheduling,
  provenance, and future API transports depend only on these types.
- The no-stop-button reality for Grok is encoded in the type system (not rediscovered
  by every future contributor).
- Replay safety is structural: idempotency keys + receipt statuses make
  duplicate-send prevention testable at P1's gate.
- Health/drift contracts exist before observability work (P8) needs them.

### Costs and risks accepted

- The type layer is currently declarations only — the event-log store, actual
  `ChatDriver` implementations, and the Perplexity refactor are still to be built
  against it.
- `ProviderState` may need extension as Gemini/ChatGPT/Claude.ai reveal states we have
  not modeled.
- Perplexity entry confidence is MEDIUM (code-contract extraction + handoff evidence,
  not a fresh live discovery); it should be re-run through the discovery workflow to
  upgrade.

## Validation

- `npx tsc --noEmit` passes with both provider entries consuming the shared types.
- P1 gate: ten representative prompts retain existing ask/poll/stop behavior;
  recovery/replay creates no duplicate send — the receipt/event model is the substrate
  for both tests.

## Related documents

- [ADR 0001: Browser-tab transport and relay defaults](0001-browser-tab-transport-and-relay-defaults.md)
- [Executive synthesis](../design/00-multi-provider-backbone-executive-synthesis.md)
- [Build plan](../build-plan.md)
- [P2 runbook: Grok provider discovery](../runbooks/grok-provider-discovery.md)
