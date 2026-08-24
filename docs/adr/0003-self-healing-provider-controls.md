# ADR 0003: Self-healing provider controls

- **Status:** Accepted
- **Date:** 2026-08-07
- **Decision owners:** Comet-MCP project
- **Inspired by:** Bladebro's Live Page Model (structural fingerprints + confidence-scored selector knowledge base) — reviewed 2026-08-07, repo cloned at `C:\Dev\bladebro`

## Context

Provider entries (`src/providers/entries/*.json`) hold known selectors discovered by the
offline/on-demand discovery workflow (ADR 0002, PR #10). When a provider changes its DOM,
`provider_verify` reports a missing hook and the operator re-runs `comet-mcp discover`.
That is correct but *coarse*: it treats every selector miss as a full repair, and it has
no memory of how a selector has behaved over time, so a flaky selector and a permanently
broken one get the same treatment.

Review of Bladebro surfaced two mechanisms that map directly onto this problem:

1. **Confidence-scored selector knowledge** (`src/knowledge.rs`): per-domain learned
   selectors with asymmetric confidence (success +0.05, failure −0.15), learn-only-from-
   success, eviction below threshold, and a trust threshold above which the stored
   selector is applied directly without full detection.
2. **Structural fingerprints** (`src/page/refs.rs`): an FNV-1a hash of ancestor chain +
   tag + first children + identity attributes computed in-page. When a re-render changes
   text/class but preserves structure, the ref is **rebound** by fingerprint instead of
   invalidated — the "re-render immunity" mechanism. Dead refs go to a bounded graveyard
   so a stale ref can be re-resolved to what it used to point at.

## Decision

### A. Confidence-scored controls (runtime feedback)

Each `ProviderControl` in an entry gains runtime feedback fields, and `provider_verify`
becomes a learning loop:

- `confidence: number` (0..1) — starts at the discovery-time value (HIGH = 0.9,
  MEDIUM = 0.6, LOW = 0.3); then `+0.05` per successful resolve, `−0.15` per failed
  resolve (asymmetric: failures cost 3×, per Bladebro).
- `success_count`, `fail_count`, `last_validated` — audit trail per control.
- **Resolution order becomes confidence-aware** (extending the known → heuristic →
  override chain in `registry.ts`):
  1. `confidence >= 0.7` → resolve by stored selector directly (hot path, no probe).
  2. `confidence < 0.7` → resolve by selector; on miss, fall back to heuristics.
  3. On confirmed failure, decrement; **learn only from success** (a resolve that
     succeeds bumps confidence; a miss never learns a new selector).
  4. `confidence < 0.3` → evict the control's stored selector (keep the entry; the
     control is now heuristic-only) and flag `provider_discover` as needed.
- The `provider_verify` tool reports per-control confidence so drift is visible before
  it becomes a hard failure.

### B. Structural fingerprint rebind (hot-path self-healing)

On a selector miss during an action (`resolve` fails), before escalating to discovery:

1. **Compute the fingerprint** of the previously-resolved element (from the last
   successful capture: ancestor chain ≤10, tag, first-3 children, `type`/`name`/
   `data-testid`) — same in-page JS FNV-1a as Bladebro (`perception.rs`).
2. **Fingerprint-match** against candidate elements on the live page: if a candidate has
   the identical fingerprint, **rebind** the control to that element and continue — the
   re-render survived, no operator action needed. This handles React/Vue re-renders that
   change text/class but preserve structure.
3. **Graveyard**: remember the last N dead control identities (ref id, sig, fingerprint).
   If a control goes missing and later reappears with a matching fingerprint, rebind.
4. **Escalate only on genuine change**: if no fingerprint match exists, the DOM truly
   changed → report `degraded`, and surface `provider_discover <provider> --diff` as the
   repair (the existing workflow). The harness remains the *rare* repair, not the
   routine check.

### Scope boundaries

- Fingerprints apply to **controls** (the 5 known elements per provider entry), not a
  full page model — our problem is narrower than Bladebro's, so no Live Page Model.
- No stealth/browser-identity machinery (canvas noise, behavioral biometrics,
  fingerprint-seed persistence) is adopted — out of scope; we drive an authenticated
  profile, and the session handoff already documents provider-side classifier risk.

## Consequences

### Positive

- `provider_verify` becomes a self-improving loop: selectors earn trust with success and
  lose it faster on failure; the harness is triggered only when confidence drops.
- Re-renders no longer cause false "broken" reports — the fingerprint rebind absorbs
  them invisibly (the `↺ rebind` signal, like Bladebro's `↺ e2 (re-render survived)`).
- Resolution order is explicit and observable: known → fingerprint-rebind → heuristic →
  discovery escalation, with confidence driving the first hop.

### Costs and risks accepted

- Confidence is per-control state in the entries JSON — must be persisted and
  version-controlled; concurrent writers (two MCP sessions verifying the same provider)
  could race, so updates should be read-modify-write with a timestamp guard.
- Fingerprint collisions are possible (FNV-1a 32-bit) but acceptable: the fingerprint is
  a *secondary* signal after the primary selector/sig, not the primary identity.
- The graveyard and fingerprint cache add memory and code surface for a hot path that is
  currently simple; bounded (graveyard cap, fingerprint computed on demand).

## Validation

- Unit test: confidence walks up on success and down on failure, evicts below 0.3,
  never learns from failure.
- Fixture/live test: a re-render (text change preserving structure) rebinds instead of
  degrading; a genuine DOM change degrades and suggests discovery.
- Existing P1 gate holds: extraction behavior unchanged for ten representative prompts.

## Related documents

- [ADR 0001: Browser-tab transport and relay defaults](0001-browser-tab-transport-and-relay-defaults.md)
- [ADR 0002: Conversation fabric type contracts](0002-conversation-fabric-type-contracts.md)
- [P2 runbook: provider discovery](../runbooks/grok-provider-discovery.md) (to be generalized)
- Bladebro reference: `C:\Dev\bladebro` (`src/knowledge.rs`, `src/page/refs.rs`)
