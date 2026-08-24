# comet-mcp

[![npm version](https://img.shields.io/npm/v/comet-mcp.svg)](https://www.npmjs.com/package/comet-mcp)

<a href="https://glama.ai/mcp/servers/@hanzili/comet-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@hanzili/comet-mcp/badge" />
</a>

**Give Claude Code a browser that thinks.**

An MCP server that connects Claude Code to [Perplexity Comet](https://www.perplexity.ai/comet) - enabling agentic web browsing, deep research, and real-time task monitoring.

![Demo](demo.gif)

## Why?

Existing web tools for Claude Code fall into two categories, both with limitations:

### 1. Search APIs (Tavily, Perplexity API, WebFetch)
Return static text. No interaction, no login, no dynamic content. Great for quick lookups, but can't navigate complex sites or fill forms.

### 2. Browser Automation (browser-use, Puppeteer MCP, Playwright MCP)
Can interact with pages, but use a **one-agent-do-all** approach: the same reasoning model that's writing your code is also deciding where to click, what to type, and how to navigate. This overwhelms the context window and fragments focus.

### 3. Comet MCP: Multi-Agent Delegation
**Comet MCP takes a different approach.** Instead of Claude controlling a browser directly, it delegates to [Perplexity Comet](https://www.perplexity.ai/comet) - an AI purpose-built for web research and browsing.

- **Claude** stays focused on your coding task
- **Comet** handles the browsing: navigation, login walls, dynamic content, deep research
- **Result**: Claude's coding intelligence + Perplexity's web intelligence, working together

## Quick Start

### 1. Configure Claude Code

Add to `~/.claude.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "npx",
      "args": ["-y", "comet-mcp"]
    }
  }
}
```

### 2. Install Comet Browser

Download and install [Perplexity Comet](https://www.perplexity.ai/comet).

That's it! The MCP server automatically launches Comet with remote debugging when needed.

### 3. Use in Claude Code

```
You: "Use Comet to research the top AI frameworks in 2025"
Claude: [delegates to Comet, monitors progress, returns results]

You: "Log into my GitHub and check my notifications"
Claude: [Comet handles the login flow and navigation]
```

## Tools

| Tool | Description |
|------|-------------|
| `comet_connect` | Connect to Comet (auto-starts if needed); no longer closes user tabs |
| `comet_ask` | Send a task to Perplexity and wait for response |
| `comet_poll` | Check progress on long-running tasks |
| `comet_stop` | Stop current task |
| `comet_screenshot` | Capture current page |
| `comet_mode` | Switch Perplexity modes: search, research, labs, learn |
| `provider_open` | Open (or reuse) a provider tab and register it (perplexity, grok, gemini, chatgpt, claude) |
| `provider_reconnect` | Re-establish a provider's CDP session + re-hydrate dedup anchors |
| `provider_list` | List registered provider tabs + CDP pool state |
| `provider_close` | Close a provider tab (scoped; last tab is reset, never closed) |
| `provider_health` | Structured health per provider (entry-level verify for pre-driver providers) |
| `provider_override` | Persist a selector override for a provider control |
| `provider_ask` | Send a prompt to any provider and wait (async dispatch — survives long generations) |
| `provider_poll` | Advance/check a provider's current turn |
| `provider_stop` | Stop a provider's current generation (Grok Fast: no-op) |
| `provider_discover` | Run live DOM discovery + regenerate a provider entry (CLI: `comet-mcp discover`) |
| `provider_verify` | Cheap selector health check (no prompt); ADR 0003 learning loop |
| `provider_response` | Fetch a saved provider response by responseId (chunked) |

## Multi-provider backbone (2026-08-07)

comet-mcp evolved from a Perplexity-only bridge into a multi-provider conversation
backbone: Perplexity, Grok, Gemini, ChatGPT, and Claude each operate in their own
authenticated Comet tab, controlled through **independent per-target CDP sessions**
(pool cap 5), with a tab registry, durable idempotent event store (replay-safe
sends), reconnect-dedup, and self-healing selector discovery.

## How It Works

```
Claude Code  →  MCP Server  →  CDP (per-tab sessions)  →  Comet Browser  →  Provider tabs
   (reasoning)     (bridge)                                                     (web browsing)
```

Claude sends high-level goals ("research X", "log into Y"). Comet figures out the clicks, scrolls, and searches. Results flow back to Claude.

## Requirements

- Node.js 18+
- [Perplexity Comet Browser](https://www.perplexity.ai/comet)
- Claude Code (or any MCP client)
- **Supported platforms**: macOS, Windows, WSL2

## Windows & WSL Support

### Native Windows
Works out of the box. Comet MCP auto-detects Windows and launches Comet from its default install location.

### WSL2 (Windows Subsystem for Linux)
WSL2 requires **mirrored networking** to connect to Comet running on Windows:

1. **Enable mirrored networking** (one-time setup):
   ```
   # Create/edit %USERPROFILE%\.wslconfig (Windows side)
   [wsl2]
   networkingMode=mirrored
   ```

2. **Restart WSL**:
   ```bash
   wsl --shutdown
   # Then reopen your WSL terminal
   ```

3. **That's it!** Comet MCP auto-detects WSL and uses PowerShell to communicate with Windows.

If mirrored networking isn't available, you'll see a helpful error message with setup instructions.

### Custom Comet Path
If Comet is installed in a non-standard location:
```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "npx",
      "args": ["-y", "comet-mcp"],
      "env": {
        "COMET_PATH": "/path/to/your/Comet"
      }
    }
  }
}
```

## Troubleshooting

**"Cannot connect to Comet"**
- **macOS**: Ensure Comet is installed at `/Applications/Comet.app`
- **Windows**: Comet should be in `%LOCALAPPDATA%\Perplexity\Comet\Application\`
- Check if port 9222 is available

**"WSL cannot connect to Windows localhost"**
- Enable mirrored networking (see WSL section above)
- Or run Claude Code from Windows PowerShell instead of WSL

**"Tools not showing in Claude"**
- Restart Claude Code after config changes

## License

MIT

---

[Report Issues](https://github.com/hanzili/comet-mcp/issues) · [Contribute](https://github.com/hanzili/comet-mcp)
