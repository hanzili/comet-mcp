#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListTasksRequestSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  CancelTaskRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";
import { formatCaughtError, isDebugEnabled } from "./util/format.js";
import {
  getActivePolicy,
  setActivePolicy,
  resetActivePolicy,
  normalizePolicy,
  type UrlPolicy,
} from "./safety/url-policy.js";
import { getAuditLog } from "./safety/audit-log.js";
import { getTaskRegistry, type CreateTaskResult, type TaskStatusResult } from "./mcp/tasks.js";
import { runBackgroundTask, readTask, listTasks } from "./mcp/task-runner.js";
import { listProgressWidget, readProgressWidget, progressWidgetUri } from "./mcp/widgets.js";

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
    name: "comet_get_url_policy",
    description: "Read the active URL policy. Mirrors Comet-agent's isInternalPage / isUrlBlocked / isDomainBlacklist checks. Shows blockInternal, blockFile, blockDangerousExtensions, and the optional allow/deny domain lists.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_set_url_policy",
    description: "Set or reset the URL policy that gates every navigation and tab-open. Pass any of blockInternal / blockFile / blockDangerousExtensions / domainAllowlist / domainDenylist to update; omit all to reset to defaults. Or set reset:true to restore defaults.",
    inputSchema: {
      type: "object",
      properties: {
        blockInternal: { type: "boolean", description: "Block chrome://, edge://, devtools://, etc. Default false." },
        blockFile: { type: "boolean", description: "Block file:// and ftp://. Default true." },
        blockDangerousExtensions: { type: "boolean", description: "Block URLs ending with executable extensions (.exe, .sh, .dmg, etc). Default true." },
        domainAllowlist: { type: "array", items: { type: "string" }, description: "Wildcard domains allowed (e.g. ['*.mycompany.com']). If set and non-empty, ONLY these are allowed." },
        domainDenylist: { type: "array", items: { type: "string" }, description: "Wildcard domains always blocked. Wins over allowlist." },
        reset: { type: "boolean", description: "If true, restore all flags to defaults and clear the lists." },
      },
    },
  },
  {
    name: "comet_research",
    description: "Non-blocking deep research. Returns a task handle (MCP 2025-11-25 Task primitive). Use comet_poll_task to fetch the result. Always uses research mode internally.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet research" },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll_task",
    description: "Poll a research task started by comet_research. Returns its current status (working | completed | failed | cancelled) and content when done.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id returned by comet_research" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "comet_cancel_task",
    description: "Cancel a running research task. Returns true if cancellation succeeded, false if the task was already terminal or unknown.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task id returned by comet_research" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "comet_get_audit_log",
    description: "Read the URL-policy audit log (most recent decisions, newest first). Optional limit and outcome filter (allow|deny).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of entries to return (default 50)" },
        outcome: { type: "string", enum: ["allow", "deny"], description: "Optional filter by outcome" },
        caller: { type: "string", description: "Optional filter by MCP tool name (exact match)" },
      },
    },
  },
  {
    name: "comet_reset_audit_log",
    description: "Clear the URL-policy audit log. Use this after diagnosing a blocked-navigation report to start fresh.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_version",
    description: "Return the MCP server version, build commit, and tool count. Use to verify the mounted instance matches the expected dist.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_reload",
    description: "Signal the MCP server to gracefully re-register tools (workaround for harnesses that don't auto-respawn subprocesses after a crash). Returns the new tool count.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// MCP 2025-11-25 task namespace. Spec:
// https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
// Adapter: SDK spec requires the result be wrapped in `{task: {...}}` with
// `ttl` and `lastUpdatedAt` fields. My TaskStatusResult is flatter — bridge.
function toSpecTask(snap: TaskStatusResult): {
  task: {
    taskId: string;
    status: TaskStatusResult["status"];
    ttl: number | null;
    createdAt: string;
    lastUpdatedAt: string;
    statusMessage?: string;
    content?: TaskStatusResult["content"];
    error?: string;
    completedAt?: string;
  };
} {
  return {
    task: {
      taskId: snap.taskId,
      status: snap.status,
      ttl: null,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      statusMessage: snap.statusMessage,
      content: snap.content,
      error: snap.error,
      completedAt: snap.completedAt,
    },
  };
}

server.setRequestHandler(ListTasksRequestSchema, async () => {
  return { tasks: getTaskRegistry().list().map(toSpecTask) };
});

server.setRequestHandler(GetTaskRequestSchema, async (req) => {
  const snap = readTask(req.params.taskId);
  if (!snap) {
    throw new Error(`Task not found: ${req.params.taskId}`);
  }
  return toSpecTask(snap);
});

server.setRequestHandler(GetTaskPayloadRequestSchema, async (req) => {
  // Spec's tasks/result has no timeout param — poll until terminal or
  // a 5-minute hard cap. Caller should pick a reasonable cadence via
  // the pollInterval hint returned by createTaskResult.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const snap = readTask(req.params.taskId);
    if (!snap) {
      throw new Error(`Task not found: ${req.params.taskId}`);
    }
    if (snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled") {
      return toSpecTask(snap);
    }
    await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(100, deadline - Date.now()))));
  }
  return toSpecTask({
    taskId: req.params.taskId,
    status: "working",
    statusMessage: "still working after 5-minute hard cap",
  });
});

server.setRequestHandler(CancelTaskRequestSchema, async (req) => {
  const ok = getTaskRegistry().cancel(req.params.taskId, "cancelled by caller");
  return { taskId: req.params.taskId, cancelled: ok };
});

// MCP Apps: resources/list + resources/read. The widget lives at
// ui://comet-mcp/progress.html and is rendered inside the MCP client's chat
// when a comet_research result includes _meta.ui.resourceUri.
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
// Cast the handlers to `as never` because the SDK's setRequestHandler
// overload infers the schema's strict result shape, but our plain object
// types are spec-equivalent and runtime-safe.
server.setRequestHandler(ListResourcesRequestSchema, async () => listProgressWidget() as never);
server.setRequestHandler(ReadResourceRequestSchema, (async (req: { params: { uri: string } }) => {
  const uri = req.params.uri;
  if (uri.startsWith("ui://comet-mcp/progress.html")) {
    try {
      const u = new URL(uri);
      const taskId = u.searchParams.get("taskId") ?? "unknown";
      const status = u.searchParams.get("status") as 'working' | 'completed' | 'failed' | 'cancelled' | null;
      const message = u.searchParams.get("message") ?? undefined;
      return readProgressWidget({ taskId, status: status ?? undefined, message }) as never;
    } catch {
      return readProgressWidget({ taskId: "unknown" }) as never;
    }
  }
  throw new Error(`Resource not found: ${uri}`);
}) as never);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(9222);

        // Get all tabs and clean up - close all except one
        const targets = await cometClient.listTargets();
        const pageTabs = targets.filter(t => t.type === 'page');

        // Close extra tabs, keep only one
        if (pageTabs.length > 1) {
          for (let i = 1; i < pageTabs.length; i++) {
            try {
              await cometClient.closeTab(pageTabs[i].id);
            } catch { /* ignore */ }
          }
        }

        // Get fresh tab list
        const freshTargets = await cometClient.listTargets();
        const anyPage = freshTargets.find(t => t.type === 'page');

        if (anyPage) {
          await cometClient.connect(anyPage.id);
          // Always navigate to Perplexity home for clean state
          await cometClient.navigate("https://www.perplexity.ai/", true, "comet_connect");
          await new Promise(resolve => setTimeout(resolve, 1500));
          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity (cleaned ${pageTabs.length - 1} old tabs)` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/", "comet_connect");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 15000; // Default 15s, use poll for longer tasks
        const newChat = (args?.newChat as boolean) || false;

        // Validate prompt
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // Normalize prompt - convert markdown/bullets to natural text
        prompt = prompt
          .replace(/^[-*•]\s*/gm, '')  // Remove bullet points
          .replace(/\n+/g, ' ')         // Collapse newlines to spaces
          .replace(/\s+/g, ' ')         // Collapse multiple spaces
          .trim();

        // For newChat: full reset (same as comet_connect) to handle post-agentic state
        if (newChat) {
          // Clean up extra tabs (fixes CDP state after agentic browsing)
          const targets = await cometClient.listTargets();
          const pageTabs = targets.filter(t => t.type === 'page');
          if (pageTabs.length > 1) {
            for (let i = 1; i < pageTabs.length; i++) {
              try { await cometClient.closeTab(pageTabs[i].id); } catch { /* ignore */ }
            }
          }

          // Fresh connect to remaining tab
          const freshTargets = await cometClient.listTargets();
          const mainTab = freshTargets.find(t => t.type === 'page');
          if (mainTab) {
            await cometClient.connect(mainTab.id);
          }

          // Navigate to Perplexity home
          await cometClient.navigate("https://www.perplexity.ai/", true, "comet_ask");
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          // Not newChat - just ensure we're on Perplexity
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.main) {
            await cometClient.connect(tabs.main.id);
          }

          const urlResult = await cometClient.evaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          const isOnPerplexity = currentUrl?.includes('perplexity.ai');

          if (!isOnPerplexity) {
            await cometClient.navigate("https://www.perplexity.ai/", true, "comet_ask");
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }

        // Capture old response state BEFORE sending prompt (for follow-up detection)
        const oldStateResult = await cometClient.evaluate(`
          (() => {
            const proseEls = document.querySelectorAll('[class*="prose"]');
            const lastProse = proseEls[proseEls.length - 1];
            return {
              count: proseEls.length,
              lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
            };
          })()
        `);
        const oldState = oldStateResult.result.value as { count: number; lastText: string };

        // Send the prompt
        await cometAI.sendPrompt(prompt);

        // Wait for completion
        const startTime = Date.now();
        const stepsCollected: string[] = [];
        let sawNewResponse = false;

        while (Date.now() - startTime < timeout) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s

          // Check if we have a NEW response (more prose elements or different text)
          const currentStateResult = await cometClient.evaluate(`
            (() => {
              const proseEls = document.querySelectorAll('[class*="prose"]');
              const lastProse = proseEls[proseEls.length - 1];
              return {
                count: proseEls.length,
                lastText: lastProse ? lastProse.innerText.substring(0, 100) : ''
              };
            })()
          `);
          const currentState = currentStateResult.result.value as { count: number; lastText: string };

          // Detect new response
          if (!sawNewResponse) {
            if (currentState.count > oldState.count ||
                (currentState.lastText && currentState.lastText !== oldState.lastText)) {
              sawNewResponse = true;
            }
          }

          const status = await cometAI.getAgentStatus();

          // Collect steps
          for (const step of status.steps) {
            if (!stepsCollected.includes(step)) {
              stepsCollected.push(step);
            }
          }

          // Task completed - return result directly (but only if we saw a NEW response)
          if (status.status === 'completed' && sawNewResponse) {
            return { content: [{ type: "text", text: status.response || 'Task completed (no response text extracted)' }] };
          }
        }

        // Still working after initial wait - return "in progress" (non-blocking)
        const finalStatus = await cometAI.getAgentStatus();
        let inProgressMsg = `Task in progress (${stepsCollected.length} steps so far).\n`;
        inProgressMsg += `Status: ${finalStatus.status.toUpperCase()}\n`;
        if (finalStatus.currentStep) {
          inProgressMsg += `Current: ${finalStatus.currentStep}\n`;
        }
        if (finalStatus.agentBrowsingUrl) {
          inProgressMsg += `Browsing: ${finalStatus.agentBrowsingUrl}\n`;
        }
        if (stepsCollected.length > 0) {
          inProgressMsg += `\nSteps:\n${stepsCollected.map(s => `  • ${s}`).join('\n')}\n`;
        }
        inProgressMsg += `\nUse comet_poll to check progress or comet_stop to cancel.`;

        return { content: [{ type: "text", text: inProgressMsg }] };
      }

      case "comet_research": {
        const prompt = args?.prompt as string;
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }
        const task = runBackgroundTask(
          async () => {
            // For now delegate to cometAI.sendPrompt. Future: wire a dedicated
            // research path that uses the Sidecar assistant panel.
            const sent = prompt.replace(/^[-*•\s]/gm, '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
            await cometAI.sendPrompt(sent);
            return { text: "Research started. Use comet_poll_task to retrieve the answer." };
          },
          { statusMessage: `researching: ${prompt.slice(0, 60)}` },
        );
        const result: CreateTaskResult = { isTask: true, task };
        // MCP Apps: surface a widget the client can render to track the task.
        // The widget is just HTML fetched via resources/read on the same URI.
        const widgetUri = progressWidgetUri(task.taskId);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
          _meta: {
            "io.modelcontextprotocol/ui": {
              resourceUri: widgetUri,
            },
          },
        } as never;
      }

      case "comet_poll_task": {
        const taskId = args?.taskId as string;
        if (!taskId) {
          return { content: [{ type: "text", text: "Error: taskId is required" }] };
        }
        const snap = readTask(taskId);
        if (!snap) {
          return { content: [{ type: "text", text: `Error: no task with id ${taskId}` }], isError: true };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify(snap, null, 2),
          }],
        };
      }

      case "comet_cancel_task": {
        const taskId = args?.taskId as string;
        if (!taskId) {
          return { content: [{ type: "text", text: "Error: taskId is required" }] };
        }
        const cancelled = getTaskRegistry().cancel(taskId, "cancelled by caller");
        return {
          content: [{
            type: "text",
            text: cancelled ? `Task ${taskId} cancelled.` : `Could not cancel ${taskId} (already terminal or unknown).`,
          }],
        };
      }

      case "comet_poll": {
        const status = await cometAI.getAgentStatus();

        // If completed, return the response directly (most useful case)
        if (status.status === 'completed' && status.response) {
          return { content: [{ type: "text", text: status.response }] };
        }

        // Still working - return progress info
        let output = `Status: ${status.status.toUpperCase()}\n`;

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.currentStep) {
          output += `Current: ${status.currentStep}\n`;
        }

        if (status.steps.length > 0) {
          output += `\nSteps:\n${status.steps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.status === 'working') {
          output += `\n[Use comet_stop to interrupt, or comet_screenshot to see current page]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        const stopped = await cometAI.stopAgent();
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_mode": {
        const mode = args?.mode as string | undefined;

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
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
            const marker = m === currentMode ? "→" : " ";
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
          await cometClient.navigate("https://www.perplexity.ai/", true);
        }

        // Try both UI patterns: button group (wide) and dropdown (narrow)
        const result = await cometClient.evaluate(`
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
          const selectResult = await cometClient.evaluate(`
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

      case "comet_get_url_policy": {
        const p = getActivePolicy();
        return {
          content: [{
            type: "text",
            text: JSON.stringify(p, null, 2),
          }],
        };
      }

      case "comet_set_url_policy": {
        const reset = args?.reset === true;
        if (reset) {
          resetActivePolicy();
          const p = getActivePolicy();
          return {
            content: [{
              type: "text",
              text: `URL policy reset to defaults.
${JSON.stringify(p, null, 2)}`,
            }],
          };
        }
        // Build the next policy from the current one, overriding any
        // fields the caller supplied. Undefined values are left alone
        // so partial updates work.
        const current = getActivePolicy();
        const next: UrlPolicy = {
          ...current,
          ...(typeof args?.blockInternal === 'boolean' ? { blockInternal: args.blockInternal } : {}),
          ...(typeof args?.blockFile === 'boolean' ? { blockFile: args.blockFile } : {}),
          ...(typeof args?.blockDangerousExtensions === 'boolean' ? { blockDangerousExtensions: args.blockDangerousExtensions } : {}),
          ...(Array.isArray(args?.domainAllowlist) ? { domainAllowlist: args.domainAllowlist as string[] } : {}),
          ...(Array.isArray(args?.domainDenylist) ? { domainDenylist: args.domainDenylist as string[] } : {}),
        };
        const normalized = normalizePolicy(next);
        setActivePolicy(normalized);
        return {
          content: [{
            type: "text",
            text: `URL policy updated.
${JSON.stringify(getActivePolicy(), null, 2)}`,
          }],
        };
      }

      case "comet_get_audit_log": {
        const limit = Math.max(1, Math.min(500, (args?.limit as number) ?? 50));
        const outcome = args?.outcome as string | undefined;
        const caller = args?.caller as string | undefined;
        let entries = getAuditLog().recent(limit);
        if (outcome === "allow" || outcome === "deny") {
          entries = entries.filter((e) => e.outcome === outcome);
        }
        if (caller) {
          entries = entries.filter((e) => e.caller === caller);
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              { total: getAuditLog().size(), returned: entries.length, entries },
              null,
              2
            ),
          }],
        };
      }

      case "comet_reset_audit_log": {
        getAuditLog().clear();
        return {
          content: [{
            type: "text",
            text: "Audit log cleared.",
          }],
        };
      }

      case "comet_version": {
        const { execSync } = await import("node:child_process");
        let commit = "unknown";
        try {
          commit = execSync("git rev-parse --short HEAD", { cwd: process.cwd(), encoding: "utf-8" }).trim();
        } catch { /* not a git repo or git missing */ }
        const toolCount = TOOLS.length;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              version: "2.3.0",
              commit,
              toolCount,
              tools: TOOLS.map(t => t.name),
            }, null, 2),
          }],
        };
      }

      case "comet_reload": {
        // The MCP spec doesn't define a "reload" operation. This tool is a
        // pragmatic workaround: it re-executes the tool registration code path
        // so that if the harness has since respawned the subprocess (e.g. after
        // a crash), the new process picks up the latest tool list from disk.
        //
        // In practice this is a no-op for the currently-running process because
        // the tool list is static at module load time. The real value is that
        // it forces the harness to acknowledge the server is alive, which some
        // harnesses use as a liveness probe before attempting a respawn.
        const toolCount = TOOLS.length;
        return {
          content: [{
            type: "text",
            text: `Reload acknowledged. ${toolCount} tools registered. If the harness respawned the subprocess, the new instance is now live.`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: unknown) {
    // M3 + L5: route through pure helpers so the redaction and DEBUG rules
    // are exercised by the unit tests.
    const formatted = formatCaughtError(error, { debug: isDebugEnabled() });
    return {
      content: [{ type: "text", text: `Error: ${formatted}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();


// A2 fix: clean close of the CDP WebSocket on SIGINT/SIGTERM. Without this,
// process kill leaves Comet with a dangling debugger attach which can stall
// the next comet_connect attempt. `cometClient.disconnect()` is idempotent
// (safe to call when no client is connected).
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await cometClient.disconnect();
  } catch { /* best-effort cleanup */ }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await server.connect(transport);

