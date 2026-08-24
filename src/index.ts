#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code â†” Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

// CLI dispatch: `comet-mcp discover|verify|list ...` runs the on-demand provider
// discovery workflow instead of starting the MCP server (ADR 0001: discovery is an
// opt-in operational workflow, not a hot-path dependency).
const CLI_SUBCOMMANDS = ['discover', 'verify', 'list'];
if (CLI_SUBCOMMANDS.includes(process.argv[2] ?? '')) {
  const { runCli } = await import('./cli.js');
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { tabRegistry } from "./tab-registry.js";
import { sessionPool } from "./cdp-pool.js";
import { getDriver, listDrivers, openTab, normalizePrompt, askAndWait, askAndWaitOn, dispatchAsk, advanceAsk, isAskPending, lastDispatchedFor, pendingKeyForCorrelation, replayOutcomeIfRecorded, renderPoll, renderInProgress, compactAskResult, readResponseChunk, enforceRetention, recordPollSuccess, startReaper, startAdvancer } from "./drivers/index.js";
import { loadEntry, loadAllEntries, writeEntry } from "./core/registry.js";
import type { ProviderId } from "./types/conversation.js";

/**
 * Known provider = has a ChatDriver (can ask/poll) OR a registry entry (tab can be
 * opened/registered/closed â€” the P3 pool is provider-neutral, drivers are only needed
 * for ask/poll/health).
 */
function knownProvider(provider: string): boolean {
  return !!getDriver(provider) || loadEntry(provider as ProviderId) !== null;
}

/** List of providers addressable at the registry level (entry or driver). */
function knownProviders(): string[] {
  return [...new Set([...listDrivers(), ...loadAllEntries().keys()])];
}

// Retention sweep on startup (expired responses cleaned before serving).
enforceRetention();

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: "Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Ideal for tasks requiring real browser interaction (login walls, dynamic content, filling forms) or deep research with agentic browsing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        timeout: { type: "number", description: "Max wait time in ms (default: 15000 = 15s)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress. Call repeatedly to monitor agentic tasks.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "provider_discover",
    description: "Run the discovery workflow against a provider tab (inventory, one varied validation prompt, entry regeneration). Opt-in operational tool â€” requires the provider tab open in Comet. Use when provider_verify reports a missing hook or selectors drift.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude, gemini, chatgpt, claude" },
        write: { type: "boolean", description: "Write the regenerated entry + fixtures (default: true)" },
        diff: { type: "boolean", description: "Show selector changes vs the committed entry (default: true)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_verify",
    description: "Cheap health check: resolve the provider entry's known selectors against the live tab. Sends NO prompt. Reports ok/missing per control so drift is detectable without polluting a conversation.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude, gemini, chatgpt, claude" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_open",
    description: "Open (or reuse) a provider's tab and register it in the tab registry. Returns the tabId that other provider_* tools address. P3 tab addressing: providerKey â†’ tabId.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        newTab: { type: "boolean", description: "Force a fresh tab instead of reusing the existing provider tab (default: false)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_reconnect",
    description: "Re-establish a provider's pooled CDP session (after a drop/restart) and re-hydrate dedup anchors from the durable event store. P3 reconnect-dedup: unchanged content produces no new response event. Falls back to opening a fresh tab if the old one is gone.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_list",
    description: "List registered provider tabs and their CDP session state (tabId, provider, openedAt, state, dedup anchors).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "provider_close",
    description: "Close a provider tab (scoped â€” never touches sibling provider tabs). Last-tab protection: the LAST tab of a provider is reset instead of closed.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        tabId: { type: "string", description: "Specific tabId to close (optional â€” defaults to the provider's registered tab)" },
        force: { type: "boolean", description: "Close even the last tab of a provider (default: false â€” last tab is reset instead)" },
      },
    },
  },
  {
    name: "provider_health",
    description: "Structured health for a provider tab: per-control hook resolution source + login/degraded state. Sends NO prompt.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        tabId: { type: "string", description: "Specific tabId (optional â€” defaults to the provider's registered tab)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_override",
    description: "Persist a selector override for a provider control (ADR 0003: overrides outrank known selectors). Next discovery run diffs against it.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        control: { type: "string", description: "Control name: composer, sendButton, modelPicker, newChat, responseContainer, ..." },
        selector: { type: "string", description: "CSS selector to force" },
        clear: { type: "boolean", description: "Clear the override for this control (default: false)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_ask",
    description: "Send a prompt to any provider (perplexity, grok, ...) and wait for the complete response. Provider-neutral: dispatches to the registered ChatDriver. Returns text + markdown. Pass the same idempotencyKey to retry without duplicating the send (P1 Half 2 replay safety). Set completionMarker=true (ADR 0010) to ask the model to end with a random sentinel — its presence finalizes completion authoritatively (timer-free) on gemini/chatgpt/claude; non-compliant models fall back to the normal stability window.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        prompt: { type: "string", description: "Question or task for the provider" },
        timeout: { type: "number", description: "Max wait time in ms (default: 15000)" },
        tabId: { type: "string", description: "Specific tabId to ask in (optional â€” defaults to the provider's registered tab)" },
        idempotencyKey: { type: "string", description: "Replay-safe key: re-sending with the same key returns the prior outcome, never a duplicate send (optional)" },
        completionMarker: { type: "boolean", description: "ADR 0010/0011: ask the model to end EVERY reply in the session with a status line (turn, MM/DD/YY, time, model, context%, sentinel) → authoritative completion when the sentinel is present; a bounded reminder is injected if a reply skips it (default: false)" },
      },
      required: ["provider", "prompt"],
    },
  },
  {
    name: "provider_poll",
    description: "Check a provider's current turn status (text + markdown). Provider-neutral dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        tabId: { type: "string", description: "Specific tabId (optional â€” defaults to the provider's registered tab)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_stop",
    description: "Stop the current provider generation if supported (Grok Fast: no-op).",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider name: perplexity, grok, gemini, chatgpt, claude" },
        tabId: { type: "string", description: "Specific tabId (optional â€” defaults to the provider's registered tab)" },
      },
      required: ["provider"],
    },
  },
  {
    name: "provider_response",
    description: "Fetch a saved provider response by its responseId (from provider_ask/provider_poll). Chunked retrieval: pass offset/limit for long responses. Returns the response body as text; content is also on disk.",
    inputSchema: {
      type: "object",
      properties: {
        responseId: { type: "string", description: "responseId returned by provider_ask/provider_poll" },
        offset: { type: "number", description: "Character offset to start from (default 0)" },
        limit: { type: "number", description: "Max characters to return (default 4000)" },
      },
      required: ["responseId"],
    },
  },
  {
    name: "relay_prepare",
    description: "P4: prepare a safe relay of a completed provider response to another provider. Selects the terminal-success source (completed/completed_late only), canonicalizes + hashes the full envelope (content+provenance+destination+policy), runs eager policy checks (approval/attribution/size/deadline/enablement), and returns approvalRequired + approvalHash. NEVER contacts the destination. Follow with relay_approve then relay_send.",
    inputSchema: {
      type: "object",
      properties: {
        sourceCorrelationId: { type: "string", description: "Correlation of the completed source response to relay (from provider_ask / provider_poll result)" },
        destination: { type: "string", description: "Destination provider: perplexity, grok, gemini, chatgpt, claude" },
        attributionHeader: { type: "string", description: "Attribution/wrapper text — MANDATORY in approval-required mode, fail closed if unset" },
        contentSizeLimitBytes: { type: "number", description: "Hard content-size limit for the relay (optional)" },
        deadlineMs: { type: "number", description: "Approval/relay deadline as epoch ms (optional; default 5min from prepare)" },
        maxRelaysPerCorrelation: { type: "number", description: "Cap on relay sends per correlation (optional; 0 = none allowed)" },
        rawMarkdown: { type: "boolean", description: "Opt-in raw markdown pass-through (default false = structural markdown neutralized in approval-required mode)" },
        contentPersistenceMode: { type: "string", enum: ["full", "redacted", "none"], description: "Persistence mode for relay events (default: redacted for relays)" },
      },
      required: ["sourceCorrelationId", "destination"],
    },
  },
  {
    name: "relay_approve",
    description: "P4: approve (or reject) a prepared relay by its approvalHash. Records relay.approved/relay.rejected append-only with an expiry (default +5min). Single-use: a hash records once; consumption is CAS-enforced at relay_send. Pass approved=false to reject.",
    inputSchema: {
      type: "object",
      properties: {
        approvalHash: { type: "string", description: "The approvalHash returned by relay_prepare" },
        correlationId: { type: "string", description: "The relay chain correlationId (from relay_prepare)" },
        envelopeId: { type: "string", description: "The prepared envelope's idempotencyKey (audit trail, optional)" },
        approved: { type: "boolean", description: "true = approve (default), false = reject" },
        expiresAt: { type: "string", description: "ISO expiry for the approval (optional; default +5min from now)" },
      },
      required: ["approvalHash", "correlationId"],
    },
  },
  {
    name: "relay_send",
    description: "P4: send an approved relay to the destination provider. Re-validates the envelope hash against the approvalHash (hash binding), re-runs policy (approval now REQUIRED), pre-flights the destination surface (surface-gone → distinct terminal, approval NOT consumed), CAS-consumes the approval (single-use), then sends with the attribution header + content to the destination via its driver. Receipt recorded on EVERY attempt. Returns the destination correlationId to poll with provider_poll.",
    inputSchema: {
      type: "object",
      properties: {
        approvalHash: { type: "string", description: "The approvalHash from relay_approve (must equal the recomputed envelope hash)" },
        sourceCorrelationId: { type: "string", description: "Same sourceCorrelationId passed to relay_prepare (re-validates the hash)" },
        destination: { type: "string", description: "Same destination passed to relay_prepare" },
        attributionHeader: { type: "string", description: "Same attributionHeader passed to relay_prepare" },
        contentSizeLimitBytes: { type: "number", description: "Same limit passed to relay_prepare (must match to re-validate hash)" },
        deadlineMs: { type: "number", description: "Same deadline passed to relay_prepare" },
        maxRelaysPerCorrelation: { type: "number", description: "Same cap passed to relay_prepare" },
        rawMarkdown: { type: "boolean", description: "Same rawMarkdown passed to relay_prepare" },
        contentPersistenceMode: { type: "string", enum: ["full", "redacted", "none"], description: "Same persistence mode passed to relay_prepare" },
      },
      required: ["approvalHash", "sourceCorrelationId", "destination"],
    },
  },
  {
    name: "relay_reconcile",
    description: "P4: reconcile a relayed delivery (R7) — read-only probe, NEVER resends. Checks the destination ask's state (inherits async-ask soft-expiry/watching) and attributes any destination response via providerMessageId (primary) or contentHash (secondary). Terminal states: reconciled, ambiguous (never auto-promoted), surface_gone, blocked, abandoned. Non-terminal: in_progress, timed_out (poll again). Any resend requires a FRESH relay_prepare + relay_approve.",
    inputSchema: {
      type: "object",
      properties: {
        relayCorrelationId: { type: "string", description: "The relay chain correlationId (from relay_send)" },
        destinationCorrelationId: { type: "string", description: "The destination ask's correlationId (from relay_send)" },
        destinationIdempotencyKey: { type: "string", description: "The destination ask's idempotencyKey (from relay_send) — enables the pending check" },
      },
      required: ["relayCorrelationId", "destinationCorrelationId"],
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(9222);
        // P3 (audit F5): do NOT close all tabs / navigate to Perplexity here â€” that
        // destroys sibling provider tabs (ADR 0001 Â§Safeguards 2). Scoped open/close
        // lives in provider_open/provider_close. Report what's open instead.
        const targets = await cometClient.listTargets();
        const pageTabs = targets.filter(t => t.type === 'page');
        return {
          content: [{ type: "text", text: `${startResult}\nComet ready. ${pageTabs.length} page tab(s) open. Use provider_open to open/register a provider tab (providerKey â†’ tabId).` }],
        };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 15000;
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }
        prompt = normalizePrompt(prompt);
        // comet_* = Perplexity alias over the generic ask-and-wait (P1 migration path)
        const driver = getDriver('perplexity')!;
        const session = await openTab('perplexity', { newTab: args?.newChat === true });
        if (args?.newChat === true) await driver.reset(session);
        const outcome = await askAndWait(driver, prompt, timeout);
        if (outcome.completed) {
          return { content: [{ type: "text", text: compactAskResult('perplexity', outcome) }] };
        }
        return { content: [{ type: "text", text: renderInProgress(outcome, true) }] };
      }

      case "comet_poll": {
        const driver = getDriver('perplexity')!;
        const session = await openTab('perplexity');
        const poll = await driver.poll(session);
        recordPollSuccess(session.targetId);
        return { content: [{ type: "text", text: renderPoll(poll, 'perplexity') }] };
      }

      case "comet_stop": {
        const driver = getDriver('perplexity')!;
        const session = await openTab('perplexity');
        const stopped = await driver.stop(session);
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "provider_ask": {
        const provider = String(args?.provider ?? '');
        const driver = getDriver(provider);
        if (!driver) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${listDrivers().join(', ')})` }], isError: true };
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 15000;
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }
        prompt = normalizePrompt(prompt);
        // P3: address the session explicitly â€” reuse the registered tab unless a
        // specific tabId was requested.
        const idempotencyKey = args?.idempotencyKey ? String(args.idempotencyKey) : undefined;
        const tabId = String(args?.tabId ?? '');
        // 2026-08-07: DISPATCH + return immediately (async ask registry). Long asks
        // used to block the whole RPC window and get abandoned by the pi gateway
        // (-32001) mid-ask, stranding the prompt in the composer. Now the ask is
        // dispatched fire-and-forget; the client polls via provider_poll and the
        // server advances the lifecycle (stability window, dedup, receipt) across
        // polls, storing the completed response for provider_response.
        const session = tabId ? (tabRegistry.get(tabId) ?? await openTab(provider)) : await openTab(provider);
        if (!session) return { content: [{ type: "text", text: `no registered tab: ${tabId} â€” use provider_open first` }], isError: true };
        try {
          const dispatched = await dispatchAsk(driver, session, prompt, {
            idempotencyKey,
            timeoutMs: timeout,
            completionMarker: args?.completionMarker === true, // ADR 0010 sentinel
          });
          if (dispatched.replayed) {
            const { eventsForCorrelation } = await import('./core/event-store.js');
            const evs = eventsForCorrelation(dispatched.correlationId);
            const resp = [...evs].reverse().find((e) => e.type === 'response.received');
            return { content: [{ type: "text", text: JSON.stringify({ status: 'completed', replayed: true, correlationId: dispatched.correlationId, idempotencyKey: dispatched.idempotencyKey, preview: resp?.response?.poll?.response?.slice(0, 200) ?? '' }) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ status: dispatched.status, correlationId: dispatched.correlationId, idempotencyKey: dispatched.idempotencyKey, hint: 'use provider_poll to advance, provider_response to fetch full content' }) }] };
        } catch (error) {
          return { content: [{ type: "text", text: `provider_ask dispatch failed: ${error instanceof Error ? error.message : error}` }], isError: true };
        }
      }

      case "provider_poll": {
        const provider = String(args?.provider ?? '');
        const driver = getDriver(provider);
        if (!driver) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${listDrivers().join(', ')})` }], isError: true };
        const tabId = String(args?.tabId ?? '');
        const session = tabId ? tabRegistry.get(tabId) : await openTab(provider);
        if (!session) return { content: [{ type: "text", text: `no registered tab: ${tabId} â€” use provider_open first` }], isError: true };
        // 2026-08-07: if this provider has a dispatched ask pending, advance it
        // (one poll step; completes when the stability window holds, storing the
        // response server-side for provider_response).
        const pendingKey = lastDispatchedFor(provider);
        if (pendingKey && isAskPending(pendingKey)) {
          const outcome = await advanceAsk(pendingKey);
          if (outcome) {
            if (outcome.completed) {
              return { content: [{ type: "text", text: compactAskResult(provider, outcome) }] };
            }
            return { content: [{ type: "text", text: renderInProgress(outcome) }] };
          }
          // transient poll failure — keep pending, report current tab state
        } else if (pendingKey) {
          // 2026-08-09 (ADR 0011, live-caught): the fast ADVANCER may have already
          // finalized this ask server-side (pending entry removed, event store
          // clean, sentinel stripped). Do NOT fall through to a raw driver.poll —
          // that would re-store the UNSTRIPPED response. Recover the stored outcome
          // via replayOutcomeIfRecorded (reads the event store by idempotencyKey).
          const replayed = replayOutcomeIfRecorded(pendingKey);
          if (replayed) {
            return { content: [{ type: "text", text: compactAskResult(provider, replayed) }] };
          }
        }
        const poll = await driver.poll(session);
        recordPollSuccess(session.targetId);
        return { content: [{ type: "text", text: renderPoll(poll, provider) }] };
      }

      case "provider_stop": {
        const provider = String(args?.provider ?? '');
        const driver = getDriver(provider);
        if (!driver) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${listDrivers().join(', ')})` }], isError: true };
        const tabId = String(args?.tabId ?? '');
        const session = tabId ? tabRegistry.get(tabId) : await openTab(provider);
        if (!session) return { content: [{ type: "text", text: `no registered tab: ${tabId} â€” use provider_open first` }], isError: true };
        const stopped = await driver.stop(session);
        return {
          content: [{
            type: "text",
            text: stopped ? `${provider} stopped` : `${provider}: no active generation to stop`,
          }],
        };
      }

      case "comet_screenshot": {
        // P3: screenshot the registered Perplexity tab via its pooled session;
        // fall back to the global client only if no tab is registered.
        const session = tabRegistry.getProviderTab('perplexity');
        if (session && sessionPool.get(session.targetId)) {
          const handle = sessionPool.get(session.targetId)!;
          const result = await handle.screenshot("png");
          return {
            content: [{ type: "image", data: result.data, mimeType: "image/png" }],
          };
        }
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;
        // P3: comet_mode is Perplexity-specific â€” address the registered Perplexity
        // tab via its pooled session, falling back to the global client.
        const session = tabRegistry.getProviderTab('perplexity');
        const handle = session ? sessionPool.get(session.targetId) : null;
        const evalExpr = async (expression: string) =>
          handle ? handle.evaluate(expression) : cometClient.evaluate(expression);
        const navigatePplx = async () => {
          if (handle) await handle.navigate("https://www.perplexity.ai/", true);
          else await cometClient.navigate("https://www.perplexity.ai/", true);
        };

        // If no mode provided, show current mode
        if (!mode) {
          const result = await evalExpr(`
            (() => {
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "â†’" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await navigatePplx();
        }

        // Try both UI patterns: button group (wide) and dropdown (narrow)
        const result = await evalExpr(`
          (() => {
            // Strategy 1: Direct button (wide screen)
            const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
            if (btn) {
              btn.click();
              return { success: true, method: 'button' };
            }

            // Strategy 2: Dropdown menu (narrow screen)
            // Find and click the dropdown trigger (button with current mode text)
            const allButtons = document.querySelectorAll('button');
            for (const b of allButtons) {
              const text = b.innerText.toLowerCase();
              if ((text.includes('search') || text.includes('research') ||
                   text.includes('labs') || text.includes('learn')) &&
                  b.querySelector('svg')) {
                b.click();
                return { success: true, method: 'dropdown-open', needsSelect: true };
              }
            }

            return { success: false, error: "Mode selector not found" };
          })()
        `);

        const clickResult = result.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

        if (clickResult.success && clickResult.needsSelect) {
          // Wait for dropdown to open, then select the mode
          await new Promise(resolve => setTimeout(resolve, 300));
          const selectResult = await evalExpr(`
            (() => {
              // Look for dropdown menu items
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              for (const item of items) {
                if (item.innerText.toLowerCase().includes('${mode}')) {
                  item.click();
                  return { success: true };
                }
              }
              return { success: false, error: "Mode option not found in dropdown" };
            })()
          `);
          const selectRes = selectResult.result.value as { success: boolean; error?: string };
          if (selectRes.success) {
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          } else {
            return { content: [{ type: "text", text: `Failed: ${selectRes.error}` }], isError: true };
          }
        }

        if (clickResult.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        } else {
          return {
            content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
            isError: true,
          };
        }
      }

      case "provider_reconnect": {
        const provider = String(args?.provider ?? '');
        if (!knownProvider(provider)) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${knownProviders().join(', ')})` }], isError: true };
        try {
          const session = await tabRegistry.reconnect(provider as ProviderId);
          const cursor = session.extractionCursor ?? 'none';
          return { content: [{ type: "text", text: `provider_reconnect ${provider}: tabId=${session.tabId} state=${session.state} durableCursor=${cursor} â€” dedup anchors re-hydrated (unchanged content â†’ no new response event)` }] };
        } catch (error) {
          return { content: [{ type: "text", text: `provider_reconnect failed: ${error instanceof Error ? error.message : error}` }], isError: true };
        }
      }

      case "provider_open": {
        const provider = String(args?.provider ?? '');
        if (!knownProvider(provider)) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${knownProviders().join(', ')})` }], isError: true };
        try {
          const session = await tabRegistry.open(provider as ProviderId, { newTab: args?.newTab === true });
          return { content: [{ type: "text", text: `provider_open ${provider}: tabId=${session.tabId} state=${session.state} session=${session.cdpSessionId.slice(0, 40)}â€¦` }] };
        } catch (error) {
          return { content: [{ type: "text", text: `provider_open failed: ${error instanceof Error ? error.message : error}` }], isError: true };
        }
      }

      case "provider_list": {
        const sessions = tabRegistry.list();
        if (sessions.length === 0) return { content: [{ type: "text", text: "no provider tabs registered â€” use provider_open" }] };
        const lines = sessions.map((s) =>
          `  ${s.provider.padEnd(10)} tabId=${s.tabId}  ${s.state}  opened=${s.openedAt}` +
          (s.lastCompletedAt ? `  lastCompleted=${s.lastCompletedAt}` : '') +
          (s.lastContentHash ? `  hash=${s.lastContentHash.slice(0, 8)}` : '')
        );
        return { content: [{ type: "text", text: `${sessions.length} provider tab(s), pool ${sessionPool.size}/${sessionPool.cap}:\n${lines.join('\n')}` }] };
      }

      case "provider_close": {
        const provider = String(args?.provider ?? '');
        if (!knownProvider(provider)) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${knownProviders().join(', ')})` }], isError: true };
        const tabId = String(args?.tabId ?? '');
        const session = tabId ? tabRegistry.get(tabId) : tabRegistry.getProviderTab(provider as ProviderId);
        if (!session) return { content: [{ type: "text", text: `no registered tab for ${provider} â€” use provider_open first` }], isError: true };
        const { closed, reset } = await tabRegistry.close(session.targetId, { force: args?.force === true });
        if (reset) return { content: [{ type: "text", text: `${provider}: last-tab protection â€” tab reset instead of closed (sibling provider tabs untouched)` }] };
        return { content: [{ type: "text", text: closed ? `${provider} tab closed (tabId=${session.targetId})` : `${provider} tab ${session.targetId} not closed (not pooled?)` }] };
      }

      case "provider_health": {
        const provider = String(args?.provider ?? '');
        const driver = getDriver(provider);
        if (!driver) {
          // pre-driver provider (P6): delegate to the entry-level verify (no prompt)
          const { verifyProvider, listProviders } = await import("./core/discovery.js");
          if (!listProviders().includes(provider as any)) {
            return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${knownProviders().join(', ')})` }], isError: true };
          }
          try {
            const result = await verifyProvider(provider as any);
            if (!result.tabFound) {
              return { content: [{ type: "text", text: `no ${provider} tab found — open the provider tab in Comet first` }], isError: true };
            }
            let text = `${provider} health (entry-level verify, no prompt): ${result.healthy ? 'HEALTHY' : 'DEGRADED'}\n`;
            for (const c of result.checks) text += `  [${c.ok ? 'OK' : 'MISS'}${c.conditional ? ' (conditional)' : ''}] ${c.name}\n`;
            if (result.rebound?.length) text += `  ↺ rebind: ${result.rebound.join(', ')}\n`;
            return { content: [{ type: "text", text }] };
          } catch (error) {
            return { content: [{ type: "text", text: `provider_health failed: ${error instanceof Error ? error.message : error}` }], isError: true };
          }
        }
        const tabId = String(args?.tabId ?? '');
        const session = tabId ? tabRegistry.get(tabId) : tabRegistry.getProviderTab(driver.provider);
        if (!session) return { content: [{ type: "text", text: `no registered tab for ${provider} — use provider_open first` }], isError: true };
        const health = await driver.health(session);
        let text = `${provider} health (tabId=${session.targetId}): ${health.healthy ? 'HEALTHY' : 'DEGRADED'}${health.loginRequired ? ' LOGIN_REQUIRED' : ''}\n`;
        for (const c of health.hookResolution) text += `  [${c.source}] ${c.control}\n`;
        if (health.note) text += `  note: ${health.note}\n`;
        return { content: [{ type: "text", text }] };
      }

      case "provider_override": {
        const provider = String(args?.provider ?? '');
        const control = String(args?.control ?? '');
        const selector = String(args?.selector ?? '');
        const clear = args?.clear === true;
        if (!knownProvider(provider)) return { content: [{ type: "text", text: `Unknown provider: ${provider} (have: ${knownProviders().join(', ')})` }], isError: true };
        if (!control) return { content: [{ type: "text", text: 'Error: control required (composer, sendButton, modelPicker, newChat, responseContainer, ...)' }], isError: true };
        if (!clear && !selector) return { content: [{ type: "text", text: 'Error: selector required (or pass clear=true)' }], isError: true };
        const entry = loadEntry(provider as ProviderId);
        if (!entry) return { content: [{ type: "text", text: `no entry for ${provider} â€” run provider_discover first` }], isError: true };
        const controls = (entry.controls ?? {}) as Record<string, any>;
        if (clear) {
          delete controls[control];
        } else {
          controls[control] = { ...(controls[control] ?? {}), selector, confidence: 1, last_validated: Math.floor(Date.now() / 1000) };
        }
        writeEntry(entry);
        return { content: [{ type: "text", text: `provider_override: ${provider}.${control} ${clear ? 'cleared' : `set to "${selector}"`} (persisted)` }] };
      }

      case "provider_discover": {
        const providerArg = String(args?.provider ?? '');
        const { runDiscovery, diffEntry, listProviders } = await import("./core/discovery.js");
        const provider = listProviders().includes(providerArg as any) ? providerArg as any : null;
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown provider: ${providerArg} (have: ${listProviders().join(', ')})` }], isError: true };
        }
        const write = (args?.write as boolean | undefined) ?? true;
        const diff = (args?.diff as boolean | undefined) ?? true;
        try {
          const result = await runDiscovery(provider, { write });
          let text = `provider_discover ${provider}: state=${result.endedState} confidence=${result.confidence}\n` +
            `prompt: "${result.validationPrompt}" â†’ expected "${result.expectedToken}"\n` +
            `submit: ${result.submitMethod?.method ?? '?'}${result.submitMethod?.selector ? ' via ' + result.submitMethod.selector : ''}\n` +
            (result.wroteEntry ? `entry written: ${result.entryPath}\n` : 'entry NOT written\n') +
            (result.guarded?.existingBetter ? `⚠ NOT overwritten (downgrade guard): ${result.guarded.reason}\n` : '') +
            `fixtures: ${Object.keys(result.fixtures).join(', ') || '(none)'}`;
          if (diff && result.wroteEntry) {
            const d = diffEntry(provider, result.entry);
            text += `\n\ndiff vs ${d.against ?? 'none'}:\n` + (d.changes.length ? d.changes.join('\n') : 'unchanged');
          }
          return { content: [{ type: "text", text }] };
        } catch (error) {
          return { content: [{ type: "text", text: `provider_discover failed: ${error instanceof Error ? error.message : error}` }], isError: true };
        }
      }

      case "provider_verify": {
        const providerArg = String(args?.provider ?? '');
        const { verifyProvider, listProviders } = await import("./core/discovery.js");
        const provider = listProviders().includes(providerArg as any) ? providerArg as any : null;
        if (!provider) {
          return { content: [{ type: "text", text: `Unknown provider: ${providerArg} (have: ${listProviders().join(', ')})` }], isError: true };
        }
        try {
          const result = await verifyProvider(provider);
          if (!result.tabFound) {
            return { content: [{ type: "text", text: `No ${provider} tab found â€” open the provider tab in Comet first` }], isError: true };
          }
          let text = `${provider} verify (no prompt sent):\n`;
          for (const c of result.checks) text += `  [${c.ok ? 'OK' : 'MISS'}] ${c.name}: ${c.selector}${c.conditional ? ' (conditional)' : ''}\n`;
          text += result.healthy ? 'HEALTHY' : 'UNHEALTHY â€” re-run: provider_discover ' + provider;
          return { content: [{ type: "text", text }] };
        } catch (error) {
          return { content: [{ type: "text", text: `provider_verify failed: ${error instanceof Error ? error.message : error}` }], isError: true };
        }
      }

      case "provider_response": {
        const id = String(args?.responseId ?? '');
        const offset = (args?.offset as number) ?? 0;
        const limit = (args?.limit as number) ?? 4000;
        if (!id) return { content: [{ type: "text", text: "Error: responseId required" }], isError: true };
        const { ok, rec, chunk, error } = readResponseChunk(id, offset, limit);
        if (!ok) return { content: [{ type: "text", text: error || 'not found' }], isError: true };
        return {
          content: [{ type: "text", text: `${chunk}${error ? `\n[${error}]` : ''}\n\n(responseId ${rec!.id}, ${rec!.fullChars} chars total)` }],
        };
      }

      case "relay_prepare": {
        const sourceCorrelationId = String(args?.sourceCorrelationId ?? '');
        const destination = String(args?.destination ?? '');
        if (!sourceCorrelationId) return { content: [{ type: "text", text: "Error: sourceCorrelationId required (the completed source ask's correlationId)" }], isError: true };
        if (!knownProvider(destination)) return { content: [{ type: "text", text: `Unknown destination: ${destination} (have: ${knownProviders().join(', ')})` }], isError: true };
        const { prepareRelay } = await import('./core/relay.js');
        // 2026-08-09 latency fix: bounded auto-advance of a PENDING source ask so
        // a just-finished source is relayable immediately (≤3 advanceAsk steps /
        // ~10s wall; source only, never the destination).
        const result = await prepareRelay(
          {
            sourceCorrelationId,
            destination: destination as ProviderId,
            attributionHeader: args?.attributionHeader ? String(args.attributionHeader) : undefined,
            contentSizeLimitBytes: args?.contentSizeLimitBytes as number | undefined,
            deadlineMs: args?.deadlineMs as number | undefined,
            maxRelaysPerCorrelation: args?.maxRelaysPerCorrelation as number | undefined,
            rawMarkdown: args?.rawMarkdown as boolean | undefined,
            contentPersistenceMode: args?.contentPersistenceMode as any,
          },
          {
            // drive the pending SOURCE ask toward terminal-success (source only)
            isSourcePending: () => {
              const key = pendingKeyForCorrelation(sourceCorrelationId);
              return !!key && isAskPending(key);
            },
            advanceSource: async () => {
              const key = pendingKeyForCorrelation(sourceCorrelationId);
              if (key && isAskPending(key)) await advanceAsk(key);
            },
          },
        );
        if (!result.ok) {
          return { content: [{ type: "text", text: `relay_prepare blocked: ${result.error}` }], isError: true };
        }
        // compact result (gateway budget) — full envelope content lives on disk via provider_response
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: 'prepared',
              correlationId: result.correlationId,
              idempotencyKey: result.idempotencyKey,
              source: result.envelope.source,
              destination: result.envelope.destination,
              contentChars: result.envelope.content.length,
              attributionHeader: result.evaluation.effective.attributionHeader,
              approvalRequired: result.approvalRequired,
              approvalHash: result.envelopeHash,
              policyVersion: result.evaluation.effective.policyVersion,
              markdownAction: result.evaluation.markdownAction,
              contentPersistenceMode: result.evaluation.effective.contentPersistenceMode ?? 'redacted',
              deadlineMs: result.evaluation.effective.deadlineMs,
              hint: 'call relay_approve with approvalHash to approve, then relay_send'},
              null, 2),
          }],
        };
      }

      case "relay_approve": {
        const approvalHash = String(args?.approvalHash ?? '');
        const correlationId = String(args?.correlationId ?? '');
        if (!approvalHash) return { content: [{ type: "text", text: "Error: approvalHash required (from relay_prepare)" }], isError: true };
        if (!correlationId) return { content: [{ type: "text", text: "Error: correlationId required" }], isError: true };
        const { approveRelay, rejectRelay } = await import('./core/relay.js');
        const approved = args?.approved !== false; // default: approve
        const envelopeId = args?.envelopeId ? String(args.envelopeId) : undefined;
        const result = approved
          ? approveRelay({ approvalHash, correlationId, envelopeId, expiresAt: args?.expiresAt ? String(args.expiresAt) : undefined })
          : rejectRelay({ approvalHash, correlationId, envelopeId });
        if (!result.ok) {
          return { content: [{ type: "text", text: `relay_approve: ${result.error}` }], isError: true };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: result.status,
            approvalHash,
            correlationId,
            expiresAt: result.expiresAt,
            eventSeq: result.event?.seq,
            hint: approved ? 'call relay_send with the same approvalHash to send' : 'relay rejected — relay_send will refuse this hash' }, null, 2) }],
        };
      }

      case "relay_send": {
        const approvalHash = String(args?.approvalHash ?? '');
        const sourceCorrelationId = String(args?.sourceCorrelationId ?? '');
        const destination = String(args?.destination ?? '');
        if (!approvalHash) return { content: [{ type: "text", text: "Error: approvalHash required" }], isError: true };
        if (!sourceCorrelationId) return { content: [{ type: "text", text: "Error: sourceCorrelationId required" }], isError: true };
        if (!knownProvider(destination)) return { content: [{ type: "text", text: `Unknown destination: ${destination} (have: ${knownProviders().join(', ')})` }], isError: true };
        const driver = getDriver(destination);
        if (!driver) return { content: [{ type: "text", text: `No driver for destination ${destination} — cannot send` }], isError: true };
        const { sendRelay } = await import('./core/relay.js');
        const result = await sendRelay(
          {
            approvalHash,
            sourceCorrelationId,
            destination: destination as ProviderId,
            attributionHeader: args?.attributionHeader ? String(args.attributionHeader) : undefined,
            contentSizeLimitBytes: args?.contentSizeLimitBytes as number | undefined,
            deadlineMs: args?.deadlineMs as number | undefined,
            maxRelaysPerCorrelation: args?.maxRelaysPerCorrelation as number | undefined,
            rawMarkdown: args?.rawMarkdown as boolean | undefined,
            contentPersistenceMode: args?.contentPersistenceMode as any,
          },
          {
            // surface-gone pre-flight: destination tab must be addressable
            preflight: async () => {
              const tab = tabRegistry.getProviderTab(destination as ProviderId);
              return tab ? { ok: true } : { ok: false, reason: `no registered tab for ${destination} — use provider_open first` };
            },
            // actual send: open/ensure tab + dispatch async ask (client polls via provider_poll)
            send: async (wireContent: string) => {
              try {
                const session = await openTab(destination);
                if (!session) return { ok: false, error: `could not open destination tab for ${destination}` };
                const dispatched = await dispatchAsk(driver, session, wireContent);
                return { ok: true, correlationId: dispatched.correlationId, idempotencyKey: dispatched.idempotencyKey };
              } catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
              }
            },
          },
        );
        if (!result.ok) {
          return { content: [{ type: "text", text: `relay_send ${result.status}: ${result.error}` }], isError: true };
        }
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: 'sent',
            destination,
            destinationCorrelationId: result.destinationCorrelationId,
            destinationIdempotencyKey: result.destinationIdempotencyKey,
            envelopeHash: result.envelopeHash,
            receiptSeq: result.receiptSeq,
            hint: 'use provider_poll with the destination provider to advance the destination ask',
          }, null, 2) }],
        };
      }

      case "relay_reconcile": {
        const relayCorrelationId = String(args?.relayCorrelationId ?? '');
        const destinationCorrelationId = String(args?.destinationCorrelationId ?? '');
        if (!relayCorrelationId) return { content: [{ type: "text", text: "Error: relayCorrelationId required (from relay_send)" }], isError: true };
        if (!destinationCorrelationId) return { content: [{ type: "text", text: "Error: destinationCorrelationId required (from relay_send)" }], isError: true };
        const { reconcileRelay } = await import('./core/relay.js');
        const destinationIdempotencyKey = args?.destinationIdempotencyKey ? String(args.destinationIdempotencyKey) : undefined;
        const result = reconcileRelay(
          { relayCorrelationId, destinationCorrelationId, destinationIdempotencyKey },
          { isDestinationPending: (key) => isAskPending(key) },
        );
        return {
          content: [{ type: "text", text: JSON.stringify({
            state: result.state,
            ok: result.ok,
            terminal: result.terminal,
            matchedBy: result.matchedBy,
            providerMessageId: result.providerMessageId,
            contentHash: result.contentHash,
            details: result.details,
            hint: result.terminal && result.state !== 'reconciled'
              ? 'terminal — no auto-resend; run relay_prepare + relay_approve again for a fresh approval'
              : (result.state === 'timed_out' ? 'non-terminal — poll provider_poll again (may complete_late)' : undefined),
          }, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);

// 2026-08-08 (four-opinion design): poll-independent reaper — bounds the pending-ask
// registry on a wall clock even when a client never polls again (abandoned asks).
startReaper();
// 2026-08-09 (user-requested): fast internal advance timer — finalizes finished asks
// between client polls so the next provider_poll is a pure read of a completed ask.
startAdvancer();
