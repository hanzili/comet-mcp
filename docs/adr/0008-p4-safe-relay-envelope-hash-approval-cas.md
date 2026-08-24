# ADR 0008 — P4 safe relay: envelope-hash approval binding, single-use CAS, and reconciliation

**Status:** accepted (2026-08-09, R1–R8 landed)
**Design doc:** `docs/design/05-p4-relay-design.md` (grok + claude consultations)
**Prerequisites:** ADR 0001 (relay defaults), ADR 0002 (fabric types), ADR 0007 (async-ask late reconciliation — the state machine P4 reconciliation inherits)

## Context

P4 requires relaying a completed provider answer to another provider **only after
approval**, with a complete event trail and safe failure behavior. Two review
findings shaped the core mechanism:

1. **Approval must bind to the EXACT envelope** — canonicalize before hashing,
   hash content + provenance + destination + policy *together* (never content
   alone), single-use, expiring (design §1.2).
2. **Single-use must be compare-and-swap against the append-only store**, not a
   boolean flag (Claude's refinement, design §2).

Plus: no automatic resend ever (§1.3), relay consumes only terminal-success
source events (§1.5), surface-gone is a distinct terminal (§1.6), and
reconciliation reuses the async-ask state machine (§1.7).

## Decision

### R1 — Envelope canonicalization + `envelopeHash`

- `src/core/envelope.ts`: `canonicalJson` (recursive key-sort, undefined
  omitted, no whitespace, arrays never sorted), `canonicalizeEnvelope`
  (content + provenance identity fields + destination + policy, with
  `policyVersion` stamped), `computeEnvelopeHash` (sha256 hex).
- `policyVersion` lives on `RelayControls` (defaults to `RELAY_POLICY_VERSION =
  1`). Bumping it invalidates old approvals against new envelopes.
- `relayedAt` is deliberately EXCLUDED from the hash (transport metadata, like
  `createdAt`/`idempotencyKey`/`correlationId`) — otherwise re-prepare hashes
  diverge and `relay_send`'s hash re-validation could never match the approved
  hash.

### R2 — ContentPersistenceMode contract (per-destination)

- Modes: `full` = content+hashes; `redacted` = metadata-only (hashes, messageId,
  cursor, state, `contentLength` — no content, no PII); `none` = control plane
  only (ids, hashes, status, timestamps — even length omitted).
- `resolveContentPersistenceMode`: explicit override wins; **relay (has
  `destination`) ⇒ `redacted`, native ask ⇒ `full`** — keyed on `destination`,
  NOT `relay.mode`, because native asks carry `CONSERVATIVE_RELAY_DEFAULTS`
  (mode `approval-required`) yet must persist full content for replay safety.
  (Regression caught before commit: keying on mode alone would have silently
  redacted every native ask and broken `replayOutcomeIfRecorded`.)
- Redaction is enforced at the **single `appendEvent` write path**
  (`redactResponseForMode`) — no caller, including escalation paths, can leak.
- Receipts carry the mode (`DeliveryReceipt.persistenceMode`).

### R3 — Relay policy fields + enforcement module

- Fields added: `allowResend` (default **false** — absolute no-auto-resend),
  `maxRelaysPerCorrelation`, `rawMarkdown` (default **false** — security-first),
  plus R1/R2's `policyVersion` and `contentPersistenceMode`.
- `src/core/relay-policy.ts`: `applyRelayPolicyDefaults`, `evaluateRelayPolicy`
  (single fail-closed entry: disabled → destination → approval → **attribution
  (mandatory in approval-required, fail closed)** → size → deadline; returns
  effective policy + `markdownAction`), `neutralizeMarkdown` (strip link URLs to
  text, remove embedded media keeping alt text, fence code blocks — regex-only,
  deterministic).
- Markdown is a **trust-boundary control**: in approval-required mode structural
  markdown is neutralized unless `rawMarkdown: true` opt-in (design §2).

### R4 — `relay_prepare` (3-tool surface, first tool)

- `src/core/relay.ts`: `findRelaySource` (terminal-success ONLY —
  `completed`/`completed_late`, never watching/timed_out/abandoned, §1.5);
  `buildRelayEnvelope` (pure builder, no writes); `prepareRelay`
  (build + eager checks + `envelope.created` trail anchor).
- Eager checks run with **`deferApproval: true`** — prepare builds
  `approved:false` by design; approval is the NEXT step, not a prepare-time
  failure (§3.4).
- Returns `approvalRequired` + `approvalHash`; **never contacts the destination**.

### R5 — `relay_approve` (single-use via CAS)

- Event store: approval index (`approvalHash` → latest row, rebuilt from log on
  load) + `recordRelayApproval` (append-only, first-record-wins per hash,
  control-plane `none` persistence), `getRelayApproval`,
  `consumeRelayApproval`.
- New event type `relay.approval_consumed` + fields `approvalHash` /
  `approvalExpiresAt` / `consumedBySeq` on the event row.
- **CAS**: consume appends `relay.approval_consumed` ONLY if approved +
  unexpired + unconsumed — the compare-and-swap against the append-only store.
- `approveRelay` (default +5min expiry), `rejectRelay` (terminal — never
  consumable).

### R6 — `relay_send`

- Re-validates the recomputed envelope hash against `approvalHash` (hash
  binding — any content/policy/destination drift since prepare ⇒
  `approval_failed`, no consume, no send).
- Policy re-check with approval deferred (the envelope's `approved` flag is a
  placeholder — the approval gate is the store).
- **Fail-fast approval existence check** before surface pre-flight: a hash never
  approved (or rejected) fails `approval_failed` regardless of surface state.
- Surface-gone pre-flight → distinct `surface_gone` terminal, **approval NOT
  consumed** (client may fix the destination and retry with the SAME approval).
- CAS-consume (after pre-flight, before send) → `buildWireContent` (attribution
  header + markdown trust boundary) → `deps.send` → **receipt on every attempt**
  carrying `persistenceMode` + `policyVersion`.
- Provider-neutral: destination injection via `deps: { preflight, send }`;
  `index.ts` wires real drivers (`openTab` + `dispatchAsk`).

### R7 — Reconciliation (inherits ADR 0007)

- `classifyRelayReconciliation` (pure): `in_progress` / `reconciled` /
  `timed_out` (non-terminal, may `completed_late`) / `ambiguous` / `surface_gone`
  / `blocked` / `abandoned`.
- Attribution: providerMessageId PRIMARY, contentHash secondary; a response
  without anchors is **`ambiguous` — never auto-promoted** (§2), fresh approval
  required.
- `reconcileRelay`: read-only probe (never advances the ask, never resends).
- Ordering constraint: soft-expiry states must classify BEFORE the generic
  pending check (ADR 0007 retains the key in `watching`, so timed_out asks are
  still "pending").

### R8 — Crossed-axis test matrix

`test/unit/relay-crossed-axes.test.ts` proves the whole chain across the design
§3.8 axes: policy-drift fail-closed, expired-approval + ambiguous-match,
surface-gone + pending-approval, blocked/timed-out/uncertain without
auto-resend, all three persistence modes, and the no-leak audit (secret appears
exactly once in the log — source event only — under redacted/none).

## Consequences

- **P4 gate satisfied**: a provider answer is relayed only after approval, with
  the complete event trail (envelope → approve → consume → send receipt →
  reconcile) and safe failure (no auto-resend; distinct terminals for
  timed-out / blocked / surface-gone).
- **Full suite: 199/199** unit tests (R1–R8, commits `f652ed3`→`2006ada` on fork
  main).
- Replay-safety preserved: native asks remain `full` mode — the R2 regression
  guard is a permanent test.
- P5 `wait_any` remains HELD until single-item reconciliation is trustworthy in
  live traffic (design §1.8).
- Deferred to P4b: summarization handoff.
