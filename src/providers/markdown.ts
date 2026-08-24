/**
 * HTML → Markdown extraction (P2) — the markdown extraction strategy decision,
 * implementing the handoff doc's option (b): "capture innerHTML and convert via the
 * `turndown` library in ordinary Node code (lower risk, plus custom handling for
 * Perplexity's non-semantic citation-badge elements)."
 *
 * This is provider-neutral by design: every driver captures the response container's
 * innerHTML; this module converts it. Provider-specific cleanup runs BEFORE conversion:
 *  - perplexity: drop citation-badge <sup>/<a class="citation"> elements and UI residue
 *  - grok: drop the "Working for Xs"/"Worked for Xs" timing line
 *
 * The text (innerText) path stays as the primary `response`; `markdown` is an
 * additional field on PollResult — no breaking change to existing consumers.
 */

import TurndownService from 'turndown';

let service: TurndownService | null = null;

/** Lazy singleton — turndown is stateless per conversion. */
function getService(): TurndownService {
  if (!service) {
    service = new TurndownService({
      headingStyle: 'atx',        // ## Heading
      codeBlockStyle: 'fenced',   // ```code```
      emDelimiter: '*',
      strongDelimiter: '**',
      bulletListMarker: '-',
    });
    // preserve code inside pre blocks without turndown's default indentation quirk
    service.addRule('codeBlock', {
      filter: ['pre'],
      replacement: (_content: string, node: any) => {
        const code = node.textContent || '';
        return '\n```\n' + code.replace(/\n$/, '') + '\n```\n';
      },
    });
  }
  return service;
}

/** Provider-specific HTML pre-cleanup. */
function preClean(provider: string, html: string): string {
  switch (provider) {
    case 'perplexity':
      // citation badges: sup/nested links carrying source numbers, and UI residue
      return html
        .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
        .replace(/<a[^>]*class="[^"]*citation[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '');
    case 'grok':
      // timing line Grok renders inside the message (handled in text path too)
      return html;
    case 'gemini':
      // Gemini disclaimer + citation card residue inside model-response
      return html
        .replace(/<div[^>]*class="[^"]*disclaimer[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
        .replace(/<div[^>]*class="[^"]*citation[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    case 'chatgpt':
      // ChatGPT citation/source chips + copy buttons inside the assistant turn
      return html
        .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '')
        .replace(/<div[^>]*class="[^"]*citation[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '');
    case 'claude':
      // Claude copy/feedback UI inside font-claude-response
      return html.replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '');
    default:
      return html;
  }
}

/**
 * Convert a response container's innerHTML to Markdown.
 * Returns null when there's nothing convertible.
 */
export function htmlToMarkdown(provider: string, html: string): string | null {
  if (!html || !html.trim()) return null;
  const cleaned = preClean(provider, html);
  const md = getService().turndown(cleaned).trim();
  return md.length > 0 ? md : null;
}
