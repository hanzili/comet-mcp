# Provider discovery — runbook

- **Updated:** 2026-08-07 (supersedes the Grok-specific runbook; discovery is now a shipped tool)
- **Status:** All 5 providers discovered live, HIGH confidence (Perplexity, Grok, Gemini, ChatGPT, Claude)
- **Entries:** `src/providers/entries/*.json` (data, git-committed)
- **Fixtures:** `test/fixtures/<provider>/{idle,typing,streaming,completed}.html`
- **Engine:** `src/core/discovery.ts` · **Registry:** `src/core/registry.ts` · **CLI:** `src/cli.ts`
- **Raw runs:** `test/integration/out/<provider>-discovery-*.json` (gitignored)

## How discovery works

Discovery is an **offline/on-demand selector miner, shipped as part of the tool** — it is
NOT on the hot path (ADR 0001, build plan). The engine connects to the authenticated Comet
profile via CDP (port 9222), inventories the provider tab, then performs **one sanctioned
validation submission** with a varied prompt:

1. Connect to the provider page target (auto-detected from the entry's URL pattern).
2. Inventory idle controls: composer, send button, model picker, new chat, response containers.
   - New chat and model picker are **inspection only** — never activated (preserves session state).
3. Focus composer, clear residue (Ctrl+A, Delete), type a **rotated validation prompt**
   (per-provider + per-run rotation — no repeated probe signatures), snapshot typing state.
4. Scan for the send button (some providers render it only after text exists); click it
   (Enter-key fallback).
5. Observe streaming → completed via the provider probe (e.g. Grok's "Working for Xs"
   indicator — the Fast model **never** renders a stop button).
6. Emit `src/providers/entries/<provider>.json` + sanitized DOM fixtures per state.
7. `--diff` mode compares against the previous run's entry (drift detection).

## Usage (CLI — primary on-demand trigger)

```bash
# build once (or after source changes)
npm run build

# full discovery + validation (auto-finds the provider tab, one varied prompt)
comet-mcp discover --provider grok

# discover + show selector changes vs the committed entry
comet-mcp discover --provider grok --diff

# cheap health check — resolves known selectors against the live tab, NO prompt sent
comet-mcp verify --provider grok

# list all entries + confidence
comet-mcp list
```

Requires: Comet running with `--remote-debugging-port=9222`, the provider logged in, and
the provider tab open in the Comet profile. MCP equivalents: `provider_discover` /
`provider_verify` tools.

## Drift workflow (when a provider changes its DOM)

```bash
comet-mcp verify --provider grok        # MISS on a hook → broken
comet-mcp discover --provider grok --diff   # re-inventory + one varied prompt
git diff src/providers/entries/grok.json    # review selector changes
git commit                                   # repaired — no code changes
```

With self-healing controls (ADR 0003): a re-render that preserves structure is absorbed
by **fingerprint rebind** (no action needed); only a genuine DOM change degrades and
surfaces the `discover --diff` repair. Verify is a **learning loop**: each successful
resolve bumps a control's confidence (+0.05), each failure decrements (−0.15);
confidence < 0.3 evicts the stored selector and flags discovery.

## Verified selectors (2026-08-06/07, Chrome/150.0.7871.230)

| Provider | Composer | Send | Response container | Validation |
|---|---|---|---|---|
| Perplexity | `#ask-input` | `[aria-label="Submit"]` | `[class*="prose"]` | ACK ✓ |
| Grok | `[data-testid="chat-input"]` | `[data-testid="chat-submit"]` | `[data-testid="assistant-message"]` | PONG ✓ |
| Gemini | `[aria-label="Enter a prompt for Gemini"]` | `[aria-label="Send message"]` | `model-response` | ALPHA ✓ |
| ChatGPT | `[aria-label="Chat with ChatGPT"]` | `#composer-submit-button` | `[data-message-author-role="assistant"]` | OK ✓ |
| Claude | `[data-testid="chat-input"]` | `[aria-label="Send message"]` | `div.font-claude-response` | BRAVO ✓ |

Key findings baked into the entries:

- **Grok**: send button renders only after text is typed; **no stop button ever** on the
  Fast model — streaming = "Working for Xs" indicator.
- **Perplexity**: `#ask-input` (the `ask-input-mode-toggle-indicator` testid is a decoy);
  extraction joins all prose blocks, dedupes by containment, keeps newest (slice).
- **Claude**: onboarding chats (`?onboarding=1`) are scripted and do not answer arbitrary
  prompts — discovery needs a normal chat. Response class is `font-claude-response`,
  not `font-claude-message`.
- **ChatGPT**: insertText read-back can race React; the send button's presence confirms text.

## Runtime usage (MCP tools, ADR 0004)

The drivers (`src/drivers/`) are usable directly from MCP clients. `comet_*` tools are
Perplexity aliases; `provider_*` tools take a `provider` param and dispatch via the
registry (`src/drivers/index.ts`):

```text
provider_ask    {provider, prompt, timeout?}  # ask + wait, returns text + markdown
provider_poll   {provider}                     # status + text + markdown
provider_stop   {provider}                     # stop (Grok Fast: no-op)
provider_verify {provider}                     # cheap selector health, no prompt
provider_discover {provider}                   # full discovery + entry regeneration
```

- **Markdown extraction**: drivers capture the response container's innerHTML and
  convert via `src/providers/markdown.ts` (turndown) — works across all providers.
  `PollResult.markdown` carries it; the flattened-text `response` stays primary.
- `comet_ask`/`comet_poll`/`comet_stop` behave exactly as before (Perplexity) but run
  over the shared dispatcher — the P1 `comet_*` → `provider_*` migration path.
- Verified live through pi's MCP bridge: `provider_ask {provider: grok}` returned
  text + markdown; `provider_verify` HEALTHY for perplexity and grok (2026-08-07).

## Drift response details

If `provider_verify` reports a missing hook:

1. Run `comet-mcp discover --provider X --diff`.
2. Compare the diff output — changed selectors indicate drift.
3. Commit the updated entry JSON + regenerated fixtures.
4. If diff shows repeated flapping, the inventory caps may need raising
   (the full button list is kept in `buttonsAll`; only the console print is capped).

## Known limitations

- Discovery targets the open conversation in the provider tab; it does not open a new
  chat (new-chat is inspection-only). Repeated discovery runs accumulate validation
  prompts in the conversation history — prompt rotation keeps signatures varied.
- Fixtures are sanitized snapshots (scripts/styles/svg stripped) — structure, not live
  behavior; synthetic tests combine them with the heuristics.
- The Claude entry requires a normal chat tab (not onboarding).

## Related

- [Build plan](../build-plan.md)
- [ADR 0001: Browser-tab transport and relay defaults](../adr/0001-browser-tab-transport-and-relay-defaults.md)
- [ADR 0002: Conversation fabric type contracts](../adr/0002-conversation-fabric-type-contracts.md)
- [ADR 0003: Self-healing provider controls](../adr/0003-self-healing-provider-controls.md)
- [P0 findings: CDP concurrency ceiling](../p0-cdp-concurrency-findings.md)
