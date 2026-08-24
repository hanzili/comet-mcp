# CLAUDE.md

## What This Is
MCP server connecting Claude Code to Perplexity's Comet browser — and, since P0–P6, to Grok, Gemini, ChatGPT, and Claude.ai — via Chrome DevTools Protocol (CDP). Multi-provider conversation backbone with an append-only event store and P4 safe relay.

## Architecture
```
MCP client → MCP Server (src/index.ts) → provider drivers (src/drivers/*.ts)
  → CDP session pool (src/cdp-pool.ts) / tab registry (src/tab-registry.ts)
  → CDP Client (src/cdp-client.ts) → Comet Browser (per-provider tabs)
```
Core fabric: `src/core/event-store.ts` (append-only JSONL log + idempotency index +
durable cursors + receipts + relay approval CAS), `src/core/envelope.ts` (R1 canonical
hash), `src/core/relay-policy.ts` (R3 enforcement + markdown trust boundary),
`src/core/relay.ts` (R4–R7 prepare/approve/send/reconcile).

## Tools (22 MCP tools)
- `comet_connect` / `comet_ask` / `comet_poll` / `comet_stop` / `comet_screenshot` / `comet_mode` — Perplexity aliases
- `provider_open` / `provider_list` / `provider_close` / `provider_health` / `provider_override` / `provider_discover` / `provider_verify` / `provider_reconnect`
- `provider_ask` / `provider_poll` / `provider_stop` / `provider_response` — provider-neutral ask/poll (async dispatch + late reconciliation, ADR 0005/0007)
- `relay_prepare` / `relay_approve` / `relay_send` / `relay_reconcile` — P4 safe relay (R1–R8, ADR 0008)

## Key Implementation Details

**Response extraction** (`src/providers/extraction.ts`):
- Takes LAST prose element (not longest) - conversation threads show newest last
- Joins ALL prose blocks (Perplexity fragments long answers across many blocks)
- Filters out UI text (Library, Discover, etc.) and questions (ends with ?)

**Follow-up detection** (`src/drivers/index.ts`):
- Captures old prose count/text before sending
- Waits for NEW response (different text or more elements)
- Completion stability (2026-08-09, confidence-tiered): `completionConfidence` on
  PollResult — authoritative (provider-native end-of-answer marker, message-scoped)
  finalizes hash-confirmed & timer-free; heuristic (stop-absent w/ stop control,
  Perplexity steps-only) 3s window; weak (response-present, no marker) 8s window.
  Missing confidence ⇒ weak (fail-closed). `completionStability(windowMs)` is pure.
  Amendments (2026-08-10): (a) authoritative native markers ALSO require a prior
  poll (`prevHash !== null`) — grok's `Worked for Xs` renders at message START
  while the answer streams, so a cold-start marker must not complete/remind
  mid-stream; only the sentinel bypasses cold-start. (b) A trailing status-line
  SHAPE without the token (Turn N/date/time/model/%) is compliant-enough — NO
  reminder fires, the reply completes via the stability path (`parseStatusLineShape`).
  (c) A tab reset (`tabRegistry.onReset`) clears the session sentinel — the next
  completionMarker ask re-injects the instruction with a fresh token. (d) `ask`
  verifies the prompt text LANDED in the composer (`promptLandedIn`) before
  submitting — composer-emptied alone false-positives on fresh tabs.

**Prompt normalization**: strips bullet points, collapses newlines to spaces.

**Async ask** (ADR 0005/0007): `provider_ask` dispatches fire-and-forget; `provider_poll`
advances via `advanceAsk` (soft expiry → `watching` → `completed_late`; reaper purges
abandoned after 30min hard TTL). Full responses are file-backed (`responses/*.md`,
24h TTL, max 100) and fetched via `provider_response` (chunked) — the pi gateway caps
tool results, so long content never returns inline.

**P4 safe relay** (ADR 0008): relay only after approval. `relay_prepare` builds +
hashes the envelope (content+provenance+destination+policy, policyVersion stamped);
`relay_approve` records append-only approval keyed by hash (single-use CAS consume);
`relay_send` re-validates hash binding + policy, pre-flights surface-gone (approval
preserved), CAS-consumes, sends with provenance header + markdown neutralization,
receipt on every attempt; `relay_reconcile` is a read-only probe (inherits async-ask
soft-expiry, `RELAY_SURFACE_GONE` terminal, ambiguous never auto-promoted).

**Content persistence modes** (R2): `full` / `redacted` / `none` — enforced at the
single `appendEvent` write path; native asks default `full` (replay-safe), relays
default `redacted` (metadata-only, no content leak).

## Build & Test
```bash
npm run build          # tsc
node --test test/unit/*.test.ts   # full unit suite (236/236 as of 2026-08-10)
```
Manual testing only (integration code, external DOM dependency). After rebuilds,
**kill the stale bridge process** (gotcha #7): the pi gateway caches the comet-bridge
node process across rebuilds — find it via `Get-CimInstance Win32_Process where
CommandLine match 'comet-mcp' and Name eq 'node.exe'` → Stop-Process.

## Test Cases
1. **Quick queries** - Simple questions (math, facts) should return within 15s
2. **Non-blocking** - Short timeout returns "in progress", use poll to get result
3. **Follow-up** - Second question in same chat detects NEW response correctly
4. **Agentic task** - "Take control of browser and go to X" triggers browsing
5. **newChat after agentic** - `newChat: true` resets CDP state after browser control
6. **Mode switching** - `comet_mode` changes search/research/labs/learn
7. **Multi-provider** - Each provider (perplexity/grok/gemini/chatgpt/claude) has its own pooled tab (cap 5)
8. **Relay chain** - provider_ask → relay_prepare → relay_approve → relay_send → relay_reconcile

## Known Edge Cases
- **Prompt not submitted**: If response shows 0 steps + COMPLETED, prompt may not have been submitted. Retry or use newChat.
- **Stale poll response**: If poll returns unrelated response, the previous prompt failed. Send again.
- **Research mode**: Takes longer than search mode, may need multiple polls.
- **TIMED_OUT is normal** (soft expiry): poll again — the bridge is still watching the tab; a late answer recovers as `completed_late`.
- **NEVER pollute real provider threads with test prompts** — test prompts (PING/PONG/etc.) go in a dedicated deletable tab (user rule 2026-08-07).
- **After a tab reset, the FIRST ask must carry the status-line instruction** (2026-08-10): a reset kills the thread; the session sentinel is cleared via `tabRegistry.onReset`, so the next `completionMarker` ask re-injects it. If you see a reminder fire right after opening/resetting a tab, the prompt never landed — check the ask was `sent` (not `blocked`) and the thread actually shows the question.
- **Reminder firing with no normal prompt in the thread = the ask never rendered** (2026-08-10 user report): `promptLandedIn` blocks the submit when the text isn't in the composer; `blocked` receipt means the fresh-tab guard fired — do NOT re-dispatch blindly, fix the tab state first.
