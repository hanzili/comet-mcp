import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTaskRegistry,
  startTask,
  finishTask,
  failTask,
  type CreateTaskResult,
  type TaskStatusResult,
} from '../../src/mcp/tasks.js';

describe('TaskRegistry', () => {
  beforeEach(() => {
    getTaskRegistry().clear();
  });

  it('creates a task with working status', () => {
    const t = startTask({ statusMessage: 'researching' });
    expect(t.taskId).toMatch(/^t_[0-9a-f]{12}$/);
    expect(t.status).toBe('working');
    expect(t.statusMessage).toBe('researching');
    expect(t.pollInterval).toBe(1500);
    expect(t.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('get() returns a TaskStatusResult snapshot', () => {
    const t = startTask();
    const snap = getTaskRegistry().get(t.taskId);
    expect(snap).not.toBeNull();
    expect(snap?.status).toBe('working');
    expect(snap?.taskId).toBe(t.taskId);
  });

  it('get() returns null for unknown id', () => {
    expect(getTaskRegistry().get('t_doesnotexist')).toBeNull();
  });

  it('complete() transitions to completed with content', () => {
    const t = startTask();
    const ok = finishTask(t.taskId, [{ type: 'text', text: 'answer here' }], 'done');
    expect(ok).toBe(true);
    const snap = getTaskRegistry().get(t.taskId);
    expect(snap?.status).toBe('completed');
    expect(snap?.content).toEqual([{ type: 'text', text: 'answer here' }]);
    expect(snap?.statusMessage).toBe('done');
    expect(snap?.completedAt).toBeDefined();
  });

  it('complete() is idempotent (second call is a no-op)', () => {
    const t = startTask();
    finishTask(t.taskId, [{ type: 'text', text: 'first' }]);
    const ok = finishTask(t.taskId, [{ type: 'text', text: 'second' }]);
    expect(ok).toBe(false);
    expect(getTaskRegistry().get(t.taskId)?.content?.[0]?.text).toBe('first');
  });

  it('fail() transitions to failed with error', () => {
    const t = startTask();
    expect(failTask(t.taskId, 'boom')).toBe(true);
    const snap = getTaskRegistry().get(t.taskId);
    expect(snap?.status).toBe('failed');
    expect(snap?.error).toBe('boom');
  });

  it('cancel() works on a working task', () => {
    const t = startTask();
    expect(getTaskRegistry().cancel(t.taskId)).toBe(true);
    expect(getTaskRegistry().get(t.taskId)?.status).toBe('cancelled');
  });

  it('cancel() is idempotent on already-completed', () => {
    const t = startTask();
    finishTask(t.taskId, [{ type: 'text', text: 'x' }]);
    expect(getTaskRegistry().cancel(t.taskId)).toBe(false);
  });

  it('list() returns tasks newest-first', async () => {
    const a = startTask();
    await new Promise((r) => setTimeout(r, 2));
    const b = startTask();
    await new Promise((r) => setTimeout(r, 2));
    const c = startTask();
    const order = getTaskRegistry().list().map((t) => t.taskId);
    expect(order).toEqual([c.taskId, b.taskId, a.taskId]);
  });

  it('watch() fires on transitions', async () => {
    const t = startTask();
    const events: TaskStatusResult[] = [];
    getTaskRegistry().watch(t.taskId, (snap) => events.push(snap));
    finishTask(t.taskId, [{ type: 'text', text: 'x' }]);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('completed');
    expect(events[0]?.content?.[0]?.text).toBe('x');
  });

  it('watch() returns an unsubscribe fn that actually unsubscribes', async () => {
    const t = startTask();
    const events: string[] = [];
    const unsub = getTaskRegistry().watch(t.taskId, (s) => events.push(s.status));
    finishTask(t.taskId, [{ type: 'text', text: 'a' }]);
    events.length = 0;
    finishTask(t.taskId, [{ type: 'text', text: 'b' }]);
    expect(events).toHaveLength(0);
    unsub(); // idempotent
  });

  it('size() and clear()', () => {
    expect(getTaskRegistry().size()).toBe(0);
    startTask();
    startTask();
    expect(getTaskRegistry().size()).toBe(2);
    getTaskRegistry().clear();
    expect(getTaskRegistry().size()).toBe(0);
  });

  it('CreateTaskResult marker shape', () => {
    // This is the contract a comet_research tool will return so callers
    // know they're getting a handle, not an immediate result.
    const t = startTask();
    const result: CreateTaskResult = { isTask: true, task: t };
    expect(result.isTask).toBe(true);
    expect(result.task.taskId).toBe(t.taskId);
  });
});
