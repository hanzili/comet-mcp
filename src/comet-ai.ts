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
  // Track step counts for stale detection (Bug 3)
  private lastStepCount: number = 0;
  private lastStepChangeTime: number = Date.now();
  /**
   * Find the first matching element from a list of selectors
   */
  private async findInputElement(): Promise<string | null> {
    for (const selector of INPUT_SELECTORS) {
      const result = await cometClient.safeEvaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  /**
   * Wait until the input element is fully hydrated and functional.
   * Polls by test-typing a character, verifying it appeared, then clearing.
   */
  async waitForInputReady(maxWaitMs: number = 10000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      const ready = await cometClient.safeEvaluate(`
        (() => {
          const el = document.querySelector('[contenteditable="true"]');
          if (!el) return false;
          el.click();
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, '\\u200B');
          const hasText = el.innerText.includes('\\u200B');
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          return hasText;
        })()
      `);
      if (ready.result.value === true) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error("Input not ready after timeout - React may not have hydrated");
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   * Includes retry logic for when execCommand silently fails during hydration.
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findInputElement();

    if (!inputSelector) {
      throw new Error("Could not find input element. Navigate to Perplexity first.");
    }

    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Click and focus to activate React handlers, then type
      await cometClient.safeEvaluate(`
        (() => {
          const el = document.querySelector('[contenteditable="true"]');
          if (el) {
            el.click();
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, ${JSON.stringify(prompt)});
            return { success: true };
          }
          const textarea = document.querySelector('textarea');
          if (textarea) {
            textarea.click();
            textarea.focus();
            textarea.value = ${JSON.stringify(prompt)};
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            return { success: true };
          }
          return { success: false };
        })()
      `);

      // Verify the text actually appeared in the input
      await new Promise(resolve => setTimeout(resolve, 200));
      const verifyResult = await cometClient.safeEvaluate(`
        (() => {
          const el = document.querySelector('[contenteditable="true"]');
          if (el && el.innerText.trim().length > 0) return el.innerText.trim();
          const textarea = document.querySelector('textarea');
          if (textarea && textarea.value.trim().length > 0) return textarea.value.trim();
          return '';
        })()
      `);

      const typedText = verifyResult.result.value as string;
      if (typedText && typedText.length > 0) {
        // Text was typed successfully — submit
        await this.submitPrompt();
        return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
      }

      // Text didn't appear — clear and retry
      if (attempt < MAX_RETRIES - 1) {
        await cometClient.safeEvaluate(`
          (() => {
            const el = document.querySelector('[contenteditable="true"]');
            if (el) {
              el.focus();
              document.execCommand('selectAll', false, null);
              document.execCommand('delete', false, null);
            }
          })()
        `);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    throw new Error("Failed to type into input after " + MAX_RETRIES + " retries - typing may have failed");
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(): Promise<void> {
    // Wait for React to process the typed content
    await new Promise(resolve => setTimeout(resolve, 500));

    // Verify text was typed before attempting submit
    const hasContent = await cometClient.safeEvaluate(`
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
    await cometClient.safeEvaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]') ||
                   document.querySelector('textarea');
        if (el) el.focus();
      })()
    `);
    await cometClient.pressKey("Enter");
    await new Promise(resolve => setTimeout(resolve, 500));

    // Check if submission worked
    const submitted = await cometClient.safeEvaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el && el.innerText.trim().length < 5) return true;
        const hasLoading = document.querySelector('[class*="animate"]') !== null;
        return hasLoading;
      })()
    `);
    if (submitted.result.value) return;

    // Strategy 2: Click submit button
    await cometClient.safeEvaluate(`
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
    const finalCheck = await cometClient.safeEvaluate(`
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

        // Check for active stop button (tightened detection)
        let hasActiveStopButton = false;
        for (const btn of document.querySelectorAll('button')) {
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

          // Skip known non-stop buttons
          if (ariaLabel.includes('copy') || ariaLabel.includes('share') ||
              ariaLabel.includes('like') || ariaLabel.includes('dislike') ||
              ariaLabel.includes('source') || ariaLabel.includes('download')) continue;

          // Primary: aria-label explicitly says stop
          if (ariaLabel.includes('stop') && btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }

          // Secondary: square icon (sharp-cornered rect) near input area
          const rect = btn.querySelector('rect:not([rx])');
          if (rect && btn.offsetParent !== null && !btn.disabled) {
            const btnRect = btn.getBoundingClientRect();
            // Only count if in the lower 25% of viewport (near input)
            if (btnRect.top > window.innerHeight * 0.75) {
              hasActiveStopButton = true;
              break;
            }
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

        // Check working patterns only OUTSIDE prose elements
        const workingPatterns = [
          'Working', 'Searching', 'Reviewing sources', 'Preparing to assist',
          'Clicking', 'Typing:', 'Navigating to', 'Reading', 'Analyzing'
        ];
        const proseEls = new Set([...document.querySelectorAll('[class*="prose"]')]);
        let hasWorkingText = false;
        for (const el of document.querySelectorAll('div, span, p')) {
          // Skip if inside a prose element (completed response content)
          let insideProse = false;
          let parent = el;
          while (parent) {
            if (proseEls.has(parent)) { insideProse = true; break; }
            parent = parent.parentElement;
          }
          if (insideProse) continue;

          const text = el.innerText || '';
          if (workingPatterns.some(p => text.includes(p))) {
            hasWorkingText = true;
            break;
          }
        }

        // Determine status — PRIORITY ORDER MATTERS
        let status = 'idle';

        // HIGHEST PRIORITY: "Ask a follow-up" is the definitive completion signal
        if (hasAskFollowUp && hasProseContent && !hasActiveStopButton) {
          status = 'completed';
        }
        // Active stop button or loading spinner = still working
        else if (hasActiveStopButton || hasLoadingSpinner) {
          status = 'working';
        }
        // Step completion markers
        else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        }
        else if (hasReviewedSources && !hasWorkingText) {
          status = 'completed';
        }
        // Working text (only outside prose)
        else if (hasWorkingText) {
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
            response = validProseTexts[validProseTexts.length - 1];
          }

          // Clean up response
          if (response) {
            response = response.replace(/View All|Show more|Ask a follow-up|\\d+ sources?/gi, '').trim();
            response = response.replace(/\\s+/g, ' ').trim();
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep: steps.length > 0 ? steps[steps.length - 1] : '',
          response: response.substring(0, 8000),
          hasStopButton: hasActiveStopButton,
          hasAskFollowUp
        };
      })()
    `);

    const evalResult = result.result.value as {
      status: "idle" | "working" | "completed";
      steps: string[];
      currentStep: string;
      response: string;
      hasStopButton: boolean;
      hasAskFollowUp: boolean;
    };

    // Step stale detection: if steps haven't changed in 30s and completion signals are present, override to completed
    if (evalResult.steps.length !== this.lastStepCount) {
      this.lastStepCount = evalResult.steps.length;
      this.lastStepChangeTime = Date.now();
    }
    const staleMs = Date.now() - this.lastStepChangeTime;
    if (evalResult.status === 'working' && staleMs > 30000 && evalResult.hasAskFollowUp) {
      evalResult.status = 'completed';
    }

    // Post-evaluation override: if no agent tabs and completion signals, mark completed
    if (evalResult.status === 'working' && !agentBrowsingUrl) {
      if (evalResult.hasAskFollowUp) {
        evalResult.status = 'completed';
      }
    }

    return {
      status: evalResult.status,
      steps: evalResult.steps,
      currentStep: evalResult.currentStep,
      response: evalResult.response,
      hasStopButton: evalResult.hasStopButton,
      agentBrowsingUrl,
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.safeEvaluate(`
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
