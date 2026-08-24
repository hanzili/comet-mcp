# Runbooks

Document repeatable operating procedures here: provider discovery, selector repair, live validation, recovery, and release checks.

- [Provider discovery (all 5 providers, shipped CLI/MCP)](grok-provider-discovery.md) — how to run discovery, verify health, and repair DOM drift

## Operational notes (2026-08-07)

### Multi-provider tabs
- `provider_open <provider>` registers a provider tab in the registry; all 5
  providers (perplexity, grok, gemini, chatgpt, claude) are addressable at the
  registry level. Only perplexity + grok have ChatDrivers (ask/poll) — P6.
- Pool cap is 5 concurrent CDP sessions (P0-measured); the 6th open fails with
  `tab_cap_exceeded` and creates NO orphan tab (cap checked before tab creation).
- Default (no tabId) operations target the provider's most-recently-completed
  tab; pass `tabId` to address a specific tab.

### Claude specifics
- A claude tab on `/recents` (history view) has NO composer — navigate to
  `https://claude.ai/new` before verify/discover.
- The send button is `button[aria-label="Send message"]` (appears ~250ms after
  typing; Enter does NOT submit on the contenteditable).
- `responseContainer` (`div.font-claude-response`) is empty-state-conditional —
  exists only after a first response.

### Gateway / runtime gotchas
- After rebuilding `dist`, kill the cached comet-mcp node process or the OLD
  build keeps serving (the tool-count mismatch is the tell):
  `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'comet-mcp' } | Stop-Process`
- `provider_ask` dispatches and returns immediately; poll with `provider_poll`,
  fetch full content with `provider_response` (chunked).
- Grok account rate limits can block asks ("18 minutes before limit is gone") —
  back off; Grok project-chat views don't submit reliably, use plain `grok.com/`.
