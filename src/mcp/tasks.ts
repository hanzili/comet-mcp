// MCP 2025-11-25 Task primitive.
//
// Pure module: an in-memory registry of async tasks, plus JSON-RPC-shaped
// result types that match the spec. The server wires the JSON-RPC handlers
// in index.ts via `server.setRequestHandler('tasks/list' | 'tasks/result' |
// 'tasks/cancel', ...)` and tool invocations return CreateTaskResult instead
// of blocking.
//
// Status transitions:
//
//   working ──► input_required ──► working (after caller supplies input)
//   working ──► completed (with content)
//   working ──► failed (with error message)
//   any       ──► cancelled
//
// Spec: https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface TaskCreated {
  taskId: string;
  status: TaskStatus;
  /** Server-suggested poll cadence in ms (RFC 2119: SHOULD). */
  pollInterval?: number;
  /** Optional human-readable message ("researching X..."). */
  statusMessage?: string;
  /** Optional ISO timestamp the task was created. */
  createdAt?: string;
}

export interface TaskStatusResult {
  taskId: string;
  status: TaskStatus;
  /** Tool result content (only when status==='completed'). */
  content?: { type: 'text'; text: string }[];
  /** Error message (only when status==='failed'). */
  error?: string;
  /** Final status message (e.g. "completed after 47 steps"). */
  statusMessage?: string;
  /** Optional ISO timestamp the task completed. */
  completedAt?: string;
}

/** Result a tool returns when it kicks off a task instead of blocking. */
export interface CreateTaskResult {
  /** Marker so a tool can return either a task or an immediate result. */
  isTask: true;
  task: TaskCreated;
}

/** Maximum simultaneous tasks kept in memory. */
const MAX_TASKS = 500;

/** Stable task id generator: 12 hex chars. */
function newTaskId(): string {
  // Math.random is fine here — we don't need cryptographic uniqueness.
  return 't_' + Math.random().toString(16).slice(2, 14);
}

interface InternalTask {
  id: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  completedAt?: string;
  content?: { type: 'text'; text: string }[];
  error?: string;
  /** Notification callbacks fired on status transitions. */
  listeners: Set<(t: InternalTask) => void>;
}

class TaskRegistry {
  private tasks = new Map<string, InternalTask>();

  /** Spawn a new task. Returns its handle + initial status. */
  create(opts: { statusMessage?: string; pollInterval?: number } = {}): TaskCreated {
    const t: InternalTask = {
      id: newTaskId(),
      status: 'working',
      statusMessage: opts.statusMessage,
      createdAt: new Date().toISOString(),
      listeners: new Set(),
    };
    this.tasks.set(t.id, t);
    this.evict();
    return {
      taskId: t.id,
      status: t.status,
      statusMessage: t.statusMessage,
      pollInterval: opts.pollInterval ?? 1500,
      createdAt: t.createdAt,
    };
  }

  /** Read a task. Returns the public result type (no listeners leaked). */
  get(taskId: string): TaskStatusResult | null {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    return this.toStatusResult(t);
  }

  /** Mark complete with the tool result content. */
  complete(taskId: string, content: { type: 'text'; text: string }[], statusMessage?: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t || t.status === 'completed' || t.status === 'cancelled') return false;
    t.status = 'completed';
    t.content = content;
    t.completedAt = new Date().toISOString();
    if (statusMessage) t.statusMessage = statusMessage;
    this.notify(t);
    return true;
  }

  /** Mark failed with an error message. */
  fail(taskId: string, error: string, statusMessage?: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t || t.status === 'completed' || t.status === 'cancelled') return false;
    t.status = 'failed';
    t.error = error;
    t.completedAt = new Date().toISOString();
    if (statusMessage) t.statusMessage = statusMessage;
    this.notify(t);
    return true;
  }

  /** Mark cancelled. Idempotent. */
  cancel(taskId: string, statusMessage?: string): boolean {
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return false;
    t.status = 'cancelled';
    t.completedAt = new Date().toISOString();
    if (statusMessage) t.statusMessage = statusMessage;
    this.notify(t);
    return true;
  }

  /** Subscribe to status transitions for a task. Returns an unsubscribe fn. */
  watch(taskId: string, cb: (t: TaskStatusResult) => void): () => void {
    const t = this.tasks.get(taskId);
    if (!t) return () => undefined;
    const listener = () => cb(this.toStatusResult(t));
    t.listeners.add(listener);
    return () => t.listeners.delete(listener);
  }

  /** List tasks, newest first. */
  list(): TaskStatusResult[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((t) => this.toStatusResult(t));
  }

  /** Number of tracked tasks. */
  size(): number {
    return this.tasks.size;
  }

  /** Wipe. Tests + reset tool only. */
  clear(): void {
    this.tasks.clear();
  }

  private toStatusResult(t: InternalTask): TaskStatusResult {
    return {
      taskId: t.id,
      status: t.status,
      content: t.content,
      error: t.error,
      statusMessage: t.statusMessage,
      completedAt: t.completedAt,
    };
  }

  private notify(t: InternalTask): void {
    for (const cb of t.listeners) cb(t);
  }

  /** FIFO evict oldest tasks once we exceed the cap. */
  private evict(): void {
    if (this.tasks.size <= MAX_TASKS) return;
    const sorted = [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const toEvict = sorted.slice(0, this.tasks.size - MAX_TASKS);
    for (const t of toEvict) this.tasks.delete(t.id);
  }
}

/** Process-wide singleton. */
const registry = new TaskRegistry();

export function getTaskRegistry(): TaskRegistry {
  return registry;
}

/** Convenience for tool call sites that want to start a task. */
export function startTask(opts?: { statusMessage?: string; pollInterval?: number }): TaskCreated {
  return registry.create(opts);
}

/** Convenience for completing a task with a tool result. */
export function finishTask(
  taskId: string,
  content: { type: 'text'; text: string }[],
  statusMessage?: string,
): boolean {
  return registry.complete(taskId, content, statusMessage);
}

/** Convenience for marking a task failed. */
export function failTask(taskId: string, error: string): boolean {
  return registry.fail(taskId, error);
}
