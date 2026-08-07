# Grok provider discovery — runbook

- **Date:** 2026-08-06
- **Status:** Initial discovery complete — HIGH confidence, verified live
- **Provider entry:** `src/providers/grok.ts`
- **Fixtures:** `test/fixtures/grok/{idle,typing,streaming,completed}.html`
- **Raw runs:** `test/integration/out/grok-discovery-*.json`

## How discovery works

`test/integration/grok-discover.mjs` is an **offline/on-demand selector miner** — it is
NOT part of the hot path (per ADR 0001 and the build-plan discovery workflow). It connects
to the authenticated Comet profile via CDP (port 9222), inventories the grok.com tab,
then performs **one sanctioned validation submission**:

1. Connect to the grok.com page target (auto-detected, or pass a target ID).
2. Inventory idle controls: composer, send button, model picker, new chat, response containers.
   - New chat and model picker are **inspection only** — never activated (preserves session state).
3. Focus composer, clear residue (Ctrl+A, Delete), type `Say only: PONG`, snapshot typing state.
4. Scan for the send button (rendered only after text exists), click it (Enter-key fallback).
5. Observe streaming → completed (stop button **never** appears on the Fast model —
   the "Working for Xs" indicator is the streaming signal).
6. Emit `src/providers/grok.ts` data + sanitized DOM fixtures per state.
7. `--diff` mode compares against the previous run's provider entry (drift detection).

## Usage

```bash
# full discovery + PONG validation (auto-finds the grok tab)
node test/integration/grok-discover.mjs

# diff against previous run
node test/integration/grok-discover.mjs --diff

# target a specific tab
node test/integration/grok-discover.mjs <targetId-prefix>
```

Requires: Comet running with `--remote-debugging-port=9222`, logged into grok.com,
and the grok.com tab open in the Comet profile.

## Verified selectors (2026-08-06, Chrome/150.0.7871.230)

| Control | Selector | Notes |
|---|---|---|
| Composer | `[data-testid="chat-input"]` | contenteditable div; focus editable child before `Input.insertText`; alias `[aria-label="Ask Grok anything"]` |
| Send button | `[data-testid="chat-submit"]` | `aria-label="Submit"`, `type="submit"`; **rendered only after text is typed**; Enter-key fallback verified |
| Model picker | `#model-select-trigger` | `aria-label="Model select"`, shows current model ("Fast") |
| New chat | `[aria-label="New chat"]` | icon button |
| User message | `[data-testid="user-message"]` | |
| Assistant response | `[data-testid="assistant-message"]` | take the **last** match for the current turn |
| Streaming | `[data-testid="canvas-working-indicator"]` | body text "Working for Ns" → flips to "Worked for Ns" on completion |
| Stop button | **NONE** | Fast model never renders one; do not rely on stop-button heuristics |

## State machine (verified live)

| State | Signal |
|---|---|
| idle | no working indicator, composer empty |
| typing | composer has text, no working indicator |
| streaming | "Working for Xs" present and/or assistant-message text growing |
| completed | no working indicator, assistant-message stable for ≥3s |

## What the live run proved

- **Submission path works:** typed `Say only: PONG` → clicked `chat-submit` → got `PONG`
  back in ~4-6s (button-click and Enter-key both verified across runs).
- **Response extraction target:** `[data-testid="assistant-message"]` — the PONG response
  rendered as a 4-char text node inside it; the markdown body is inside
  `div.response-content-markdown.markdown.chat-md` within the message.
- **Conversation container:** Grok renders `#response-<uuid>` divs per turn; the tab URL
  shifts to `https://grok.com/c/<conversation-id>?rid=<request-id>` during a conversation.
- **No stop button, ever:** across all runs the strict stop-button probe never matched
  during generation. The earlier "stop=2" reading was a loose-regex false positive
  (it matched button *text* like "stop" inside other elements). Streaming state must use
  the "Working for Xs" indicator.

## Drift response

If health reports (P8) flag missing hooks for Grok:

1. Re-run `node test/integration/grok-discover.mjs --diff`.
2. Compare the diff output — changed selectors indicate drift.
3. Commit the updated provider entry (`src/providers/grok.ts`) + new fixtures.
4. If the diff shows repeated flapping (e.g. model picker absent), the inventory caps
   (buttons 60 / responses 30 / composer 20) may need raising — the full button list is
   kept in `buttonsAll` for control detection, so only the console print is capped.

## Known limitations

- Discovery targets the open conversation in the grok.com tab; it does not open a new
  chat (new-chat is inspection-only). Repeated discovery runs accumulate `Say only: PONG`
  messages in the conversation history.
- Fixtures are sanitized snapshots (scripts/styles/svg stripped) — they capture structure,
  not live behavior; synthetic DOM tests should combine them with the heuristics above.
- Streaming fixture requires a generation long enough for the observer to fire
  ("Working for Xs" + non-empty assistant message) — very short responses may not
  produce one.

## Related

- [Build plan](../build-plan.md)
- [ADR 0001: Browser-tab transport and relay defaults](../adr/0001-browser-tab-transport-and-relay-defaults.md)
- [P0 findings: CDP concurrency ceiling](../p0-cdp-concurrency-findings.md)
- Discovery harness: `test/integration/grok-discover.mjs`
