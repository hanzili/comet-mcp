# Async-ask timeout → late reconciliation (robust solution)

**Status:** design — synthesized 2026-08-08 from four independent analyses
**Sources:** code-verified analysis of `src/drivers/index.ts` / `src/index.ts`
(15s ask budget, `advanceAsk` destructive cleanup, poll fall-through);
[Gemini consultation](../../responses/gemini-async-ask-timeout-consultation-2026-08-08.md)
(independent, convergent — options 2+3+4, `timed_out_watching`, `completed_late`, TTL GC);
[Claude consultation](../../responses/claude-async-ask-timeout-consultation-2026-08-08.md)
(corrects both: one-shot receipt guard, poll-independent reaper, timeoutMs conflation);
[Grok consultation](../../responses/grok-async-ask-timeout-consultation-2026-08-08.md)
(full endorsement of Claude's design; HARD_TTL_MS sizing guidance).

## 1. Verified problem (reproduced live 2026-08-08: claude PONG delivered, bridge reported TIMED_OUT)

1. `dispatchAsk` records a pending ask with `timeoutMs: opts.timeoutMs ?? 15000`
   (`src/drivers/index.ts:707`) — a 15-second default ask budget.
2. `advanceAsk` checks `Date.now() - p.startTime >= p.timeoutMs` BEFORE polling
   (`:727`) and on expiry **deletes the pending entry**, records
   `send.timed_out` + a `timed_out` delivery receipt, and returns a
   `timed_out` outcome.
3. The browser-side generation is unaffected (the driver's `ask` already
   submitted; CDP keeps streaming) — so the response appears in the tab while
   the bridge reports "TIMED_OUT" and drops the correlation key.
4. Subsequent polls fall through to plain `driver.poll` (no receipt/dedup/
   `provider_response` linkage). Idempotency + reconnect-dedup for that ask
   are lost; the completed DOM answer is unreachable via `provider_response`.

The 15s default is unrealistic for every real generation (submit ladders ~4s,
streaming, 8s stability window; Perplexity research mode: minutes). The gate
never hit this because `askAndWait(timeoutMs)` polls directly with its own
budget — two paths through the same drivers.

## 2. Convergence (three opinions)

Gemini's analysis (extracted from the active tab) independently reached the same
root cause, the same five options, and the same recommended combination (2+3+4).
Unique additions from Gemini: the explicit **`timed_out_watching` state**, the
**`completed_late` receipt status**, and the **TTL/GC requirement**.

Claude's analysis (extracted from the active claude tab) confirms 2+3+4 and adds
the sharpest framing plus three concrete corrections:

1. **`timeoutMs` conflates two concerns** (Claude's root-cause reframe): "how long
   the client waits before giving up" vs "how long the correlation key is valid".
   They should never be the same value — the 15s default only determines how often
   you hit the bug; **the bug is that expiry is destructive**. Once expiry stops
   being destructive, #2 (the default number) becomes a **UX tuning knob** — it
   only changes when the client first sees "still working" — not correctness.
2. **One-shot transition guard**: the expiry transition must fire the `timed_out`
   receipt exactly ONCE (`p.phase === 'active' &&` guard). Gemini's sketch lacked
   this — since `elapsed >= timeoutMs` stays true, it would emit N duplicate
   `timed_out` receipts during the watching window, polluting the audit trail.
3. **Poll-independent reaper**: GC must NOT depend on client polling — an
   abandoned ask is by definition never polled again. A lazy sweep on
   `advanceAsk`/`dispatchAsk` (my earlier draft) doesn't bound the Map. The
   reaper is a `setInterval` sweep (60s cadence, `HARD_TTL_MS` 30min) that
   purges and records an `abandoned` receipt.
4. Claude also flags: the "94/94 stays green" claim is optimistic — existing
   tests likely assert hard-delete-on-timeout and must be **updated**, not just
   augmented; and the comet-bridge wrapper may have its own copy of the timeout
   logic (uninspectable) — the render fix must be verified/mirrored there.

Grok's analysis (retrieved through comet-mcp itself) **fully endorses Claude's
design** — "ship Claude's three-state machine + independent reaper; the minimal
complete design that closes every gap" — and adds one piece of tuning guidance:
**HARD_TTL_MS should be sized against the longest realistic generation**
(Perplexity research mode, heavy multi-step agents) plus a safety margin;
30 min is a reasonable starting point. No new structural changes — the
four-opinion consensus is complete.

Refinements applied to Gemini's sketch before adoption (from the code):

- The watching poll must reuse the existing `beforeHash`/`sawNewResponse` +
  `completionStability` logic — a bare `result.isComplete` could finalize on a
  stale DOM response (Claude's sketch uses `isComplete`; the real implementation
  keeps the existing stability machinery).
- The `send.timed_out` event and `timed_out` receipt stay recorded (append-only
  truthfulness); the late path appends `response.received` + a `completed_late`
  receipt — both rows coexist.
- The late path applies `hasResponseHash` dedup exactly like the active path.

## 3. Solution — ask state machine with late reconciliation

### 3.1 State transitions (`PendingAsk` gains `phase`)

```text
            dispatch
                │
                ▼
           ┌─────────┐    budget expired (first time)     ┌────────────────┐
           │  active │ ──────────────────────────────────▶ │    watching    │
           └─────────┘                                     └────────────────┘
                │  poll: completed & stable                      │
                │  (existing path)                               │  poll: completed & stable
                ▼                                                ▼
           terminal: response.received + receipt completed   terminal: response.received + receipt completed_late
```

- **active** (today's behavior): poll → stability window → finalize or keep.
  Budget expiry on an `active` entry → **one-shot transition** (guarded by
  `p.phase === 'active'`): move to **watching** (KEEP the key), record
  `send.timed_out` + `timed_out` receipt exactly once, return the timed_out
  outcome to the client.
- **watching**: budget no longer checked. Each poll runs the tab poll; if
  `poll.state === 'completed'` AND `sawNewResponse` AND the stability window
  holds → finalize exactly like the active path but with receipt status
  `completed_late` and `AskOutcome.completed = true` + `late: true`; delete the
  key. Otherwise return an in-progress view with status `'watching'` (distinct
  from `'active'` — renders honestly, §3.4).
- **Poll-independent reaper (Claude correction)**: a `setInterval` sweep (60s
  cadence) purges any entry older than `HARD_TTL_MS` (30 min default) and
  records an `abandoned` receipt — bounds the Map even when a client never
  polls again. Not a lazy sweep: abandoned asks are never polled.

### 3.2 Default budget alignment (UX tuning, per Claude's reframe)

`src/drivers/index.ts:707`: `opts.timeoutMs ?? 15000` → `?? 120000` (2 min —
when the client first sees "still working" vs a deadline; per-call `timeout`
override remains; 300000 = exact envelope wall-clock alignment, available as a
documented max). Correctness does NOT depend on this number — expiry is
non-destructive (§3.1); #2 only tunes the client-visible cadence.

### 3.3 Receipts + dedup + replay integration

- Receipt stream: `timed_out` then `completed_late` (append-only — truthful).
- `hasResponseHash(correlationId, hash)` check applied in the late-finalize
  path → `response.deduplicated` when the same content was already recorded.
- `replayOutcomeIfRecorded` already keys off `response.received` — a
  late-reconciled response IS a `response.received`, so replays work unchanged.

### 3.4 Honest rendering (`renderInProgress`)

- `active` + not done → "Task in progress…" (unchanged).
- `watching` → "Client poll deadline reached — background task still running.
  Retrying poll…" (status `watching` — a genuinely distinct value, per Claude:
  the render has nothing honest to key off without it).
- Fresh timeout transition → "Ask deadline expired — will keep watching the tab
  for a late completion." (No more "Task in progress … Status: TIMED_OUT".)
- **Wrapper caveat (Claude)**: the comet-bridge wrapper (source not on this
  machine) may have its own copy of this render/timeout logic — fix #4 is
  verified against comet-mcp core only; mirror/verify in the wrapper before
  calling it done.

## 4. Test plan (extend `test/unit/async-ask.test.ts`)

1. Budget expiry → returns `timed_out` outcome BUT `isAskPending(key)` stays
   true and phase is `watching` (entry retained — the core behavioral change).
2. Late poll after expiry with a completed fixture DOM → `completed` outcome +
   `late: true`; event store shows `send.timed_out` → `response.received` →
   receipt `completed_late` (both receipts coexist).
3. Late poll while the DOM is still streaming → `watching` outcome, NOT
   completed (no premature finalize on a non-stable response).
4. Stability window still enforced in the watching phase (two polls required).
5. Dedup preserved across the transition: same correlation + same hash → dedup
   event, no duplicate `response.received`.
6. **One-shot receipt (Claude)**: repeated polls during the watching window
   produce exactly ONE `timed_out` receipt — no duplicate audit rows.
7. **Reaper (Claude)**: an entry past `HARD_TTL_MS` is purged by the interval
   sweep even with NO polls, recording one `abandoned` receipt.
8. **Update existing tests (Claude sanity check)**: tests asserting
   hard-delete-on-timeout (`isAskPending === false` after expiry) flip to the
   new retained-until-reaped semantics.
9. Existing 94 tests remain green except the deliberate flips in (8).

## 5. Task checklist

- [x] **A1** `PendingAsk.phase: 'active' | 'watching'` + `HARD_TTL_MS` const (30 min).
- [x] **A2** `advanceAsk`: one-shot expiry transition (guard `phase === 'active'`)
      → watching; watching path polls → finalize with `completed_late` (reusing
      beforeHash/sawNewResponse/completionStability/hasResponseHash).
- [x] **A3** **Poll-independent reaper** (Claude): `setInterval` 60s sweep purging
      entries past `HARD_TTL_MS`, recording an `abandoned` receipt. (Not a lazy
      sweep.)
- [x] **A4** Default `timeoutMs ?? 15000` → `?? 120000` (UX tuning).
- [x] **A5** `renderInProgress` honest states (`watching` distinct value, late
      hints); `AskOutcome.late?: boolean`; verify/mirror in the comet-bridge
      wrapper (Claude caveat).
- [x] **A6** Tests §4 (incl. flipping hard-delete assertions to retained-until-
      reaped). Full suite green — **98/98** (4 new).
- [x] **A7** Docs: ADR 0007 (async-ask late reconciliation), gotchas.md #13
      (ask budget 2 min; late completion surfaces as `completed_late`), build-plan
      async-ask section.
