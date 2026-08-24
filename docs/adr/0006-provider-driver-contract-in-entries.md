# ADR 0006 — Provider driver contract in entries (separate `.driver.json` files)

**Status:** accepted (2026-08-08, P6)
**Design doc:** `docs/design/03-p6-drivers-design.md` (Grok design review 2026-08-08 — approved)

## Context

P6 ships Gemini/ChatGPT/Claude.ai adapters. Grok's consultation (2026-08-07) and
design review (2026-08-08) both direct: *push every provider difference into
`ProviderEntry` so the driver body is a thin interpreter of the entry* — the
future typed-adapter core reads the same data. But the `ProviderEntry` schema
carried only discovery inventory (`controls`, `heuristics`, `responseSelectors`);
driver behavior (typing mode, submit contract, working/completed/login/blocked
signals, messageId anchor, markdown variant, reset method) had no home. Entries
are discovery-written data (ADR 0002), so any new section risks being clobbered
by `discover` regeneration (R1 in the design doc).

## Decision

1. **Extend `ProviderEntry` with an optional `driver?: ProviderDriver` section**,
   typed in `src/types/provider.ts`: `typing` (`insertText | value-input |
   key-events`), `submit` (`{method: enter|click|click-after-type, selector?,
   verify, enterSends?}`), `signals` (`working`, `completed`, `login[]`,
   `blocked[]`), `messageId.attr`, `markdown` (preClean variant name), `reset`
   (`{method: url|control|navigate, url?}`), `extraction.preferLast`.
2. **Store the section separately** at `src/providers/entries/<provider>.driver.json`
   and **merge it at load time in `registry.loadEntry`** (`loadDriverSection`).
   `registry.writeEntry` strips `driver` before persisting — discovery owns
   `<p>.json` and never touches `<p>.driver.json`. R1 is closed by construction.
3. **One shared `BaseChatDriver`** (`src/drivers/base.ts`) interprets the section
   entry-driven: parameterized poll script, `typeInto`, submit ladder with
   mandatory verify-before-`sent`, `determineState` (completed requires non-empty
   extraction — never a silent empty response), structured health
   (workingSignal/lastVerifiedAt/confidence/foundVia/loginRequired probe).
   The three P6 drivers are thin subclasses with zero provider-specific code.
4. The existing Perplexity/Grok drivers are **not migrated in P6** — they stay
   live-validated and green; the P6 drivers become the reference implementations
   for the typed-adapter migration (deferred).

## Consequences

- Discovery regeneration can never drop hand-authored driver behavior; the
  separation is visible in the file layout.
- A provider whose behavior cannot be expressed in the `driver` section signals
  a schema extension need (narrow override hooks remain the escape hatch).
- Health for all five drivers now reports the P6 gate surface
  (foundVia/confidence/workingSignal/lastVerifiedAt) through `provider_health`.
- Live-validation repairs (2026-08-08) landed as data changes, not code:
  chatgpt composer re-pointed at the visible contenteditable, claude stop
  selector scoped to real stop controls.
