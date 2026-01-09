# CLAUDE.md

## What This Is
MCP server connecting Claude Code to Perplexity's Comet browser via Chrome DevTools Protocol (CDP).

## Architecture
```
Claude Code → MCP Server (index.ts) → CometAI (comet-ai.ts) → CDP Client (cdp-client.ts) → Comet Browser
```

## 6 Tools
- `comet_connect` - Start/connect to Comet browser
- `comet_ask` - Send prompt, wait for response (15s default, use poll for longer)
- `comet_poll` - Check status of long-running tasks
- `comet_stop` - Stop current task
- `comet_screenshot` - Capture current page
- `comet_mode` - Switch Perplexity modes (search/research/labs/learn)

## Key Implementation Details

**Response extraction** (`comet-ai.ts:getAgentStatus`):
- Takes LAST prose element (not longest) - conversation threads show newest last
- Filters out UI text (Library, Discover, etc.) and questions (ends with ?)

**Follow-up detection** (`index.ts`):
- Captures old prose count/text before sending
- Waits for NEW response (different text or more elements)

**Prompt normalization**:
- Strips bullet points, collapses newlines to spaces

## Known Limitation
`newChat=true` after agentic browsing is unreliable (CDP connection state issue).
**Workaround**: Call `comet_connect` first to reset state.

## Build & Test
```bash
npm run build
pgrep -f "node.*comet-mcp" | xargs kill  # Restart MCP
```

Manual testing - no unit tests (integration code, external DOM dependency).
