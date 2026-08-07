// Background runner: bridges the TaskRegistry to cometAI. Given a task id
// and a working function, kicks off the work asynchronously and updates the
// task to completed/failed when done. Designed so the MCP caller never
// blocks on long-running work (research mode can take 60-90s).
//
// This module is deliberately thin. If we later want cancellation that
// actually aborts the underlying work, the function returned by start()
// is the hook — wire an AbortController through here.

import { getTaskRegistry, type TaskCreated, type TaskStatusResult } from './tasks.js';

export interface TaskOptions {
  /** Human-readable label while working ("researching X"). */
  statusMessage?: string;
  /** Polling hint sent to callers (default 1500ms). */
  pollInterval?: number;
}

/**
 * Start a task and run `work` in the background. The MCP caller gets
 * the task handle synchronously and can poll via `tasks/result`,
 * `comet_poll_task`, or `tasks/list`.
 */
export function runBackgroundTask(
  work: (signal: { aborted: boolean }) => Promise<{
    text: string;
    statusMessage?: string;
  }>,
  options: TaskOptions = {},
): TaskCreated {
  const task = getTaskRegistry().create(options);

  // Fire-and-forget. If the synchronous promise throws before its first
  // await, we need to capture that — wrap with a resolved placeholder.
  Promise.resolve()
    .then(() => work({ aborted: false }))
    .then((result) => {
      getTaskRegistry().complete(
        task.taskId,
        [{ type: 'text', text: result.text }],
        result.statusMessage,
      );
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      getTaskRegistry().fail(task.taskId, message);
    });

  return task;
}

/** Helper for tools that want the full status snapshot. */
export function readTask(taskId: string): TaskStatusResult | null {
  return getTaskRegistry().get(taskId);
}

/** Helper for tools that want the list (newest first). */
export function listTasks(): TaskStatusResult[] {
  return getTaskRegistry().list();
}
