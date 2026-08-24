# ADR 0009 — Confidence-tiered completion finalization (latency fix)

**Status:** accepted (2026-08-09, Grok 4.5 consult-validated)
**Commit:** `4138252` (216/216 tests)
**Design note:** wiki obs `comet-mcp completion-latency redesign converged`; consult response in Perplexity tab

## Context

`MIN_COMPLETION_STABILITY_MS = 8000` (ADR-verified 2026-08-07) required the
response hash to be unchanged for 8s before `advanceAsk` finalized a completed
poll. This was a workaround for Grok's mid-stream pauses and missing stop
button (a truncated 1592/10205-char answer was latched). But it was applied
**uniformly** — even when the driver had already observed a provider-native
end-of-answer marker. Live result: a fully-rendered Grok answer waited through
~25s of CONFIRMING polls before finalizing.

## Decision

Completion confidence is now surfaced from each driver and honored at the gate.

1. **`PollResult.completionConfidence?: 'authoritative' | 'heuristic' | 'weak'`** —
   absent ⇒ **weak** (fail-closed). Drivers own their markers; the fabric only
   sees confidence.
2. **Per-marker, message-scoped classification** (never per-provider blanket):
   - Grok: "Worked for Xs" timing line **inside the last assistant message**
     (same node extraction uses) ⇒ authoritative; `lastMessageLen > 0`
     fallback ⇒ weak.
   - Perplexity: "Ask a follow-up" / "Finished" ⇒ authoritative; "N steps
     completed" alone ⇒ heuristic (may precede final synthesis); stop-absent ⇒
     weak.
   - Base (gemini/chatgpt/claude): stop-absent with a defined working signal ⇒
     heuristic; response-present without ⇒ weak.
3. **Gate** (`advanceAsk`): authoritative = hash-confirmed, timer-free
   (`prevHash === null || hash === prevHash`); heuristic/weak use
   `completionStability(hash, prevHash, stableSince, now, windowMs)` with
   `CONFIDENCE_WINDOWS = { authoritative: 0, heuristic: 3000, weak: 8000 }`,
   entry override (`signals.completed.windowMs`) wins. `sawNewResponse` is never
   bypassed; `pendingAsks.delete(key)` is the finalization lock; `prevHash`
   advances on every poll (miss-path bookkeeping).
4. **`completionStability(windowMs)`** gains a parameter (default 8000) — pure,
   existing weak-path tests unchanged.
5. **relay_prepare bounded source auto-advance**: a pending SOURCE ask is
   advanced up to 3 steps / ~10s wall before declaring no terminal-success —
   a just-finished source relays without a client round-trip.

## Consequences

- Authoritative providers (grok, perplexity) finalize on the **first completed
  poll** — the 8s/25s stall is gone; live-validated on all 5 providers.
- Heuristic providers wait ~3s (down from 8s) — still anti-truncation-safe.
- The 8s window remains ONLY for weak signals — the exact case where truncation
  was actually observed.
- Dual `response.received` events are possible if content grows after an early
  authoritative finalize; relay picks the newest terminal (`findRelaySource`
  reverse scan) — tested. `response.amended` hardening is a follow-up (ADR 0010).
- Perplexity "N steps completed" stays heuristic until live evidence shows it
  never precedes final synthesis.
