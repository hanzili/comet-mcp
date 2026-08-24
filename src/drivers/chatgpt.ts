/**
 * ChatGPT ChatDriver (P6) — entry-driven via BaseChatDriver.
 *
 * All behavior lives in the entry's driver section
 * (src/providers/entries/chatgpt.driver.json, merged at load):
 *  - composer: textarea[name="prompt-textarea"] → value-input;
 *  - submit: click #composer-submit-button[data-testid="send-button"] (conditional,
 *    appears after text), Enter works, verify composer-emptied;
 *  - signals: stop-control working (re-resolved every poll — never cached),
 *    stop-absent completed, sign-in → login, CAPTCHA/rate-limit → blocked;
 *  - messageId: data-message-id on the assistant turn (secondary anchor —
 *    contentHash remains the durable reconnect-dedup key);
 *  - markdown: 'chatgpt' preClean variant (button/citation chip stripping).
 *
 * Discovery inventory: src/providers/entries/chatgpt.json (HIGH, 2026-08-07).
 */

import { BaseChatDriver } from './base.js';

export class ChatGPTDriver extends BaseChatDriver {
  readonly provider = 'chatgpt' as const;
}

export const chatgptDriver = new ChatGPTDriver();
