/**
 * Claude.ai ChatDriver (P6) — entry-driven via BaseChatDriver.
 *
 * All behavior lives in the entry's driver section
 * (src/providers/entries/claude.driver.json, merged at load):
 *  - composer: TipTap/ProseMirror contenteditable [data-testid="chat-input"]
 *    → insertText;
 *  - submit: **click-after-type** — button[aria-label="Send message"] appears
 *    ONLY after typing; Enter alone does NOT submit (774e875) → enterSends: false,
 *    the ladder never presses Enter for claude;
 *  - freshChatByNavigation: /recents has no composer → reset navigates
 *    https://claude.ai/new (driver.reset.method: navigate);
 *  - signals: stop/cancel control working, stop-absent completed, sign-in/expiry
 *    wall → login;
 *  - response container div.font-claude-response is conditional — empty-state
 *    idle absence is NOT drift (entry marks it conditional; health skips it).
 *
 * Discovery inventory: src/providers/entries/claude.json (HIGH, 2026-08-07).
 */

import { BaseChatDriver } from './base.js';

export class ClaudeDriver extends BaseChatDriver {
  readonly provider = 'claude' as const;
}

export const claudeDriver = new ClaudeDriver();
