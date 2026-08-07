import { describe, it, expect } from 'vitest';
import {
  listProgressWidget,
  readProgressWidget,
  progressWidgetUri,
  PROGRESS_WIDGET_URI,
} from '../../src/mcp/widgets.js';

describe('progress widget', () => {
  it('advertises exactly one resource at the canonical URI', () => {
    const list = listProgressWidget();
    expect(list.resources).toHaveLength(1);
    expect(list.resources[0]?.uri).toBe('ui://comet-mcp/progress.html');
    expect(list.resources[0]?.mimeType).toBe('text/html;profile=mcp-app');
  });

  it('read returns HTML containing the taskId', () => {
    const result = readProgressWidget({ taskId: 't_abc123def456', status: 'working' });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.uri).toBe('ui://comet-mcp/progress.html');
    const html = result.contents[0]?.text ?? '';
    expect(html).toContain('<!DOCTYPE html>');
    // The script tag we inject bakes in the query string with taskId
    expect(html).toContain('t_abc123def456');
    expect(html).toContain('status=working');
  });

  it('read encodes status and message in the URL params', () => {
    const result = readProgressWidget({
      taskId: 't_xyz',
      status: 'completed',
      message: 'done in 47s',
    });
    const html = result.contents[0]?.text ?? '';
    expect(html).toContain('status=completed');
    expect(html).toContain('done+in+47s');
  });

  it('progressWidgetUri builds a canonical ui:// URL with taskId', () => {
    const url = progressWidgetUri('t_123');
    expect(url).toBe('ui://comet-mcp/progress.html?taskId=t_123');
  });

  it('read defaults to status=working when not specified', () => {
    const result = readProgressWidget({ taskId: 't_nostatus' });
    const html = result.contents[0]?.text ?? '';
    expect(html).toContain('status=working');
  });

  it('read escapes special characters in taskId via URLSearchParams', () => {
    const result = readProgressWidget({ taskId: 't_?&=' });
    const html = result.contents[0]?.text ?? '';
    // URLSearchParams handles escaping; we just verify no syntax breakage
    expect(html).toContain('taskId=');
    expect(html).not.toContain('"t_?&="');
  });

  it('PROGRESS_WIDGET_URI is the canonical constant', () => {
    expect(PROGRESS_WIDGET_URI).toBe('ui://comet-mcp/progress.html');
  });

  it('list is idempotent', () => {
    const a = listProgressWidget();
    const b = listProgressWidget();
    expect(a).toEqual(b);
  });
});
