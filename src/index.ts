#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description: "Connect to Comet browser (auto-starts if needed)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: `Send a prompt to Comet/Perplexity and wait for the complete response (blocking).

WHEN TO USE COMET vs other tools:
- USE COMET for: tasks requiring real browser interaction (login walls, dynamic content, multi-step navigation, filling forms, clicking buttons, scraping live data from specific sites)
- USE COMET for: deep research that benefits from Perplexity's agentic browsing (comparing multiple sources, following links, comprehensive analysis)
- USE regular WebSearch/WebFetch for: simple factual queries, quick lookups, static content

IMPORTANT - Comet is for DOING, not just ASKING:
- DON'T ask "how to" questions → use WebSearch instead
- DO ask Comet to perform actions: "Go to X and do Y"
- Bad: "How do I generate a P8 key in App Store Connect?"
- Good: "Take over the browser, go to App Store Connect, navigate to In-App Purchase keys section"

PROMPTING TIPS:
- Give context and goals, not step-by-step instructions
- Example: "Research the pricing models of top 3 auth providers for a B2B SaaS" (good)
- Example: "Go to auth0.com, click pricing, then go to clerk.dev..." (less effective)
- Comet will figure out the best browsing strategy

FORMATTING WARNING:
- Write prompts as natural sentences, NOT bullet points or markdown
- Bad: "- Name: foo\\n- URL: bar" (newlines may be stripped, becomes confusing text)
- Good: "The name is foo and the URL is bar"`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        timeout: { type: "number", description: "Max wait time in ms (default: 300000 = 5 min)" },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        agentic: { type: "boolean", description: "Enable browser control mode - prepends 'Take control of my browser and' to trigger Comet's agentic browsing (default: false)" },
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
    description: "Capture a screenshot of current page or the agent's browsing tab",
    inputSchema: {
      type: "object",
      properties: {
        agent_tab: { type: "boolean", description: "If true, capture the agent's browsing tab (where it navigated during agentic tasks) instead of the main Perplexity page" },
      },
    },
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
];

const server = new Server(
  { name: "comet-bridge", version: "2.2.1" },
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
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1500));
          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity (cleaned ${pageTabs.length - 1} old tabs)` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        let prompt = args?.prompt as string;
        const timeout = (args?.timeout as number) || 300000; // Default 5 minutes
        const newChat = (args?.newChat as boolean) || false;
        const agentic = (args?.agentic as boolean) || false;

        // Validate prompt
        if (!prompt || prompt.trim().length === 0) {
          return { content: [{ type: "text", text: "Error: prompt cannot be empty" }] };
        }

        // Prepend agentic instruction if requested (official Perplexity recommendation)
        if (agentic) {
          prompt = `Take control of my browser and ${prompt}`;
        }

        // Get fresh URL from browser (not cached state)
        const urlResult = await cometClient.evaluate('window.location.href');
        const currentUrl = urlResult.result.value as string;
        const isOnPerplexity = currentUrl?.includes('perplexity.ai');

        // Start fresh conversation if requested, or navigate if not on Perplexity
        if (newChat || !isOnPerplexity) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        }

        // Send the prompt
        await cometAI.sendPrompt(prompt);

        // Wait for completion with polling - log progress to stderr in real-time
        const startTime = Date.now();
        const progressLog: string[] = [];
        const seenSteps = new Set<string>();
        let lastUrl = '';
        let sawWorkingState = false;  // Track if we've seen task actually start

        const log = (msg: string) => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const line = `[comet ${elapsed}s] ${msg}`;
          console.error(line);  // stderr won't interfere with MCP protocol
          progressLog.push(line);
        };

        log('🚀 Task started');

        while (Date.now() - startTime < timeout) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Poll every 2s

          const status = await cometAI.getAgentStatus();

          // Log new steps we haven't seen
          for (const step of status.steps) {
            if (!seenSteps.has(step)) {
              seenSteps.add(step);
              log(`📋 ${step}`);
            }
          }

          // Log URL changes during agentic browsing
          if (status.agentBrowsingUrl && status.agentBrowsingUrl !== lastUrl) {
            lastUrl = status.agentBrowsingUrl;
            log(`🌐 ${lastUrl}`);
          }

          // Track if task has actually started (working state)
          if (status.status === 'working') {
            if (!sawWorkingState) {
              sawWorkingState = true;
              log('⚙️ Task processing...');
            }
            if (status.currentStep && !progressLog[progressLog.length - 1]?.includes(status.currentStep)) {
              log(`⏳ ${status.currentStep}`);
            }
          }

          // Only accept "completed" if we've seen the task actually start
          // This prevents returning stale responses from previous queries
          if (status.status === 'completed' && sawWorkingState) {
            log('✅ Task completed');
            let output = status.response || 'Task completed (no response text extracted)';
            return { content: [{ type: "text", text: output }] };
          }

          // If still showing "completed" but we haven't seen "working" yet,
          // it's the old response - wait for new task to start
          if (status.status === 'completed' && !sawWorkingState) {
            // Check if it's been too long without seeing working state (maybe simple query)
            const elapsed = Date.now() - startTime;
            if (elapsed > 10000) {
              // After 10s, if still showing completed, accept it
              log('✅ Task completed (quick response)');
              let output = status.response || 'Task completed (no response text extracted)';
              return { content: [{ type: "text", text: output }] };
            }
          }
        }

        // Timeout
        log('⏰ Timeout');
        return {
          content: [{
            type: "text",
            text: `Timeout after ${timeout/1000}s.\n\nProgress:\n${progressLog.join('\n')}\n\nUse comet_poll to check if still working.`,
          }],
        };
      }

      case "comet_poll": {
        const status = await cometAI.getAgentStatus();
        let output = `Status: ${status.status.toUpperCase()}\n`;

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.steps.length > 0) {
          output += `\nRecent steps:\n${status.steps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.currentStep && status.status === 'working') {
          output += `\nCurrent: ${status.currentStep}\n`;
        }

        if (status.status === 'completed' && status.response) {
          output += `\n--- Response ---\n${status.response}\n`;
        } else if (status.status === 'working' && status.hasStopButton) {
          output += `\n[Agent is working - use comet_stop to interrupt if needed]`;
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
        const agentTab = args?.agent_tab as boolean;

        if (agentTab) {
          // Try to capture the agent's browsing tab
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.agentBrowsing) {
            // Temporarily connect to agent tab, screenshot, reconnect to main
            const mainTab = tabs.main;
            await cometClient.connect(tabs.agentBrowsing.id);
            const result = await cometClient.screenshot("png");
            if (mainTab) {
              await cometClient.connect(mainTab.id);
            }
            return {
              content: [
                { type: "text", text: `Agent browsing: ${tabs.agentBrowsing.url}` },
                { type: "image", data: result.data, mimeType: "image/png" }
              ],
            };
          } else {
            return { content: [{ type: "text", text: "No agent browsing tab found" }] };
          }
        }

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
