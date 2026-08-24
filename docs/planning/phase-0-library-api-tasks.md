# Phase 0 — Granular task list (facade unlock)

**Repo:** MrJ55/comet-mcp (this repo)  
**Consumer:** MrJ55/comet-api  
**Worker profile:** code agent (e.g. DeepSeek V4 Flash) — prefer small PRs, one subsection at a time  
**Goal:** Non-MCP callers can `dispatchAsk` → engine-owned advancement → `getResponse` on all five providers without client `provider_poll`.

**Companion:** [`phase-0-library-api-tasks-addendum.md`](./phase-0-library-api-tasks-addendum.md) — PR acceptance staging, hard vs full DoD, process ownership, comet-api handoff.  
**Precedence:** this file wins on product contracts (`askId`, status, idempotency, extraction); the addendum wins on PR gates, process ownership, DoD tiers, and handoff steps. See also [`README.md`](./README.md).

## Architectural boundary

Phase 0 makes the existing comet-mcp engine consumable as a library. It does **not** create a second engine, scheduler, completion detector, event store, reaper, or relay implementation.

**Extraction invariant:** Phase 0 must expose/extract a library facade **around the existing engine**, not build a second engine alongside it. `dispatchAsk`, `advanceAsk`, completion detection, PendingAsk lifecycle, event/response persistence, tab ownership, soft-expiry/reaper, and relay semantics remain implemented by their existing authoritative components. New Phase-0 modules may coordinate or expose those components, but must not duplicate their state machines, registries, completion logic, or durable stores.

The engine runtime owns the background advancer. Consumers call the stable library facade; they do not manually drive `advanceAsk()` or implement polling. MCP handlers and comet-api must use the same engine functions.

The runtime must have an explicit lifecycle boundary (preferred: `createEngine()` / `engine.close()`, or an equivalent existing abstraction): importing the library must not start MCP stdio, and startup/shutdown must not accidentally create duplicate advancers.

**Preferred handle model:** facade operations take an explicit `engine` handle (or are methods on it). Avoid a process-global singleton for production paths so tests and multi-instance use stay safe. Document any temporary singleton only if required by existing MCP wiring.

**Repeated `createEngine`:** Prefer failing a second create in-process with `ENGINE_ALREADY_OWNED` (or equivalent) until `close()`; alternatively return the same handle only if existing MCP wiring requires it. Details: addendum §2.

The advancer is a driver of the existing ask lifecycle, not a second lifecycle authority. Existing PendingAsk, event-store, response-store, completion detection, soft-expiry/reaper, tab registry, and relay safety semantics remain authoritative. Soft-expiry/reaper: **start or attach only** — do not reimplement.

**Public ask identity:** Prefer one public name in the library facade — **`askId`** (treat existing `correlationId` as an alias of the same value if both appear in code today). Document the chosen name and any alias in the lifecycle note so comet-api does not invent a third identifier.

## Out of scope (do not do in Phase 0)

- [ ] MCP tool `wait_any` (full P5a public API)
- [ ] `run_plan` / `step_plan` (P5b)
- [ ] P7 orchestration
- [ ] HTTP server / OpenAI routes (that is comet-api Phase 1)
- [ ] Copying engine sources into comet-api
- [ ] Broad new tool-calling / MCP-Bridge work
- [ ] Changing P4 relay safety semantics
- [ ] General-purpose admission queueing for busy tabs
- [ ] Distributed lease systems (Redis, etcd, etc.) — single-process ownership only

## Definition of Done (Phase 0 exit)

Phase 0 uses **two DoD tiers** (full detail in the addendum §4):

| Tier | Purpose |
|---|---|
| **Hard facade-unlock DoD** | Unblocks comet-api. Engine library + advancer + contracts + runbook; ≥1 live provider (prefer Perplexity) **or** mock/fixture + explicit live waiver. |
| **Full Phase 0 provider badge** | Release-quality target. All five providers live/scripted or documented waiver per provider. Does **not** block starting comet-api against a hard-DoD SHA. |

### Hard facade-unlock checklist

- [ ] Documented library entrypoint importable without starting MCP stdio
- [ ] Explicit engine runtime startup/shutdown owns exactly one internal advancer; reaper start/attach only
- [ ] **Facade/extraction invariant verified** (not prose-only). Minimum verification:
  - Symbol map marks each new Phase-0 module as *wrap/delegate* vs *new behavior*
  - Library path and MCP path invoke the same underlying ask lifecycle, completion/persistence components, and authoritative state (e.g. shared module imports / same registry or event-store entry in a unit or smoke test)
  - No duplicate engine, PendingAsk registry, completion detector, event store, response store, or reaper is introduced
- [ ] Internal advancer completes asks with **zero** client polls/manual `advanceAsk()` calls
- [ ] Status vocabulary frozen: markdown table **and** a single exported TypeScript union/enum + pure `usable(status)` used by snapshots and tests
- [ ] Only `completed` is a successful/usable completion; terminal failure states remain non-usable
- [ ] Public facade uses a single primary ask identity name (`askId`; `correlationId` only as documented alias if required by existing code)
- [ ] Idempotent retry: same `idempotencyKey` + same request identity replays the original ask/outcome with no second send
- [ ] Same `idempotencyKey` + different request identity returns `IDEMPOTENCY_CONFLICT`
- [ ] Idempotency fingerprint field list recorded from existing dispatch payload (before or with D2 implementation)
- [ ] Restart/reinitialization behavior for unfinished asks is documented and tested where practical
- [ ] **Default CI gate is scripted/mock**; at least one live provider gate preferred, or explicit waiver with issue link
- [ ] `docs/build-plan.md` notes P5b/P7 deferred; facade Phase 0 unlocked
- [ ] Unit tests still green; add tests for new modules
- [ ] Short runbook: how comet-api (or a script) should call the library

### Full provider badge (quality target; not a hard gate for comet-api)

- [ ] Live or scripted evidence for perplexity, grok, gemini, chatgpt, claude (or waiver + issue per provider)
- [ ] Multi-turn follow-up for Perplexity + one other
- [ ] Latency/status/replay recorded per provider

---

## Workstream A — Inventory, runtime boundary, and freeze (read-first)

### A1. Map current ask lifecycle symbols
- [ ] Locate `dispatchAsk`, `advanceAsk`, PendingAsk registry (likely `src/drivers/index.ts`)
- [ ] Locate response store / `provider_response` path
- [ ] Locate event-store append + idempotency (`src/core/event-store.ts`)
- [ ] Locate tab registry + pool (`src/tab-registry.ts`, `src/cdp-pool.ts`)
- [ ] Locate stop/cancel if any (`provider_stop`)
- [ ] **For each lifecycle responsibility, identify the existing authoritative component and record it in the symbol map.** At minimum: dispatch, PendingAsk state, completion detection, event persistence, response persistence, tab ownership, soft-expiry/reaper, and relay safety.
- [ ] **For every new Phase-0 module, record whether it wraps/delegates to an existing component or introduces genuinely new runtime behavior. No new module may become a second authoritative implementation of an existing lifecycle responsibility.**
- [ ] Record current ask identity symbols (`correlationId`, any `askId`, response ids) and decide the public facade primary name (`askId` preferred; document aliases)
- [ ] While mapping dispatch payload fields, **draft the idempotency fingerprint field list** (deterministic subset; exclude timestamps / correlation ids) for use in D2 — record it in the symbol map or lifecycle note so D2 does not invent fields later
- [ ] Write a short symbol map table at the top of a new `docs/planning/phase-0-symbol-map.md` OR in the PR description

**Symbol map must include:** authoritative component per responsibility; wrap-vs-new for any planned Phase-0 module; public `askId` naming decision; draft fingerprint fields.

### A2. Define engine runtime ownership
- [ ] Identify the object/module that owns engine startup and shutdown
- [ ] Prefer concrete API shape:
  - `createEngine(opts?)` → `Engine` handle
  - `engine.close()` graceful shutdown (idempotent)
  - Facade ops take `engine` (or are methods on it); no implicit duplicate runtime on random API calls
- [ ] **Second `createEngine` in-process:** prefer `ENGINE_ALREADY_OWNED` (or equivalent) until `close()`; same-handle return only if MCP wiring requires it (addendum §2)
- [ ] Define one advancer instance per engine runtime; importing the library alone must not start MCP stdio or an advancer
- [ ] Soft-expiry/reaper: start or attach to the **existing** authoritative machinery only — do not reimplement
- [ ] Define graceful shutdown: finish in-flight work or release ownership cleanly; no orphaned timers/workers
- [ ] Document whether unfinished asks are reconstructed from existing durable state after restart; do not invent a second durable queue
- [ ] Add a short ADR/note if the runtime boundary is not already explicit

**Acceptance:** A consumer can create/start one engine, use the library facade, then close it deterministically; MCP startup is a thin adapter over the same runtime.

### A3. Freeze status vocabulary
- [ ] Confirm engine statuses actually emitted today: at least `in_progress`, `confirming`, `completed`, `watching`, plus failure/tab-closed paths
- [ ] Document final enum in `docs/planning/phase-0-lifecycle.md` (or ADR snippet)
- [ ] Export a single TypeScript union/enum (e.g. `AskStatus`) as the machine contract; keep the markdown table as the human contract
- [ ] Define pure `usable(status): boolean` — only `completed` is usable for OpenAI-shaped success; unit-test it
- [ ] Distinguish terminal from successful: e.g. `completed` = terminal+usable; `failed`/`tab_closed`/`cancelled` = terminal+not usable; `watching` = non-terminal+not usable
- [ ] Document that HTTP wait cancel ≠ ask cancel (for facade later)

**Acceptance:** One markdown table: status → terminal? → usable? → advancer action; plus exported TS type + `usable()` tests.

---

## Workstream B — Library API surface

### B1. Choose export shape
- [ ] Prefer new module e.g. `src/engine.ts` or `src/engine/index.ts` that re-exports a stable facade
- [ ] Keep MCP `src/index.ts` as thin wrapper calling the same functions
- [ ] Update `package.json` `exports` / `main` / `types` so Node can `import { … } from 'comet-mcp'` or `comet-mcp/engine` without running MCP server
  - Example dual export intent: `"."` → MCP entry; `"./engine"` → library facade (no stdio side effects)
- [ ] Keep engine lifecycle explicit; do not make individual API calls implicitly start duplicate runtimes
- [ ] PR-2 may ship `createEngine`/`close` with a no-op or stub advancer so smoke tests can create/close without the full loop

### B2. Implement/export tab operations
- [ ] `listTabs()` / existing registry list
- [ ] `openTab(provider, opts?)`
- [ ] `closeTab(tabId)`
- [ ] `getTabHealth(tabId|provider)`
- [ ] `reconnectTab(tabId)` if present
- [ ] Errors: tab missing, cap exceeded — typed or stable error codes

### B3. Implement/export ask operations
- [ ] `dispatchAsk({ provider, tabId?, prompt, idempotencyKey, … })` → `{ askId, idempotencyKey, status }` (use `askId` as the public field; if existing code returns `correlationId`, alias it to the same value and document)
- [ ] `getAsk(askId | idempotencyKey)` → snapshot including status, tabId, timestamps, responseId?
- [ ] `advanceAsk(id)` — **internal/test-only**; production consumers must not need to call it
- [ ] **Response lookup preference (consumer-facing):**
  - Canonical consumer path: `dispatchAsk` → `askId` → `getAsk(askId)` → (optional `responseId` on snapshot) → `getResponse(askId)`
  - Prefer **`askId` as the primary consumer-facing argument** to `getResponse`; the engine may resolve `askId` → `responseId` internally
  - If the existing engine naturally supports `getResponse(responseId)` as well, keep it, but document unambiguous resolution and treat `askId` as the facade-preferred form
  - Do not block Phase 0 on perfect identity unification; expose what the engine already supports, then let the comet-api adapter canonicalize for HTTP clients
  - Optional `cursor?` for chunked reads remains allowed
- [ ] `stopAsk(id)` or document unsupported

### B4. Model/tab helpers (for comet-api)
- [ ] `resolveTab({ provider, tabId? })` — **no silent wrong-tab default**; if tabId omitted, document policy
- [ ] For Phase 0/Phase 1 facade, prefer explicit `TAB_BUSY` / 409 semantics over introducing an admission queue; queueing is deferred
- [ ] `assertTabIdle(tabId)` or occupied-tab detection for one-active-ask-per-tab
- [ ] Return stable codes: `TAB_BUSY`, `TAB_NOT_FOUND`, `TAB_CAP_EXCEEDED`, `PROVIDER_UNAVAILABLE`, `IDEMPOTENCY_CONFLICT`, `ENGINE_ALREADY_OWNED`
- [ ] Prefer one minimal error shape for library consumers: `{ code: string, message: string, details?: unknown }` — no large hierarchy in Phase 0

### B5. Package + docs for consumers
- [ ] README or `docs/runbooks/engine-library.md`: install/link, minimal script example
- [ ] Example script `scripts/engine-ask-smoke.mjs` (or `.ts`) used in DoD
- [ ] Runbook sequence should mirror comet-api needs:
  1. `createEngine(...)`
  2. `openTab` / `resolveTab` (documented policy; no silent wrong tab)
  3. `dispatchAsk` with `idempotencyKey`
  4. Rely on advancer; optionally poll `getAsk` until terminal
  5. `getResponse(askId)` (engine may resolve ask → response internally)
  6. `engine.close()` on process exit
- [ ] Multi-turn Phase 0 model: same tab + new prompt + distinct `idempotencyKey` (state this in the runbook)
- [ ] Document public `askId` naming (and any `correlationId` alias) in the runbook

**Acceptance (staged — see addendum §1):**

- **PR-2:** Script imports library, creates engine, opens/lists, dispatches, reads snapshot (manual/`advanceAsk` test path allowed). **Do not** claim poll-free auto-completion in PR-2.
- **PR-3+:** Same script (or successor) completes without client `provider_poll` or external `advanceAsk` once the internal advancer exists.
- Full B5 auto-complete smoke is an **advancer** acceptance, not an exports-only acceptance.

---

## Workstream C — Internal advancer (P5a spirit only)

### C1. Design
- [ ] Single module e.g. `src/engine/advancer.ts` or beside PendingAsk registry
- [ ] Loop: select due asks → claim ownership → `advanceAsk` → persist → reschedule or complete
- [ ] The advancer must use the **existing ask lifecycle state** as its source of truth; do not create a second durable queue/state machine
- [ ] **Ownership invariant only:** one ask → at most one active advancement at a time
  - A **process-local mutex / in-memory claim** is sufficient for the current single-process engine
  - Do **not** invent Redis-style distributed leases, TTLs, or fencing tokens merely because the word “lease” appears in older notes
  - Use the simplest ownership mechanism compatible with the existing durable event/recovery model
  - If a claim has a timeout, keep it a local safety net against a stuck worker in *this* process — not distributed-systems machinery
- [ ] Global + per-provider concurrency limits (respect pool cap ~5)
- [ ] Use existing per-tab backoff/circuit breaker; do not bypass; no busy-loop spin on `next due`
- [ ] On soft-expiry/`watching`, hand off to existing reaper — do not invent second reaper; **start/attach only**
- [ ] Stop advancing on terminal states
- [ ] Document the source of `next due` timing, wake-up mechanism, process-local ownership, and restart behavior

### C2. Lifecycle integration
- [ ] Start/stop advancer from the explicit engine runtime lifecycle
- [ ] Ensure exactly one advancer per engine runtime
- [ ] Graceful stop: finish in-flight advancement or release ownership cleanly
- [ ] Ensure completion still writes event-store + response store before clearing PendingAsk
- [ ] On restart, reconcile/recover only through existing durable state; do not manufacture duplicate asks/sends

### C3. Tests
- [ ] Unit: ownership/claim prevents concurrent advance of the same ask
- [ ] Unit: terminal status removes ask from active scheduling
- [ ] Unit: watching does not count as usable completion
- [ ] Unit: shutdown does not leave an active advancer/timer behind
- [ ] Integration/smoke: dispatch without manual advance reaches completed (mock driver if needed)
- [ ] Integration/recovery: unfinished ask after restart follows the documented recovery path where practical
- [ ] Extraction check: library dispatch and MCP path share the same authoritative lifecycle components (no duplicate registries/stores)

**Acceptance:** After `dispatchAsk`, with no `provider_poll` or external `advanceAsk`, ask reaches `completed` or documented terminal failure; response fetchable via `getResponse(askId)` (or documented equivalent). **First PR that may claim this: PR-3.**

---

## Workstream D — Lifecycle + response hardening

### D1. Snapshot contract
- [ ] `AskSnapshot` fields: askId (and documented aliases), provider, tabId, status, usable, error?, responseId?, confidence?, timestamps
- [ ] Map confirming vs completed correctly (no false success while stability window holds)
- [ ] Preserve distinction between terminal and successful/usable
- [ ] Snapshot status values come from the shared `AskStatus` enum / `usable()` helper

### D2. Idempotency
- [ ] Define request identity/fingerprint bound to `idempotencyKey` using the **field list drafted in A1** (refine only if code review finds a missing send-affecting field)
  - Minimal deterministic fields from the dispatch payload (e.g. `provider`, `tabId?`, normalized `prompt` or content hash, plus any model/mode fields that affect the send)
  - Exclude timestamps, ask/correlation ids, and other non-identity metadata
  - Record the final field list in the lifecycle note or runbook
- [ ] Replay same idempotencyKey + same request identity returns prior ask/outcome before send
- [ ] Same idempotencyKey + different request identity returns `IDEMPOTENCY_CONFLICT`
- [ ] Test: two dispatchAsk same key → one send.queued/accepted in event log and same ask identity
- [ ] Ensure retry while original ask is in progress returns the existing ask rather than creating a second PendingAsk

### D3. Response path
- [ ] `getResponse(askId)` (preferred) fails clearly if not complete; engine may resolve ask → response internally
- [ ] If `responseId` is also accepted, document resolution rules; comet-api adapter may canonicalize to askId later
- [ ] Strip sentinel/status-line from user-visible content if engine already does — do not regress
- [ ] Multi-turn: follow-up must not return previous turn hash (regression coverage)

### D4. Abandon vs cancel
- [ ] Document: abandoning a future HTTP wait does nothing to PendingAsk
- [ ] If `stopAsk` exists: define UI stop vs registry cancel; add one test

---

## Workstream E — Five-provider live gate

### E1. Script
- [ ] `scripts/phase0-live-gate.mjs` (or test/integration) configurable via env
- [ ] Prefer a **scripted/mock driver path as the default CI gate**; live browser run is opt-in via env
- [ ] For each provider in: perplexity, grok, gemini, chatgpt, claude:
  - health/open as needed
  - dispatchAsk unique idempotencyKey
  - wait on getAsk until terminal (timeout generous)
  - getResponse non-empty (prefer by askId)
  - second dispatchAsk same key → replayed, no duplicate send
- [ ] Print per-provider latency and status
- [ ] Exit non-zero on failure

### E2. Minimum extra cases
- [ ] At least one multi-turn follow-up (Perplexity + one other): same tab, new prompt, distinct idempotencyKey
- [ ] At least one failure path test (invalid tabId or closed tab) does not hang advancer

### E3. Record results
- [ ] Paste summary into PR or `docs/planning/phase-0-live-gate-results.md`
- [ ] Known environmental blockers (rate limit, login) documented — not silent skip
- [ ] If live gate cannot run: ship library+advancer+unit/scripted tests and link a waiver issue
- [ ] Hard DoD may pass with mock/fixture + ≥0–1 live provider + waiver; full badge needs all five or per-provider waivers

---

## Workstream F — Close the loop for comet-api

### F1. Build-plan / design notes
- [ ] Update `docs/build-plan.md`: Phase 0 facade-unlock done (hard DoD); P5a public `wait_any` deferred; P5b/P7 deferred; note full provider badge status if incomplete
- [ ] Optional one-line pointer in `docs/design/README.md` to this task list and the addendum

### F2. Consumer contract snippet
- [ ] Add `docs/runbooks/engine-library.md` with copy-paste example matching what comet-api `src/clients/comet-engine.ts` will call
- [ ] Include explicit engine handle lifecycle, public `askId` naming, preferred `getResponse(askId)` path, and multi-turn (same-tab) note

### F3. Notify facade repo (see addendum §6 for full steps)
- [ ] comet-api `planning/progress.md`: Phase 0 hard unlock + engine commit SHA + hard vs full badge status
- [ ] comet-api dependency: `file:../comet-mcp` or git SHA pin
- [ ] `comet-engine.ts` uses only documented library exports (no drivers/CDP/event-store internals)

---

## Suggested PR slices (for a small model worker)

| PR | Scope | May claim |
|---|---|---|
| PR-1 | A1–A3 docs only: symbol map (**authoritative component per responsibility**, **wrap-vs-new**, **askId naming**, **draft fingerprint fields**) + runtime-boundary note + lifecycle/status table | Docs only |
| PR-2 | B1–B3 library exports + explicit engine lifecycle (`createEngine`/`close`; stub advancer OK) | Import, dispatch, snapshot; **not** poll-free complete |
| PR-3 | C1–C3 internal advancer + tests + recovery behavior + extraction check | **First** poll-free auto-complete |
| PR-4 | B4–B5 + D1–D4 snapshot/idempotency polish | Full consumer smoke if PR-3 present |
| PR-5 | E1–E3 scripted default gate + optional live results | Provider evidence / badge progress |
| PR-6 | F1–F3 build-plan + runbook + comet-api handoff | Hard DoD closeout |

Do not combine PR-3 and PR-5 in one change if unstable. Detailed boundaries: addendum §1.

---

## Worker guardrails (DeepSeek / small agents)

1. **Read before write:** open existing `dispatchAsk`/`advanceAsk` paths; wrap, do not rewrite completion detection.
2. **No second completion detector**, no second event store, no second reaper, and no second durable ask queue/state machine.
3. **Explicit runtime ownership:** one engine runtime owns one advancer; imports must not implicitly start MCP stdio.
4. **No HTTP server** in this phase.
5. Prefer **minimal diffs**; match existing TypeScript style.
6. After each PR: run unit tests; fix breakages before next slice.
7. If live gate cannot run (no browser), still ship library+advancer+unit/scripted tests and document blocker.
8. When unsure, extend existing modules rather than new frameworks.
9. Do not silently introduce busy-tab admission queues, alternate completion semantics, or new lifecycle authorities.
10. Status strings and `usable()` must come from the shared enum/helper — do not hard-code ad-hoc status literals in new modules.
11. **Ownership is process-local:** do not build distributed leases (Redis/etcd/fencing). Required invariant is only “one ask → at most one active advancement.” A local mutex/claim is enough.
12. Prefer **`getResponse(askId)`** for consumers; internal ask→response resolution is fine. Do not over-engineer identity unification in Phase 0.
13. **Extraction invariant:** Phase 0 is an extraction/facade effort, not a second-engine implementation. Every new runtime component must delegate to, wrap, or clearly complement an existing authoritative component; if a proposed change creates a competing lifecycle state machine, registry, completion detector, durable store, or reaper, stop and resolve the boundary before coding further.
14. **Verify extraction with evidence:** symbol-map wrap-vs-new rows plus a shared-component check (import identity or shared registry/event entry) — not prose alone.
15. **One public ask id:** use `askId` in the facade; document `correlationId` only as an alias if the existing engine already uses that name.
16. **PR staging:** do not claim poll-free completion before PR-3; follow addendum §1.
17. **Reaper:** start/attach only — never reimplement soft-expiry/reaper in Phase 0.

---

## Traceability

| Facade need (comet-api) | Phase 0 task |
|---|---|
| Hidden polling | Workstream C |
| `comet-engine.ts` adapter | Workstream B |
| Explicit engine lifecycle | A2, B1, C2; addendum §2 |
| Status → HTTP map | A3, D1 |
| Model → tab | Workstream B4 |
| Idempotency-Key | A1 (draft fields), D2 |
| Sync wait / async pull | C + D (engine completes; HTTP later) |
| 5 models in /v1/models | Workstream E; full badge in addendum §4 |
| Error / 409 mapping | B4, D2 |
| Canonical askId response fetch | B3, D3 |
| Extraction / no second engine | Architectural boundary, A1, DoD, C3, guardrails 13–14 |
| Hard unlock vs full badge | DoD tiers; addendum §4 |
| comet-api handoff | F3; addendum §6 |
