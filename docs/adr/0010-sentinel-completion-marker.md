# ADR 0010 — Sentinel completion marker (authoritative completion for base providers)

**Status:** accepted (2026-08-09, live compliance validated)
**Commit:** (this change)
**Predecessor:** ADR 0009 (confidence-tiered completion finalization)

## Context

ADR 0009 left gemini/chatgpt/claude at `heuristic` (3s stability window) because
none exposes a provider-native end-of-answer marker like Grok's "Worked for Xs"
or Perplexity's "Ask a follow-up" — `stop-absent` alone is the untrustworthy
signal the 8s window was designed around. The user proposed (2026-08-09):
**prompt the model to end its response with a special character, and treat its
presence as the completion signal** — the sentinel-token pattern used by LLM
serving infrastructure (`<|im_end|>`, `</s>`).

## Evidence (live, 2026-08-09, dedicated test tabs)

All three base providers emitted the exact random sentinel as the FINAL token,
nothing after it, on its own line:
- gemini: `…Canberra is the capital of Australia.\n\nZz9Xq2Gm`
- chatgpt: `…The Pacific Ocean is the largest ocean…\n\nQw7Rt3Ks`
- claude: `…highest freestanding mountain in the world.\n\nMx4Pv8Ln`

Clean strip pattern: `\n<SENTINEL>\s*$`.

## Decision

1. **Opt-in `completionMarker: true`** on `provider_ask`/`dispatchAsk` (respects
   the thread-pollution rule — real threads stay clean; the flag is for relay
   sources and dedicated tabs).
2. **Random per-ask sentinel** (`generateSentinel()`, 10-char mixed-case, no
   confusable chars) appended via `withSentinelInstruction(prompt, sentinel)`:
   `end your response with the exact string <SENTINEL> — nothing after it.`
   Carried on the PendingAsk entry.
3. **Strip before hash/persist/relay** — `stripSentinel()` removes a terminal
   sentinel (own line + trailing ws) in `advanceAsk` BEFORE the content hash is
   computed, so stored content, contentHash, and relayed wire are sentinel-free.
   The hash is recomputed from the stripped response (`simpleHash`).
4. **Confidence feed** — sentinel found ⇒ `completionConfidence:
   'authoritative'` ⇒ the existing gate is hash-confirmed + timer-free (0s).
5. **Fail-safe** — non-compliant model (no sentinel) ⇒ falls back to the normal
   heuristic/weak stability path (no worse than today). Sentinel presence is a
   sufficient condition, never necessary.

## Consequences

- gemini/chatgpt/claude can go from heuristic (3s) to **authoritative (0s)**
  when the caller opts into `completionMarker` — the live gate target.
- Thread content is minimally altered (one technical line in the prompt) but the
  sentinel is stripped from everything durable, so it never leaks to storage,
  replay, or relay destinations.
- The 3s heuristic window remains the default for all asks — `completionMarker`
  is an explicit opt-in.
- `response.amended` (ADR 0009 follow-up) handles the residual edge of content
  growing after an early sentinel finalize.
