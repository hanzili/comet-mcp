# Phase 0 — Execution clarifications and runtime gates

This addendum supplements [`phase-0-library-api-tasks.md`](./phase-0-library-api-tasks.md). It deliberately does **not** replace the canonical checklist or expand Phase 0 into P5b, P7, HTTP, or a second completion system.

### Precedence

- **Product contracts** (`askId`, status vocabulary, idempotency fingerprint fields, extraction invariant, error codes, snapshot shape): the **task list** wins.
- **PR acceptance order, process ownership, hard vs full DoD tiers, handoff steps**: **this addendum** wins.
- If the documents appear to conflict: this addendum controls **execution semantics**; the task list controls **task scope**.
- Do not invent a third interpretation when both documents touch the same topic.

## 1. Acceptance staging by PR

The original workstreams remain authoritative. Apply these acceptance boundaries:

| PR | Scope | Acceptance boundary |
|---|---|---|
| PR-1 | A1–A3 inventory, runtime-boundary, and lifecycle-freeze docs | Documentation only; no claim of auto-advancement |
| PR-2 | B1–B3 library exports + explicit lifecycle | A non-MCP script can import the library, `createEngine`/`close`, dispatch an ask, receive a valid ask snapshot, and read its current state. It may use a test/manual advance path. It does **not** claim completion without external advancement. |
| PR-3 | C1–C3 internal advancer | After `dispatchAsk`, with no client `provider_poll` or external `advanceAsk`, the ask reaches completed or a documented terminal outcome and the response is fetchable via `getResponse(askId)`. |
| PR-4 | B4–B5 + D1–D4 | Stable tab/model errors, consumer smoke/runbook draft, snapshot, idempotency, response, and abandon-vs-cancel behavior. B5 auto-complete smoke may be claimed only if PR-3 advancer is already present. |
| PR-5 | E1–E3 live/scripted gate | Provider-by-provider live/scripted evidence, latency, replay, follow-up, and failure-path results (feeds full provider badge). |
| PR-6 | F1–F3 closeout | Build-plan update, consumer runbook, and comet-api handoff (SHA pin / dependency; see §6). |

**B5 note:** Do not mark B5's auto-complete smoke acceptance complete during PR-2. Full “dispatch → auto-complete without MCP” is an **advancer** acceptance and belongs to **PR-3** (or PR-4 once PR-3 has landed). PR-2 may ship a partial smoke that stops at snapshot/manual advance.

## 2. One runtime owner

Phase 0 must expose one explicit engine runtime lifecycle, even if the final symbol names differ. The canonical plan's preferred shape is `createEngine(options?) → Engine` plus `engine.close()`:

```text
createEngine(options?)
  → creates the engine runtime handle for this process
  → owns exactly one internal PendingAsk advancer
  → starts or attaches to the existing authoritative soft-expiry/reaper
    (start/attach only — do not reimplement the reaper or soft-expiry state machine)

engine.close()
  → stops new scheduling
  → handles in-flight advancement according to the documented shutdown policy
  → releases process-local ownership/timers cleanly
```

**Sole lifecycle owner:** `createEngine()` / the engine runtime is the **sole lifecycle owner** of the PendingAsk advancer and the soft-expiry/reconciliation reaper. It may reuse existing reaper implementation code (start or attach), but **no other entrypoint** (MCP tool handlers, library helpers, scripts, or tests outside the runtime) may start a competing advancer or reaper timer.

Invariant:

```text
one process
  → one engine runtime
  → one PendingAsk advancer
  → one soft-expiry/reconciliation reaper owner
  → one event-store writer context
```

**Repeated `createEngine` (pick and document one; prefer A):**

- **A (preferred):** If a runtime is already active in this process for the same ownership scope, a second `createEngine` **fails** with a stable code such as `ENGINE_ALREADY_OWNED` (or returns a documented error result). Caller must `close()` before creating again. This matches the explicit-handle model and avoids a hidden process-global singleton.
- **B (allowed only if existing MCP wiring forces it):** Second call returns the **same** live `Engine` handle (reference equality). Document that behavior; still one advancer, one reaper owner.

Requirements:

- MCP server startup calls the same runtime creation/start path as library consumers.
- Library consumers call that same path; facade ops take the `engine` handle (or are methods on it).
- `close()` is idempotent (second close is a no-op or safe documented result).
- There is one owner for the advancer and one owner for reaper timers in the process.
- Completion is durably written before an ask is removed from the pending registry.
- The existing authoritative reaper remains the reaper; Phase 0 must not create a second reaper or duplicate soft-expiry state.
- Exact module/file names (`src/engine.ts` vs `src/engine/index.ts`, etc.) are implementation choices; the lifecycle contract is not.

## 3. Single-process ownership rule

Phase 0 assumes one Node process owns a browser profile/data directory and its engine runtime:

```text
one process → CDP pool + tab registry + PendingAsk advancer + existing reaper + event store
```

Do not design competing MCP and library processes for the same browser profile in Phase 0. If MCP and library calls coexist, they must share the same in-process runtime. Multi-process coordination, distributed leases, and horizontal scaling are out of scope.

If the implementation enforces same-profile process ownership, document the failure mode for a second process explicitly (`ENGINE_ALREADY_OWNED`, or equivalent) rather than allowing two advancers to compete silently. This is a single-process safety rule, not a requirement to introduce distributed coordination.

## 4. Definition-of-done tiers

Use two labels so environmental provider failures do not obscure engine completion. The **task list DoD checklist** still applies; these tiers say which subset unblocks comet-api.

### Hard facade-unlock DoD (Phase 0 exit for comet-api unblocking)

- Importable non-MCP library entrypoint.
- Runtime creation/close with one advancer owner; reaper is **start/attach only** to the existing authoritative machinery.
- Internal advancement with zero client polls / zero external `advanceAsk`.
- Frozen status/snapshot contract and tests; public `askId`; extraction invariant verified with evidence.
- Idempotent retry with no second send; conflict on identity mismatch.
- At least one provider live gate, preferably Perplexity, **or** mock/fixture coverage plus an explicit live waiver issue if the browser is unavailable.
- Clean response retrieval (`getResponse(askId)` preferred) and failure/closed-tab behavior.
- Consumer runbook and smoke script.
- Build plan says P5b/P7 are deferred and facade Phase 0 is unlocked.

### Full Phase 0 provider badge (release-quality target)

- Perplexity, Grok, Gemini, ChatGPT, and Claude live/scripted gates pass, or each exception has a documented environmental cause and issue/link.
- Follow-up regression coverage exists for at least Perplexity and one other provider.
- Latency/status/replay evidence is recorded per provider.

**Hard DoD unblocks comet-api development.** The full badge remains the release-quality target and must not block starting comet-api Phase 1 against a hard-DoD engine SHA.

## 5. Documentation clarifications

- The canonical task list remains the execution checklist; this addendum supplies sequencing and runtime gates.
- Symbol maps may be a dedicated planning file or a PR description if the result is durable and reviewable.
- New module names are suggestions, not requirements.
- Do not add OpenAPI, HTTP routes, SSE, MCP-Bridge, broad tool calling, NotebookLM, or pi-livecraft implementation to Phase 0.
- Do not rewrite completion detection, the event store, the existing authoritative reaper, or P4 relay safety while exporting the library boundary.
- The Phase 0 extraction invariant is mandatory: new modules must wrap, delegate to, or clearly complement existing authoritative lifecycle components; they must not introduce a competing engine, PendingAsk registry, completion detector, durable store, or reaper.
- Keep the existing unit/live test bar green after each PR slice.

## 6. Handoff to comet-api (implements task-list F3)

When **hard DoD** passes:

1. Record the exact comet-mcp commit SHA in comet-api `planning/progress.md` (or equivalent).
2. Add the dependency by sibling `file:` reference for local work or a pinned git SHA for CI.
3. Point `comet-api/src/clients/comet-engine.ts` only at the documented library exports.
4. Do not import drivers, CDP clients, poll scripts, or event-store internals from comet-api.
5. Note hard DoD vs full provider badge status so comet-api knows which providers are certified.

Task-list **F3** is satisfied by completing this section; PR-6 should include F1–F3.

## 7. Worker guardrail summary

For a small code worker:

- Read the existing `dispatchAsk`, `advanceAsk`, PendingAsk, reaper, and MCP startup paths before modifying anything.
- Make PR-1 docs-only and PR-2 export-focused where possible.
- Make PR-3 the first place that can claim client-poll-free completion.
- If live browser access is unavailable, complete hard DoD with fixtures/mock and record the blocker; do not fake a provider pass.
- Stop and ask for review if the change requires a second completion detector, second event store, second reaper, HTTP route, P5b/P7 scheduler, or multi-process ownership scheme.
- Prefer `createEngine` policy **A** (second create → `ENGINE_ALREADY_OWNED`) unless existing MCP wiring forces policy B.
- `createEngine` / the engine runtime is the sole starter of advancer and reaper timers; never start a competing timer from another entrypoint.
