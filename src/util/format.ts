// Pure helpers for error formatting. Extracted so tests can exercise them
// without spinning up the CDP client or MCP server.

const URL_PATTERN = /\b(https?:\/\/[^\s)]+|ws:\/\/[^\s)]+)/g;

/**
 * Replace http/https/ws URLs in a string with `[url]` to avoid leaking
 * session tokens, user-data paths, or other PII into surfaced error text.
 */
export function redactUrls(message: string): string {
  return message.replace(URL_PATTERN, '[url]');
}

const DEBUG_TRUE = new Set(['1', 'true', 'yes', 'on']);

/**
 * Returns true when the DEBUG env var is set to a truthy value.
 * Anything else (unset, empty, '0', 'false', 'no', 'off') is treated as
 * false. Used by the MCP catch handler to decide whether to surface
 * error.stack.
 */
export function isDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.DEBUG;
  if (!v) return false;
  return DEBUG_TRUE.has(v.toLowerCase());
}

export interface FormatErrorOptions {
  /** Max stack frames to include after the message. */
  stackLines?: number;
}

/**
 * Render an unknown caught error for the MCP error response. Redacts URLs
 * from the message and appends the leading stack frames only when DEBUG is
 * enabled.
 */
export function formatCaughtError(
  error: unknown,
  options: FormatErrorOptions & { debug: boolean } = { debug: false }
): string {
  const err = error as { message?: string; stack?: string };
  const baseMessage = err?.message ?? String(error);
  const safeMessage = redactUrls(baseMessage);
  const lines = options.stackLines ?? 6;
  if (options.debug && err?.stack) {
    const allLines = err.stack.split('\n');
    // V8 stacks start with "Error: <msg>\n  at frame1\n..." — skip the
    // redundant first line since `safeMessage` already carries the message.
    const startsWithErrorPrefix = /^\s*(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|[A-Z]\w*Error):/;
    const frames = allLines[0] && startsWithErrorPrefix.test(allLines[0])
      ? allLines.slice(1)
      : allLines;
    const head = frames.slice(0, lines).join('\n');
    return `${safeMessage}\n${head}`;
  }
  return safeMessage;
}
