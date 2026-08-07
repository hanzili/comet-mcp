// MCP Apps widget layer.
//
// Implements the server side of the MCP Apps spec (2026-01-26) for comet-mcp:
// - resources/list advertises `ui://comet-mcp/progress.html`
// - resources/read returns the widget HTML, parameterised with the task id
//   and current status via query string.
// - The HTML widget itself lives at src/mcp/widgets/progress.html and is
//   loaded at module init via readFileSync.
//
// Design note: we keep the widget purely client-side. It uses postMessage to
// ask the host for status updates, but degrades gracefully when the host
// doesn't support that protocol yet (most clients in 2026 won't, since
// MCP Apps is recent). The static status from the query string is enough
// for a useful first cut.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WIDGET_URI = 'ui://comet-mcp/progress.html';
const WIDGET_MIME = 'text/html;profile=mcp-app';

interface ReadResourceResult {
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
}

interface ListResourcesResult {
  resources: Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }>;
}

let cachedHtml: string | null = null;

/**
 * Resolve the widget HTML file. Try a few candidate locations because the
 * module's `import.meta.url` differs between source tree (vitest) and the
 * tsc-emitted `dist/` directory. We also fall back to `process.cwd()`-relative
 * paths so tests run from the repo root still find the file.
 */
function resolveWidgetPath(): string | null {
  const candidates: string[] = [];

  // 1. Relative to this module's URL (works when tsc emits into dist/mcp/widgets.js).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, 'widgets', 'progress.html'));
    candidates.push(join(here, '..', 'mcp', 'widgets', 'progress.html'));
    candidates.push(join(here, '..', '..', 'src', 'mcp', 'widgets', 'progress.html'));
  } catch { /* import.meta.url may not be available everywhere */ }

  // 2. Relative to process.cwd() — tests usually run from repo root.
  const cwd = process.cwd();
  candidates.push(join(cwd, 'src', 'mcp', 'widgets', 'progress.html'));
  candidates.push(join(cwd, 'dist', 'mcp', 'widgets', 'progress.html'));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function loadWidgetHtml(): string {
  if (cachedHtml !== null) return cachedHtml;
  const path = resolveWidgetPath();
  if (path) {
    cachedHtml = readFileSync(path, 'utf8');
  } else {
    cachedHtml = FALLBACK_WIDGET_HTML;
  }
  return cachedHtml;
}

const FALLBACK_WIDGET_HTML = `<!DOCTYPE html><html><head>
<script>document.documentURI = "${WIDGET_URI}?taskId=unknown&status=working";</script>
</head><body>
<p>comet-mcp progress widget missing — src/mcp/widgets/progress.html not found.</p>
<p>The widget is served at <code>${WIDGET_URI}</code>; rebuild the project to embed it.</p>
</body></html>`;

/** Advertise the widget to MCP clients during initialize. */
export function listProgressWidget(): ListResourcesResult {
  return {
    resources: [
      {
        uri: WIDGET_URI,
        name: 'comet-mcp research progress',
        description: 'Live progress card for in-flight research tasks. Embeds the task id and current status.',
        mimeType: WIDGET_MIME,
      },
    ],
  };
}

/**
 * Build the resource body for the widget. The HTML is static; we parameterise
 * status via query string so the iframe can render something sensible even
 * before the host implements the postMessage protocol.
 */
export function readProgressWidget(opts: {
  taskId: string;
  status?: 'working' | 'completed' | 'failed' | 'cancelled';
  message?: string;
} = { taskId: 'unknown' }): ReadResourceResult {
  const params = new URLSearchParams();
  params.set('taskId', opts.taskId);
  // Default status to 'working' so the iframe renders the right initial pill
  // before any host-side postMessage arrives.
  params.set('status', opts.status ?? 'working');
  if (opts.message) params.set('message', opts.message);

  const base = loadWidgetHtml();
  const body = base.replace(
    '</head>',
    `<script>document.documentURI = "${WIDGET_URI}?${params.toString()}";</script></head>`,
  );

  return {
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: WIDGET_MIME,
        text: body,
      },
    ],
  };
}

/** URL exposed to callers of comet_research so they can render the widget. */
export function progressWidgetUri(taskId: string): string {
  return `${WIDGET_URI}?taskId=${encodeURIComponent(taskId)}`;
}

/** The URI clients use to identify our single widget resource. */
export const PROGRESS_WIDGET_URI = WIDGET_URI;
