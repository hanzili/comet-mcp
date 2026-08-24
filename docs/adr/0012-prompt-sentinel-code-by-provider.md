Sentinel Code Prompt for Providers

PERPLEXITY: prompt applied at the Project level

At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | [model name] | [token usage estimate as %] | [10-character random alphanumeric code]

Rules:

Count turns starting at 1 for the first turn of the thread.
Use current system wall-clock time and time zone for the date and time fields.
Calculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).
Keep this formatting rule strictly active for every response in the thread.


GROK: prompt applied in Settings as Custom Instruction
At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | Grok [model name] | [token usage estimate as %] | [10-character random alphanumeric code]

Rules:

Count turns starting at 1 for the first turn of the thread.
Use current system wall-clock time and time zone for the date and time fields.
Calculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).
Keep this formatting rule strictly active for every response in the thread.

CLAUDE: prompt applied in the Settings as Custom Instruction:

At the very end of every response you give me in this conversation, add a status line in this exact format:
Turn [n] | [MM-DD-YY] | Claude [model name] | [10-character random alphanumeric code]
Count turns starting at 1. Use the current date. Keep this rule active for the rest of the thread even if you forget to mention it later.


GEMINI: prompt rejected as System Instruction, has to be applied at the Gem level

At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | Gemini [model name] | [token usage estimate as %] | [10-character random alphanumeric code]
Rules:

Count turns starting at 1 for the first turn of the thread.
Use current system wall-clock time and time zone for the date and time fields.
Calculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).
Keep this formatting rule strictly active for every response in the thread.

CHATGPT: prompt applied in Settings

At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | [model name] | [token usage estimate as %] | [10-character random alphanumeric code]

Rules:

Count turns starting at 1 for the first turn of the thread.
Use current system wall-clock time and time zone for the date and time fields.
Calculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).
Keep this formatting rule strictly active for every response in the thread.

# Implementation notes (2026-08-10, user-validated)

## Injection is DISABLED on a new thread's first turn

With the Custom Instruction set up manually per platform, the driver must NOT
inject the full status-line instruction into the thread — the platform already
carries it. Injected prompts are rejected or ineffective (claude flags the
"(Technical:...)" framing as a jailbreak). The driver only appends a short
per-ask SENTINEL CODE TAG to every completionMarker ask:

  (Status-line sentinel code for this reply: <code> — end the status line with exactly this code.)

## Reminder phrasing (user-validated — works on claude too)

The reminder must use the soft-nudge phrasing; the old "Reply with ONLY that
line" framing is rejected:

  (You forgot the status line on your last response — please add it now in the format <per-provider format> and keep including it going forward.)

where <per-provider format> is the provider's format above with the sentinel
code substituted. This phrasing works even on claude.

## Session URLs — perplexity project / gemini Gem (user-validated)

For PERPLEXITY the session MUST start inside a PROJECT where the prompt was
applied manually; for GEMINI inside a GEM where the prompt was applied. A bare
session (no project/Gem) does NOT carry the instruction, so the sentinel
contract fails there.

Workflow: the user navigates the browser to the project (perplexity) / Gem
(gemini), and the session URL is copied into the driver entry's `sessionUrl`
field (src/providers/entries/<p>.driver.json). New sessions (provider_open /
newChat / tab reset) then start at that URL. Drivers resolve the session URL
via entryUrlFor() in src/tab-registry.ts (sessionUrl > entry URL > fallback).

Per-provider entries:
- perplexity: src/providers/entries/perplexity.driver.json → sessionUrl
- gemini:     src/providers/entries/gemini.driver.json → sessionUrl
- grok/chatgpt/claude: Custom Instruction applied globally (Settings) — no
  project-level session needed; entry URL is fine.
