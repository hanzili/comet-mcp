# Planning (comet-mcp)

Engine-side planning for work that **lands in this repository**.

The HTTP facade and product planning live in **[MrJ55/comet-api](https://github.com/MrJ55/comet-api)**.

## Active

| Doc | Purpose |
|---|---|
| [phase-0-library-api-tasks.md](./phase-0-library-api-tasks.md) | **Canonical checklist** — library API, internal advancer, lifecycle freeze, extraction invariant, contracts (`askId`, status, idempotency) |
| [phase-0-library-api-tasks-addendum.md](./phase-0-library-api-tasks-addendum.md) | **Sequencing & runtime gates** — PR acceptance boundaries, hard vs full DoD, process ownership, comet-api handoff |

## Document precedence

The addendum is **binding execution guidance**, not optional commentary.

- `phase-0-library-api-tasks.md` is the **canonical scope and workstream checklist** (what to build; product contracts such as `askId`, status vocabulary, idempotency fingerprint fields, extraction invariant, error codes).
- `phase-0-library-api-tasks-addendum.md` is **authoritative for PR sequencing**, runtime ownership, acceptance boundaries, and definition-of-done interpretation (hard unlock vs full provider badge, process rules, handoff).
- If the documents appear to conflict: the **addendum controls execution semantics**; the **canonical task list controls task scope**.
- Do not invent a third interpretation.

## Rules

- Phase 0 code changes belong here, not in comet-api.
- Do not implement P5b `run_plan` / P7 here as part of Phase 0.
- Do not vendor this tree into comet-api; comet-api depends on this package.
- **Hard facade-unlock DoD** (see addendum) unblocks comet-api; the full five-provider badge is the release-quality target.
- After hard DoD passes, mark facade unlocked in `docs/build-plan.md` and note it in comet-api `planning/progress.md` (addendum §6).
