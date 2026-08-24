# ADR 0011 — Status-line completion convention + bounded reminder loop

**Status:** accepted (2026-08-09)
**Predecessor:** ADR 0010 (sentinel completion marker)
**Live evidence:** grok/perplexity full compliance; claude partial (honest about estimates)

## Context

ADR 0010 used a bare random sentinel as the completion marker. The user
expanded the concept (2026-08-09): a **full status line** ending each reply —
`Turn <N>, <MM/DD/YY>, <time> <timezone>, <model>, <context%>, <sentinel>` —
as a **thread convention** (every reply in the session), giving observability
(turn, date, model, context usage) while the sentinel remains the completion
key. Live testing showed models comply (grok/perplexity perfectly; claude
partially, flagging that time/context% are estimates — so the line is
observability, never trusted as truth).

A second gap surfaced: grok once replied *"Understood — I'll apply it going
forward"* without emitting the line. The user proposed a **compliance check +
reminder injection**: when a completed reply lacks the status line, the server
injects a bounded follow-up asking for it, then re-polls.

## Decision

1. **Thread-convention prompt** — `withSentinelInstruction` now says "end EVERY
   reply in this session" with the full status-line format, MM/DD/YY enforced,
   context% formula stated, and the sentinel isolated as `then the code
   <SENTINEL> — nothing after the code` (avoids trailing-punctuation ambiguity
   that would break `endsWith` detection — caught in tests).
2. **Compliance parser** — `parseStatusLine` detects the trailing line, flags
   completeness (all six fields), extracts turn/date/time/model/contextPct.
   Completion keys on the sentinel; field completeness is observability + the
   reminder trigger, never a completion gate.
3. **Sentinel-only strip — status line PRESERVED** (amended 2026-08-10): `stripSentinel`
   removes ONLY the sentinel token + its trailing separator, keeping the full
   status line in the response, event store, and relayed content. The sentinel is
   a control artifact (completion detection) that must never leak; the status
   line is PROVENANCE (which model, when, context pressure) — useful when pulling
   an answer and self-attesting source attribution when relaying (the receiving
   model sees "Grok 4.5, 2%" in the content). Caveat: model/context% are
   self-reported estimates (claude flagged this) — provenance flavor, never
   trusted over the server's own records.
4. **Bounded reminder loop** — when a completed reply lacks the sentinel and a
   reminder was not yet sent, `advanceAsk` injects ONE `statusLineReminder`
   (asks for ONLY the line, verbatim) and stays pending; the next poll re-checks.
   After the reminder, non-compliance falls back to the normal stability path.
   The reminder is only ever injected for `completionMarker: true` asks
   (thread-pollution rule respected).
5. **Sentinel = definitive completion** — sentinel presence finalizes
   immediately (no hash-confirmation), because the model was instructed to put
   it last with nothing after; native markers keep hash-confirmation (they could
   theoretically appear mid-stream). This also makes the post-reminder case work
   (the status line legitimately grows the content, so hash-confirm would fail).

## Consequences

- All 5 providers are authoritative-eligible: grok/perplexity native markers +
  optional status line; gemini/chatgpt/claude via the status line. The status
  line is an ADDITIONAL signal for grok/perplexity (more robust), not a
  replacement.
- A non-compliant model gets one bounded nudge, then falls back — never stuck.
- Context% / time are model estimates (claude flagged this honestly) — recorded
  as observability, never used for token accounting or as truth.
- The `reminder_sent` status renders honestly; the advancer (ADR 0010-adjacent)
  can drive the compliance loop between client polls.

## Amendments (2026-08-10, live council-test bugs)

5. **Native-marker authoritative requires a prior poll** (`852f96e`): grok renders
   the timing line (`Worked for Xs`) at the START of the message while the answer
   streams below — a marker on the FIRST poll must NOT complete/remind
   mid-stream. Authoritative now needs `prevHash !== null` (prior poll) AND hash
   equality; only `sentinelConfirmed` bypasses cold-start. Fixes the reminder
   interrupting grok mid-answer.
6. **Tab reset invalidates the session sentinel** (`108b405`): the status-line
   instruction is a THREAD convention. `tabRegistry.reset()` now fires an
   `onReset` observer; the driver clears the tab's sentinel so the next
   completionMarker ask re-injects the instruction with a FRESH sentinel.
   Without this, the first ask in a reset tab was sent RAW (no status-line
   section) and the reminder fired on the tokenless completion (perplexity live
   bug).
7. **Status-line SHAPE without the token is compliant** (`9033c5a`): a trailing
   `Turn <N>, <MM/DD/YY>, <time> <tz>, <model>, <context%>` line (no sentinel)
   means the model followed the convention and just dropped the control
   artifact — NO reminder fires; the reply completes through the stability/hash
   path. `parseStatusLineShape` detects the shape.
8. **Prompt-landed guard before submit** (`9033c5a`): `composer-emptied` as the
   only verification false-positives when the composer was ALREADY empty (fresh
   tab — typeInto hit a not-ready element). `BaseChatDriver.ask` now verifies
   the prompt text is actually in the composer (`promptLandedIn`) before
   submitting; otherwise the ask is `blocked` (never `sent`), so the reminder
   loop cannot inject technical prompts into a thread that never got the real
   question.
