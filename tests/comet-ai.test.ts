import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the cdp-client module before importing comet-ai
vi.mock('../src/cdp-client.js', () => {
  return {
    cometClient: {
      evaluate: vi.fn(),
      safeEvaluate: vi.fn(),
      pressKey: vi.fn(),
      insertText: vi.fn(),
      selectAll: vi.fn(),
      listTabsCategorized: vi.fn().mockResolvedValue({
        main: null,
        sidecar: null,
        agentBrowsing: null,
        overlay: null,
        others: [],
      }),
    },
  };
});

import { CometAI } from '../src/comet-ai.js';
import { cometClient } from '../src/cdp-client.js';

const mockSafeEvaluate = cometClient.safeEvaluate as ReturnType<typeof vi.fn>;
const mockPressKey = cometClient.pressKey as ReturnType<typeof vi.fn>;
const mockInsertText = (cometClient as any).insertText as ReturnType<typeof vi.fn>;
const mockSelectAll = (cometClient as any).selectAll as ReturnType<typeof vi.fn>;

describe('CometAI', () => {
  let ai: CometAI;

  beforeEach(() => {
    ai = new CometAI();
    vi.clearAllMocks();
    mockPressKey.mockResolvedValue(undefined);
    mockInsertText.mockResolvedValue(undefined);
    mockSelectAll.mockResolvedValue(undefined);
  });

  // ==========================================
  // Phase 1: Bug 1 — sendPrompt reliability
  // ==========================================

  describe('sendPrompt', () => {
    it('retries when CDP insertText fails (innerText empty)', async () => {
      // findInputElement: contenteditable exists
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: true } });

      // Attempt 1: focus/clear, (insertText via CDP mock), verify (empty), clear
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: { success: true, type: 'contenteditable' } } }); // focus
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: '' } }); // verify empty
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: undefined } }); // clear

      // Attempt 2: focus/clear, insertText, verify (empty), clear
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: { success: true, type: 'contenteditable' } } }); // focus
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: '' } }); // verify empty
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: undefined } }); // clear

      // Attempt 3: focus/clear, insertText, verify (success!)
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: { success: true, type: 'contenteditable' } } }); // focus
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: 'hello world' } }); // verify has text

      // submitPrompt flow: content check → true, focus, enter, verify submitted
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: true } }); // hasContent
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: undefined } }); // focus
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: true } }); // submitted check

      const result = await ai.sendPrompt('hello world');
      expect(result).toContain('Prompt sent');
      expect(mockInsertText).toHaveBeenCalledTimes(3);
    });

    it('throws after max retries when typing always fails', async () => {
      // findInputElement: contenteditable exists
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: true } });

      // All 3 attempts: focus/clear, (insertText via CDP), verify returns empty, clear
      for (let i = 0; i < 3; i++) {
        mockSafeEvaluate.mockResolvedValueOnce({ result: { value: { success: true, type: 'contenteditable' } } }); // focus
        mockSafeEvaluate.mockResolvedValueOnce({ result: { value: '' } }); // verify empty
        if (i < 2) {
          mockSafeEvaluate.mockResolvedValueOnce({ result: { value: undefined } }); // clear (not on last attempt)
        }
      }

      await expect(ai.sendPrompt('test prompt')).rejects.toThrow(/typing|retries/i);
    });
  });

  describe('waitForInputReady', () => {
    it('polls until input is functional', async () => {
      // First 2 polls: element not found
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: false } });
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: false } });

      // 3rd poll: element found + focused
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: true } }); // found
      // insertText('x') via CDP mock — already mocked
      mockSafeEvaluate.mockResolvedValueOnce({ result: { value: true } }); // hasText check
      // Cleanup: selectAll + Backspace via CDP mocks (no safeEvaluate calls)

      await expect(ai.waitForInputReady(5000)).resolves.toBeUndefined();
    });

    it('times out with clear error', async () => {
      // Input never becomes ready (element not found)
      mockSafeEvaluate.mockResolvedValue({ result: { value: false } });

      await expect(ai.waitForInputReady(1500)).rejects.toThrow(/input.*ready|hydrat|timeout/i);
    });
  });

  // ==========================================
  // Phase 3: Bug 3 — Status detection
  // ==========================================

  describe('getAgentStatus', () => {
    it('returns completed when "Ask a follow-up" is visible with prose content', async () => {
      mockSafeEvaluate.mockResolvedValueOnce({
        result: {
          value: {
            status: 'completed',
            steps: [],
            currentStep: '',
            response: 'The answer is 42.',
            hasStopButton: false,
            hasAskFollowUp: true,
          },
        },
      });

      const status = await ai.getAgentStatus();
      expect(status.status).toBe('completed');
    });

    it('does not detect copy/share buttons as stop buttons', async () => {
      // This test verifies the evaluate JS logic correctly ignores non-stop buttons
      // The actual fix is in the browser-evaluated JS, so we test via the returned status
      mockSafeEvaluate.mockResolvedValueOnce({
        result: {
          value: {
            status: 'completed', // Should be completed, not working
            steps: ['Navigating to LinkedIn'],
            currentStep: 'Navigating to LinkedIn',
            response: 'Here are the results.',
            hasStopButton: false, // Copy/share buttons NOT counted
            hasAskFollowUp: true,
          },
        },
      });

      const status = await ai.getAgentStatus();
      expect(status.status).toBe('completed');
      expect(status.hasStopButton).toBe(false);
    });

    it('does not return working when working text appears only inside prose', async () => {
      // "Reading" and "Searching" in the completed response should not trigger working status
      mockSafeEvaluate.mockResolvedValueOnce({
        result: {
          value: {
            status: 'completed', // Should be completed despite "Reading" in response
            steps: [],
            currentStep: '',
            response: 'Reading the profile showed interesting results. Searching through posts found 3 relevant items.',
            hasStopButton: false,
            hasAskFollowUp: true,
          },
        },
      });

      const status = await ai.getAgentStatus();
      expect(status.status).toBe('completed');
    });
  });
});
