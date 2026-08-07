/**
 * P1 Half 2 — minimal conversation event store ("days not weeks", both provider
 * critiques 2026-08-07).
 *
 * Scope confirmed by Perplexity + Grok critiques (docs/reference/06-provider-critiques/):
 *   - append-only JSONL event log (ConversationEvent, monotonic seq)
 *   - idempotency index (idempotencyKey → first envelope event; replay/retry with the
 *     same key must not produce a duplicate send — the P1 gate's replay-safety criterion)
 *   - durable cursor checkpoints (per provider/tab extraction cursor — P3 reconnect-dedup)
 *   - receipts as an APPEND-ONLY stream carrying extraction evidence + attempt numbers
 *     (Perplexity critique L35/L37)
 *
 * Storage layout (under package root, gitignored):
 *   data/event-log.jsonl   — append-only conversation events
 *   data/cursors.json      — durable per-tab extraction cursor checkpoints (atomic rewrite)
 *
 * NOT in scope (deferred): redaction/no-content modes, retention, P4 reconciliation,
 * full P1b relay machinery. The store is provider-neutral — browser transport is
 * orthogonal (ADR 0001 §Transport 3).
 */

import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import { packageRoot } from './registry.js';
import type {
  ConversationEvent, ConversationEventType, ContentPersistenceMode,
  DeliveryReceipt, ConversationEnvelope, ProviderId,
} from '../types/conversation.js';

const DATA_DIR = () => process.env.COMET_DATA_DIR || join(packageRoot(), 'data');
const EVENT_LOG = () => join(DATA_DIR(), 'event-log.jsonl');
const CURSORS_FILE = () => join(DATA_DIR(), 'cursors.json');

/** In-memory seq watermark — the append-only log's monotonic counter. */
let nextSeq = 0;

/** idempotencyKey → first envelope.created event (replay-safety index). */
const idempotencyIndex = new Map<string, ConversationEvent>();
/** correlationId → events (for grouped reads). */
const correlationIndex = new Map<string, ConversationEvent[]>();
/** `${provider}:${tabId}` → latest durable cursor checkpoint. */
let cursorCheckpoints: Record<string, { cursor: string; at: string }> = {};

let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  mkdirSync(DATA_DIR(), { recursive: true });
  // rebuild seq watermark + indexes from the append-only log
  if (existsSync(EVENT_LOG())) {
    for (const line of readFileSync(EVENT_LOG(), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as ConversationEvent;
        if (typeof ev.seq === 'number' && ev.seq >= nextSeq) nextSeq = ev.seq + 1;
        if (ev.idempotencyKey && !idempotencyIndex.has(ev.idempotencyKey)) {
          idempotencyIndex.set(ev.idempotencyKey, ev);
        }
        if (ev.correlationId) {
          const list = correlationIndex.get(ev.correlationId) ?? [];
          list.push(ev);
          correlationIndex.set(ev.correlationId, list);
        }
      } catch { /* skip corrupt line — log is append-only, never rewritten */ }
    }
  }
  // load durable cursor checkpoints
  if (existsSync(CURSORS_FILE())) {
    try {
      cursorCheckpoints = JSON.parse(readFileSync(CURSORS_FILE(), 'utf8')) ?? {};
    } catch { cursorCheckpoints = {}; }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Monotonic sequence number — safe across restarts (watermark rebuilt from log). */
export function nextSequence(): number {
  ensureLoaded();
  return nextSeq++;
}

/**
 * Append one event to the log. Returns the materialized event (with seq/eventId/at).
 * Append-only: never mutates a prior row. Callers must not call this with a reused
 * seq — always via nextSequence().
 */
export function appendEvent(input: {
  type: ConversationEventType;
  correlationId: string;
  envelopeId?: string;
  idempotencyKey?: string;
  receiptStatus?: DeliveryReceipt['status'];
  response?: ConversationEvent['response'];
  persistenceMode?: ContentPersistenceMode;
}): ConversationEvent {
  ensureLoaded();
  const event: ConversationEvent = {
    eventId: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seq: nextSequence(),
    type: input.type,
    correlationId: input.correlationId,
    envelopeId: input.envelopeId,
    idempotencyKey: input.idempotencyKey,
    receiptStatus: input.receiptStatus,
    response: input.response,
    persistenceMode: input.persistenceMode ?? 'full',
    at: nowIso(),
  };
  appendFileSync(EVENT_LOG(), JSON.stringify(event) + '\n', 'utf8');
  if (event.idempotencyKey && !idempotencyIndex.has(event.idempotencyKey)) {
    idempotencyIndex.set(event.idempotencyKey, event);
  }
  const list = correlationIndex.get(event.correlationId) ?? [];
  list.push(event);
  correlationIndex.set(event.correlationId, list);
  return event;
}

// ---------------------------------------------------------------------------
// Idempotency index — replay safety (P1 gate: "recovery/replay creates no
// duplicate send")
// ---------------------------------------------------------------------------

/**
 * True when an envelope with this idempotencyKey was already recorded. A replay or
 * retry with the same key MUST NOT produce a new send — the caller returns the
 * prior outcome instead (dedup by key, per attempt gets a fresh id + attempt number).
 */
export function hasIdempotencyKey(key: string): boolean {
  ensureLoaded();
  return idempotencyIndex.has(key);
}

/** The first recorded event for an idempotencyKey (for replaying its outcome). */
export function getIdempotencyEvent(key: string): ConversationEvent | null {
  ensureLoaded();
  return idempotencyIndex.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Durable cursor checkpoints (P3 reconnect-dedup substrate)
// ---------------------------------------------------------------------------

/**
 * Persist a durable extraction cursor for a provider tab. Atomic rewrite (temp +
 * rename) — small file, written only on state change (per completed poll), NOT on
 * the hot path.
 */
export function checkpointCursor(provider: ProviderId | string, tabId: string, cursor: string): void {
  ensureLoaded();
  const key = `${provider}:${tabId}`;
  cursorCheckpoints = { ...cursorCheckpoints, [key]: { cursor, at: nowIso() } };
  const tmp = CURSORS_FILE() + '.tmp';
  writeFileSync(tmp, JSON.stringify(cursorCheckpoints, null, 2), 'utf8');
  renameSync(tmp, CURSORS_FILE());
}

/** The latest durable cursor for a provider tab, or null. */
export function getCursor(provider: ProviderId | string, tabId: string): string | null {
  ensureLoaded();
  return cursorCheckpoints[`${provider}:${tabId}`]?.cursor ?? null;
}

/** All durable cursor checkpoints (for diagnostics / provider_list). */
export function listCursors(): Record<string, { cursor: string; at: string }> {
  ensureLoaded();
  return { ...cursorCheckpoints };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All events for a correlation, in seq order. Empty array when none. */
export function eventsForCorrelation(correlationId: string): ConversationEvent[] {
  ensureLoaded();
  return [...(correlationIndex.get(correlationId) ?? [])].sort((a, b) => a.seq - b.seq);
}

/** The receipt stream (append-only) for a correlation, in seq order. */
export function receiptsForCorrelation(correlationId: string): ConversationEvent[] {
  return eventsForCorrelation(correlationId).filter((e) => e.type === 'delivery.receipt');
}

/** The whole log, in seq order (bounded for safety). */
export function allEvents(limit = 10000): ConversationEvent[] {
  ensureLoaded();
  if (!existsSync(EVENT_LOG())) return [];
  const out: ConversationEvent[] = [];
  for (const line of readFileSync(EVENT_LOG(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as ConversationEvent;
      out.push(ev);
      if (out.length >= limit) break;
    } catch { /* skip corrupt line */ }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Highest seq in the log (for diagnostics). */
export function currentSeq(): number {
  ensureLoaded();
  return nextSeq - 1;
}

/** True when a response with this contentHash was already recorded for a correlation. */
export function hasResponseHash(correlationId: string, contentHash: string): boolean {
  return eventsForCorrelation(correlationId).some(
    (e) => e.type === 'response.received' && e.response?.contentHash === contentHash,
  );
}

// ---------------------------------------------------------------------------
// Fabric helpers — the envelope → queue → send → response → receipt lifecycle
// (provider-neutral; askAndWaitOn uses these so every send is durable + idempotent)
// ---------------------------------------------------------------------------

/** Record envelope.created; returns the event (the idempotency anchor). */
export function recordEnvelopeCreated(envelope: ConversationEnvelope): ConversationEvent {
  return appendEvent({
    type: 'envelope.created',
    correlationId: envelope.correlationId,
    envelopeId: envelope.idempotencyKey, // envelope identity in v1 = its idempotency key
    idempotencyKey: envelope.idempotencyKey,
    persistenceMode: envelope.relay.mode === 'disabled' ? 'full' : 'redacted',
  });
}

/** Record a send lifecycle event (queued / accepted / blocked / timed_out / unknown). */
export function recordSendEvent(
  envelope: ConversationEnvelope,
  type: 'send.queued' | 'send.accepted' | 'send.blocked' | 'send.timed_out' | 'send.unknown',
): ConversationEvent {
  return appendEvent({
    type,
    correlationId: envelope.correlationId,
    envelopeId: envelope.idempotencyKey,
    idempotencyKey: envelope.idempotencyKey,
    receiptStatus: type === 'send.queued' ? 'queued' : type === 'send.accepted' ? 'accepted' : type === 'send.blocked' ? 'blocked' : type === 'send.timed_out' ? 'timed_out' : 'unknown',
  });
}

/** Record a received response (with extraction evidence) + checkpoint its cursor. */
export function recordResponseReceived(
  envelope: ConversationEnvelope,
  provider: ProviderId,
  response: { messageId?: string; contentHash: string; cursor?: string; state: string; text: string; steps: string[] },
  tabId: string,
): ConversationEvent {
  const ev = appendEvent({
    type: 'response.received',
    correlationId: envelope.correlationId,
    envelopeId: envelope.idempotencyKey,
    idempotencyKey: envelope.idempotencyKey,
    response: {
      provider,
      messageId: response.messageId,
      contentHash: response.contentHash,
      cursor: response.cursor,
      poll: { state: response.state, response: response.text, steps: response.steps },
    },
  });
  if (response.cursor) checkpointCursor(provider, tabId, response.cursor);
  return ev;
}

/** Record a deduplicated response (same hash/cursor as a prior event — no new send). */
export function recordResponseDeduplicated(
  envelope: ConversationEnvelope,
  provider: ProviderId,
  response: { messageId?: string; contentHash: string; cursor?: string; state: string; text: string; steps: string[] },
): ConversationEvent {
  return appendEvent({
    type: 'response.deduplicated',
    correlationId: envelope.correlationId,
    envelopeId: envelope.idempotencyKey,
    idempotencyKey: envelope.idempotencyKey,
    response: {
      provider,
      messageId: response.messageId,
      contentHash: response.contentHash,
      cursor: response.cursor,
      poll: { state: response.state, response: response.text, steps: response.steps },
    },
  });
}

/**
 * Record a delivery receipt — APPEND-ONLY stream (critique L37: "treat receipts as
 * an append-only stream, not a mutable record"). Each attempt is its own row;
 * retries reuse idempotencyKey and carry incrementing attempt numbers.
 */
export function recordDeliveryReceipt(receipt: DeliveryReceipt): ConversationEvent {
  return appendEvent({
    type: 'delivery.receipt',
    correlationId: receipt.correlationId,
    envelopeId: receipt.envelopeId,
    idempotencyKey: receipt.idempotencyKey,
    receiptStatus: receipt.status,
  });
}

/**
 * Reset the store (tests only — wipes data dir files AND memory).
 */
export function _resetForTests(): void {
  nextSeq = 0;
  idempotencyIndex.clear();
  correlationIndex.clear();
  cursorCheckpoints = {};
  loaded = false;
  try { mkdirSync(DATA_DIR(), { recursive: true }); } catch { /* ignore */ }
  try { writeFileSync(EVENT_LOG(), '', 'utf8'); } catch { /* ignore */ }
  try { writeFileSync(CURSORS_FILE(), '{}', 'utf8'); } catch { /* ignore */ }
}

/**
 * Memory-only reload (tests only): clears in-memory state but LEAVES the files,
 * so the next read re-derives indexes from disk — simulates a process restart.
 */
export function _reloadMemoryForTests(): void {
  nextSeq = 0;
  idempotencyIndex.clear();
  correlationIndex.clear();
  cursorCheckpoints = {};
  loaded = false;
}
