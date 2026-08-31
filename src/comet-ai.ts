// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";

// Input selectors - contenteditable div is primary for Perplexity
const INPUT_SELECTORS = [
  '[contenteditable="true"]',
  'textarea[placeholder*="Ask"]',
  'textarea[placeholder*="Search"]',
  'textarea',
  'input[type="text"]',
];

export class CometAI {
  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await cometClient.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    // Use execCommand for contenteditable elements (works with React/Vue)
    const result = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el) {
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(prompt)});
          return { success: true };
        }
        // Fallback for textarea
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          textarea.value = ${JSON.stringify(prompt)};
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true };
        }
        return { success: false };
      })()
    `);

    const typed = (result.result.value as { success: boolean })?.success;
    if (!typed) {
      throw new Error("Failed to type into input element");
    }

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(): Promise<void> {
    // Wait for React to process the typed content
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify text was typed before attempting submit
    const hasContent = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length > 0) return true;
        const textarea = document.querySelector('textarea');
        if (textarea && textarea.value.trim().length > 0) return true;
        return false;
      })()
    `);

    if (!hasContent.result.value) {
      throw new Error("Prompt text not found in input - typing may have failed");
    }

    // Strategy 1: Use Enter key (most reliable for Perplexity)
    await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (el) el.focus();
      })()
    `);
    await cometClient.pressKey("Enter");
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if submission worked
    const submitted = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        return hasLoading;
      })()
    `);
    if (submitted.result.value) return;

    // Strategy 2: Click submit button
    await cometClient.evaluate(`
      (() => {
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
        ];

        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn && !btn.disabled && btn.offsetParent !== null) {
            btn.click();
            return true;
          }
        }

        // Find rightmost button with SVG near input
        const inputEl = document.querySelector('[contenteditable="true"]') ||
                        document.querySelector('textarea');
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          let parent = inputEl.parentElement;
          let candidates = [];

          for (let i = 0; i < 4 && parent; i++) {
            const btns = parent.querySelectorAll('button:not([disabled])');
            for (const btn of btns) {
              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

              // Skip mode/attach/voice buttons
              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('voice')) {
                continue;
              }

              if (btn.querySelector('svg') && btn.offsetParent !== null &&
                  btnRect.left > inputRect.left && btnRect.width > 0) {
                candidates.push({ btn, right: btnRect.right });
              }
            }
            parent = parent.parentElement;
          }

          if (candidates.length > 0) {
            candidates.sort((a, b) => b.right - a.right);
            candidates[0].btn.click();
          }
        }
      })()
    `);

    // Final check and retry with Enter if still not submitted
    await new Promise(resolve => setTimeout(resolve, 500));
    const finalCheck = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        const hasProseContent = document.querySelectorAll('[class*="prose"]').length > 0;
        return hasLoading || hasProseContent;
      })()
    `);

    if (!finalCheck.result.value) {
      // Last resort: try Enter one more time
      await cometClient.pressKey("Enter");
    }
  }

  /**
   * Get current agent status and progress (for polling)
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
  }> {
    // Get browsing URL from agent's tab
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        // Check for active stop button
        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          const rect = btn.querySelector('rect');
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if ((rect || ariaLabel.includes('stop')) &&
              btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }
        }

        const hasLoadingSpinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"]') !== null;
        const hasStepsCompleted = /\\d+ steps? completed/i.test(body);
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);
        const hasAskFollowUp = body.includes('Ask a follow-up');
        const hasProseContent = [...document.querySelectorAll('[class*="prose"]')].some(
          el => el.innerText.trim().length > 0
        );

        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Determine status
        let status = 'idle';
        if (hasActiveStopButton || hasLoadingSpinner) {
          status = 'working';
        } else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasAskFollowUp && hasProseContent && !hasActiveStopButton) {
          // "Ask a follow-up" UI only appears when the answer finished streaming —
          // must win over hasWorkingText (the answer text itself often contains
          // words like "Working" / "Analyzing" / "Searching").
          status = 'completed';
        } else if (hasReviewedSources && !hasWorkingText && hasAskFollowUp) {
          status = 'completed';
        } else if (hasWorkingText) {
          status = 'working';
        }

        // Extract steps
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g, /Clicking[^\\n]*/g, /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g, /Reading[^\\n]*/g, /Searching[^\\n]*/g, /Found[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) steps.push(...matches.map(s => s.trim().substring(0, 100)));
        }

        // Extract response
        let response = '';
        if (status === 'completed') {
          const mainContent = document.querySelector('main') || document.body;
          const allProseEls = mainContent.querySelectorAll('[class*="prose"]');
          const validProseTexts = [];

          for (const el of allProseEls) {
            if (el.closest('nav, aside, header, footer, form')) continue;

            const text = el.innerText.trim();
            const isUIText = ['Library', 'Discover', 'Spaces', 'Finance', 'Account',
                              'Upgrade', 'Home', 'Search', 'Ask a follow-up'].some(ui => text.startsWith(ui));
            if (isUIText) continue;
            if (text.endsWith('?') && text.length < 100) continue;
            if (text.length > 5) validProseTexts.push(text);
          }

          if (validProseTexts.length > 0) {
            // Perplexity splits one answer across many [class*="prose"] elements
            // AND nests them (innerText includes descendants). Joining every
            // element repeats content; taking only the last truncates to the
            // tail fragment. Dedupe by containment: keep an element's text only
            // if it is not fully contained within a longer prose block.
            const seen = new Set();
            const unique = validProseTexts.filter(t => seen.has(t) ? false : (seen.add(t), true));
            response = unique.filter(t => !unique.some(u => u.length > t.length && u.includes(t))).join('\\n\\n');
          }

          // Clean up response
          if (response) {
            response = response.replace(/View All|Show more|Ask a follow-up|\\d+ sources?/gi, '').trim();
            // Collapse only horizontal whitespace; preserve paragraph breaks (the
            // joined prose blocks must keep their newlines — flattening \\s+ to a
            // single space would undo the multi-block join).
            response = response.replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          // Keep the NEWEST content: Perplexity keeps all prior turns in the DOM,
          // so the joined prose is oldest→newest. Slicing from the start would
          // return stale earlier turns and can drop the current answer entirely
          // (Bug #2 regression fixed 2026-08-06: substring(0,N) → slice(-N)).
          response: response.slice(-30000),
          hasStopButton: hasActiveStopButton
        };
      })()
    `);

    // Harden: the CDP evaluate may return no value (dead tab, extension page,
    // navigate race, closed browser). Spread defaults so callers never crash
    // on undefined status/steps/response (e.g. comet_poll's .toUpperCase()).
    const value = (result?.result?.value ?? {}) as {
      status?: "idle" | "working" | "completed";
      steps?: string[];
      currentStep?: string;
      response?: string;
      hasStopButton?: boolean;
    };

    return {
      status: value.status ?? "idle",
      steps: value.steps ?? [],
      currentStep: value.currentStep ?? "",
      response: value.response ?? "",
      hasStopButton: value.hasStopButton ?? false,
      agentBrowsingUrl,
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try aria-label buttons first
        for (const btn of document.querySelectorAll('button[aria-label*="Stop"], button[aria-label*="Cancel"]')) {
          btn.click();
          return true;
        }
        // Try square stop icon
        for (const btn of document.querySelectorAll('button')) {
          if (btn.querySelector('svg rect')) {
            btn.click();
            return true;
          }
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }
}

export const cometAI = new CometAI();
