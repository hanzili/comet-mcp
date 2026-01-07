// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";
import type { CometAIResponse } from "./types.js";

// Selectors for Perplexity/Comet AI interface
const SELECTORS = {
  // Input selectors - contenteditable div is primary for Perplexity
  input: [
    '[contenteditable="true"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Search"]',
    'textarea',
    'input[type="text"]',
  ],
  // Response/output selectors for Perplexity
  response: [
    '[class*="prose"]',
    'main article',
    '[data-testid*="answer"]',
    '[class*="answer"]',
    '[class*="response"]',
  ],
  // Loading indicator selectors
  loading: [
    '[class*="animate-pulse"]',
    '[class*="loading"]',
    '[class*="thinking"]',
    '.spinner',
  ],
  // Submit button selectors - Perplexity uses arrow button
  submit: [
    'button[aria-label*="Submit"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    'button svg[class*="arrow"]',
  ],
};

export class CometAI {
  private lastResponseText: string = "";

  /**
   * Find the first matching element from a list of selectors
   */
  async findElement(selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
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
   * Get information about Comet's AI interface
   */
  async inspectInterface(): Promise<{
    inputSelector: string | null;
    responseSelector: string | null;
    hasInput: boolean;
    pageInfo: string;
  }> {
    const inputSelector = await this.findElement(SELECTORS.input);
    const responseSelector = await this.findElement(SELECTORS.response);

    // Get general page info
    const pageInfoResult = await cometClient.evaluate(`
      JSON.stringify({
        url: window.location.href,
        title: document.title,
        textareas: document.querySelectorAll('textarea').length,
        inputs: document.querySelectorAll('input').length,
        contentEditables: document.querySelectorAll('[contenteditable="true"]').length,
        buttons: document.querySelectorAll('button').length,
      })
    `);

    return {
      inputSelector,
      responseSelector,
      hasInput: inputSelector !== null,
      pageInfo: pageInfoResult.result.value as string,
    };
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findElement(SELECTORS.input);

    if (!inputSelector) {
      throw new Error(
        "Could not find input element. Navigate to Perplexity first."
      );
    }

    // Use execCommand for contenteditable elements (works with React/Vue)
    const result = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el) {
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(prompt)});
          return { success: true, text: el.innerText };
        }
        // Fallback for textarea
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          textarea.value = ${JSON.stringify(prompt)};
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true, text: textarea.value };
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
   * Submit the current prompt - tries multiple strategies
   */
  private async submitPrompt(): Promise<void> {
    // Wait a moment for the UI to register the input
    await new Promise(resolve => setTimeout(resolve, 300));

    // Strategy 1: Use Enter key (most reliable for Perplexity)
    try {
      await cometClient.evaluate(`
        (() => {
          const el = document.querySelector('[contenteditable="true"]') ||
                     document.querySelector('textarea');
          if (el) el.focus();
        })()
      `);
      await cometClient.pressKey("Enter");
      await new Promise(resolve => setTimeout(resolve, 300));

      // Check if submission worked (input should be cleared or response started)
      const submitted = await cometClient.evaluate(`
        (() => {
          const el = document.querySelector('[contenteditable="true"]');
          if (el && el.innerText.trim().length < 5) return true;
          // Check if loading started
          const hasLoading = document.querySelector('[class*="animate"]') !== null;
          return hasLoading;
        })()
      `);
      if (submitted.result.value) return;
    } catch {
      // Continue to button click fallback
    }

    // Strategy 2: Try clicking the submit button with various selectors
    const clickResult = await cometClient.evaluate(`
      (() => {
        // Common submit button selectors for Perplexity
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
          // Perplexity specific - arrow button near input
          'button:has(svg path[d*="M12"])',  // Arrow icon paths often start with M12
          'button:has(svg[class*="arrow"])',
          'button:has(svg[class*="send"])',
        ];

        for (const sel of selectors) {
          try {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetParent !== null) {
              btn.click();
              return { clicked: true, selector: sel, method: 'direct' };
            }
          } catch (e) {
            // :has() might not be supported, continue
          }
        }

        // Strategy 2: Find the submit button - rightmost button with arrow/send icon
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
              const btnText = (btn.textContent || '').toLowerCase();

              // Skip: mode buttons, source/attach buttons, voice buttons
              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('mode') || ariaLabel.includes('source') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('add') ||
                  ariaLabel.includes('voice') || ariaLabel.includes('micro') ||
                  ariaLabel.includes('record') || btnText === '+') {
                continue;
              }

              // Must have SVG and be visible and to the right of input
              if (btn.querySelector('svg') && btn.offsetParent !== null &&
                  btnRect.left > inputRect.left && btnRect.width > 0) {
                candidates.push({ btn, right: btnRect.right });
              }
            }
            parent = parent.parentElement;
          }

          // Click the rightmost candidate (submit is usually rightmost)
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.right - a.right);
            candidates[0].btn.click();
            return { clicked: true, selector: 'rightmost-button', method: 'traversal' };
          }
        }

        return { clicked: false };
      })()
    `);

    const clicked = (clickResult.result.value as { clicked: boolean; method?: string })?.clicked;

    if (clicked) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // If nothing worked, Enter key was already tried first - we've done what we can
  }

  /**
   * Check if Comet AI is currently processing/loading
   */
  async isLoading(): Promise<boolean> {
    const loadingSelector = await this.findElement(SELECTORS.loading);
    return loadingSelector !== null;
  }

  /**
   * Wait for Comet AI to finish responding
   */
  async waitForResponse(timeout: number = 30000): Promise<CometAIResponse> {
    const startTime = Date.now();
    let lastText = "";
    let stableCount = 0;

    // Wait for page to start loading response
    await new Promise(resolve => setTimeout(resolve, 2000));

    while (Date.now() - startTime < timeout) {
      // Get response text from Perplexity's answer area
      const result = await cometClient.evaluate(`
        (() => {
          // Look for the main answer content
          const proseEl = document.querySelector('[class*="prose"]');
          if (proseEl) return proseEl.innerText;

          // Alternative: look for answer section
          const mainText = document.body.innerText;
          const answerMatch = mainText.match(/Reviewed \\d+ sources[\\s\\S]*?(?=Related|Ask a follow-up|$)/);
          if (answerMatch) return answerMatch[0];

          return "";
        })()
      `);

      const currentText = (result.result.value as string) || "";

      // Check if response has stabilized (text same for 3 consecutive checks)
      if (currentText.length > 10 && currentText === lastText) {
        stableCount++;
        if (stableCount >= 3) {
          this.lastResponseText = currentText;
          return {
            text: currentText,
            complete: true,
            timestamp: Date.now(),
          };
        }
      } else {
        stableCount = 0;
      }

      lastText = currentText;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Timeout - return whatever we have
    return {
      text: lastText || "No response detected within timeout",
      complete: false,
      timestamp: Date.now(),
    };
  }

  /**
   * Send prompt and wait for response
   */
  async ask(prompt: string, timeout: number = 30000): Promise<CometAIResponse> {
    await this.sendPrompt(prompt);

    // Wait a bit for the response to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    return this.waitForResponse(timeout);
  }

  /**
   * Get the current visible response text
   */
  async getCurrentResponse(): Promise<string> {
    const responseSelector = await this.findElement(SELECTORS.response);

    if (!responseSelector) {
      // Try to get any visible text that looks like a response
      const result = await cometClient.evaluate(`
        // Look for the main content area
        const contentAreas = document.querySelectorAll('main, article, [role="main"], .content');
        for (const area of contentAreas) {
          if (area.innerText.length > 100) {
            return area.innerText;
          }
        }
        return document.body.innerText.substring(0, 5000);
      `);
      return result.result.value as string;
    }

    const result = await cometClient.evaluate(`
      document.querySelector(${JSON.stringify(responseSelector)})?.innerText || ""
    `);
    return result.result.value as string;
  }

  /**
   * Clear the current conversation/input
   */
  async clearConversation(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (function() {
        const clearButtons = document.querySelectorAll(
          'button[aria-label*="Clear"], button[aria-label*="New"], [class*="clear"], [class*="new-chat"]'
        );
        for (const btn of clearButtons) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }

  /**
   * Get current agent status and progress (for polling)
   * Gets fresh data each time, extracts URL from actual browsing tab
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
  }> {
    // Get the actual browsing URL from the agent's tab (not from text parsing)
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    // Get status from the current Perplexity page
    const result = await cometClient.safeEvaluate(`
      (() => {
        // Force fresh read
        const body = document.body.innerText;

        // Check for ACTIVE stop button - multiple detection methods
        let hasActiveStopButton = false;
        const stopButtons = document.querySelectorAll('button');
        for (const btn of stopButtons) {
          const rect = btn.querySelector('rect'); // Square icon
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if ((rect || ariaLabel.includes('stop')) &&
              btn.offsetParent !== null && !btn.disabled) {
            hasActiveStopButton = true;
            break;
          }
        }

        // Check for animated loading indicators
        const hasLoadingSpinner = document.querySelector('[class*="animate-spin"], [class*="animate-pulse"], .spinner') !== null;

        // Check for completion indicators
        const stepsCompletedMatch = body.match(/(\\d+) steps? completed/i);
        const hasStepsCompleted = stepsCompletedMatch !== null;

        // Check for "Finished" or "Reviewed N sources"
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);

        // Working indicators
        const workingPatterns = [
          'Working…', 'Working...', 'Searching', 'Reviewing sources',
          'Preparing to assist', 'Clicking', 'Typing:', 'Navigating to',
          'Reading', 'Analyzing'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Status determination
        let status = 'idle';
        if (hasActiveStopButton || hasLoadingSpinner) {
          status = 'working';
        } else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasReviewedSources && !hasWorkingText) {
          status = 'completed';
        } else if (hasWorkingText) {
          status = 'working';
        }

        // Extract agent steps
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g,
          /Clicking[^\\n]*/g,
          /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g,
          /Reading[^\\n]*/g,
          /Searching[^\\n]*/g,
          /Found[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) {
            steps.push(...matches.map(s => s.trim().substring(0, 100)));
          }
        }

        const currentStep = steps.length > 0 ? steps[steps.length - 1] : '';

        // Extract response for completed status
        let response = '';
        if (status === 'completed') {
          // Strategy 1: Look for prose elements (main answer content)
          // Take the LAST one - most recent answer in conversation
          const proseEls = document.querySelectorAll('[class*="prose"]');
          for (let i = proseEls.length - 1; i >= 0; i--) {
            const text = proseEls[i].innerText.trim();
            if (text.length > 5 && !text.startsWith('Related')) {
              response = text;
              break;
            }
          }

          // Strategy 2: Look for answer section by structure
          if (!response) {
            // Find the main content area after "Reviewed X sources"
            const reviewedMatch = body.match(/Reviewed \\d+ sources?/);
            if (reviewedMatch) {
              const startIdx = body.indexOf(reviewedMatch[0]) + reviewedMatch[0].length;
              const endMarkers = ['Related', 'Ask a follow-up', 'Ask anything', 'Share', 'Copy'];
              let endIdx = body.length;
              for (const marker of endMarkers) {
                const idx = body.indexOf(marker, startIdx);
                if (idx > startIdx && idx < endIdx) endIdx = idx;
              }
              response = body.substring(startIdx, endIdx).trim();
            }
          }

          // Strategy 3: Fallback - extract after completion marker
          if (!response || response.length < 5) {
            const completionIdx = body.indexOf('steps completed');
            if (completionIdx > -1) {
              const afterCompletion = body.substring(completionIdx + 15);
              const endMarkers = ['Related', 'Ask a follow-up', 'Ask anything', 'Sources'];
              let endIdx = afterCompletion.length;
              for (const marker of endMarkers) {
                const idx = afterCompletion.indexOf(marker);
                if (idx > 0 && idx < endIdx) endIdx = idx;
              }
              response = afterCompletion.substring(0, endIdx).trim();
            }
          }
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep,
          response: response.substring(0, 3000),
          hasStopButton: hasActiveStopButton
        };
      })()
    `);

    const evalResult = result.result.value as {
      status: "idle" | "working" | "completed";
      steps: string[];
      currentStep: string;
      response: string;
      hasStopButton: boolean;
    };

    return {
      ...evalResult,
      agentBrowsingUrl, // From actual tab, not text parsing
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try to find and click stop/cancel button
        const stopButtons = document.querySelectorAll(
          'button[aria-label*="Stop"], button[aria-label*="Cancel"], button[aria-label*="Pause"]'
        );
        for (const btn of stopButtons) {
          btn.click();
          return true;
        }

        // Try finding a square stop icon button
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.querySelector('svg rect, svg[class*="stop"]')) {
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
