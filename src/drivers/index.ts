/**
 * Driver registry + provider-neutral ask/poll helpers (P2 wiring).
 *
 * The cleanest path to making Grok usable from MCP tools: a registry maps provider
 * names to ChatDriver instances, and generic helpers implement the ask→wait→respond
 * loop ONCE over the ChatDriver contract. The `provider_*` MCP tools dispatch via the
 * registry; `comet_*` tools become thin Perplexity aliases over the same helpers
 * (identical external behavior — the P1 migration path).
 */

import type { ChatDriver, PollResult, TabSession } from '../types/provider.js';
import type { ProviderId } from '../types/conversation.js';
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { packageRoot, loadEntry } from '../core/registry.js';
import { sessionPool } from '../cdp-pool.js';
import { tabRegistry } from '../tab-registry.js';
import { perplexityDriver } from './perplexity.js';
import { grokDriver } from './grok.js';
import { geminiDriver } from './gemini.js';
import { chatgptDriver } from './chatgpt.js';
import { claudeDriver } from './claude.js';
import {
  hasIdempotencyKey, getIdempotencyEvent, recordEnvelopeCreated, recordSendEvent,
  recordResponseReceived, recordResponseDeduplicated, recordResponseAmended, recordDeliveryReceipt,
  eventsForCorrelation, hasResponseHash, checkpointCursor,
  nextSequence, _resetForTests as _eventStoreReset,
} from '../core/event-store.js';
import { CONSERVATIVE_RELAY_DEFAULTS, DEFAULT_SEND_BUDGET } from '../types/conversation.js';
import type { ConversationEnvelope } from '../types/conversation.js';

const DRIVERS: Record<string, ChatDriver> = {
  perplexity: perplexityDriver,
  grok: grokDriver,
  // P6 (2026-08-08): entry-driven adapters on BaseChatDriver — all five askable.
  gemini: geminiDriver,
  chatgpt: chatgptDriver,
  claude: claudeDriver,
};

/**
 * 2026-08-10 (user request): DEBUG switch — when set, the completion gate
 * requires poll.state === 'completed' (the ORIGINAL behavior). This lets the
 * underlying state-detection bug be reproduced/diagnosed in isolation instead
 * of being masked by the content-based fallback. Read ONCE at module load — a
 * per-call process.env read is racy under node's concurrent test runner.
 */
export const STRICT_COMPLETION_GATE = process.env.COMET_STRICT_COMPLETION_GATE === '1';

/** Resolve a driver by provider name, or null for unknown. */
export function getDriver(provider: string): ChatDriver | null {
  return DRIVERS[provider] ?? null;
}

/** Open (or reuse) a provider tab via the registry; returns the registered TabSession. */
export async function openTab(provider: string, opts: { newTab?: boolean } = {}): Promise<TabSession> {
  const driver = getDriver(provider);
  if (!driver) throw new Error(`Unknown provider: ${provider} (have: ${listDrivers().join(', ')})`);
  return tabRegistry.open(driver.provider, opts);
}

/** List registered provider names. */
export function listDrivers(): string[] {
  return Object.keys(DRIVERS);
}

// ---------------------------------------------------------------------------
// P3: per-tab poll backoff + circuit breaker
// (Perplexity critique: P0 spike measured evaluate/insert load, NOT sustained
// five-tab streaming extraction — the pool needs per-tab throttling.)
// ---------------------------------------------------------------------------

const POLL_BASE_MS = 2000;
const POLL_MAX_MS = 15000;
const CIRCUIT_TRIP_THRESHOLD = 5;   // consecutive poll failures before the breaker opens
const CIRCUIT_COOLDOWN_MS = 30000;  // half-open retry after cooldown

/**
 * Completion stability window (found live 2026-08-07): Grok pauses between phases
 * ("Worked for Xs" appears while the research trail is done but the ANSWER is still
 * streaming). Two identical 2s-apart polls can catch such a pause and latch a
 * truncated answer (observed: latched 1592 chars of a 10205-char answer). Completion
 * now requires the response hash to be unchanged for at least this wall-clock window.
 */
export const MIN_COMPLETION_STABILITY_MS = 8000;

/**
 * P4 latency fix (2026-08-09, consult-validated): completion windows per
 * confidence tier. authoritative needs NO wall clock (hash-confirmed at the
 * gate); heuristic (stop-absent on providers with real stop buttons, Perplexity
 * steps-only) uses a short window; weak (response-present, no marker/stop)
 * keeps the full anti-truncation window. Entry-level override wins:
 * entry.signals.completed.windowMs ?? this map.
 */
export const CONFIDENCE_WINDOWS: Record<'authoritative' | 'heuristic' | 'weak', number> = {
  authoritative: 0,
  heuristic: 3000,
  weak: MIN_COMPLETION_STABILITY_MS,
};

/** Resolve the stability window for a poll: entry override > confidence map > 8s. */
export function windowForPoll(
  poll: import('../types/provider.js').PollResult,
  entryWindowMs?: number,
): number {
  const confidence = poll.completionConfidence ?? 'weak';
  return entryWindowMs ?? CONFIDENCE_WINDOWS[confidence] ?? MIN_COMPLETION_STABILITY_MS;
}

interface TabCircuit {
  failures: number;
  openUntil: number; // epoch ms; 0 = closed
  lastPollAt: number;
}

const circuits = new Map<string, TabCircuit>();

/** Backoff for the next poll on a tab (2s base, doubles, caps at 15s). */
export function pollDelayFor(targetId: string, prevDelayMs = 0): number {
  const c = circuits.get(targetId) ?? { failures: 0, openUntil: 0, lastPollAt: 0 };
  return Math.min(POLL_BASE_MS * Math.pow(2, c.failures), POLL_MAX_MS);
}

/** Record a successful poll — reset the breaker's failure counter and close the circuit. */
export function recordPollSuccess(targetId: string): void {
  const c = circuits.get(targetId) ?? { failures: 0, openUntil: 0, lastPollAt: 0 };
  c.failures = 0;
  c.openUntil = 0; // success closes an open circuit (half-open retry passed)
  c.lastPollAt = Date.now();
  circuits.set(targetId, c);
}

/**
 * Record a poll failure. Returns the remaining cooldown when the circuit is open
 * (caller should skip the poll), else 0.
 */
export function recordPollFailure(targetId: string): number {
  const c = circuits.get(targetId) ?? { failures: 0, openUntil: 0, lastPollAt: 0 };
  c.failures++;
  if (c.failures >= CIRCUIT_TRIP_THRESHOLD) {
    c.openUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
  }
  c.lastPollAt = Date.now();
  circuits.set(targetId, c);
  return Math.max(0, c.openUntil - Date.now());
}

/** True when the tab's circuit is open (skip polling, surface degraded state). */
export function isCircuitOpen(targetId: string): boolean {
  const c = circuits.get(targetId);
  return !!c && c.openUntil > Date.now();
}

/**
 * Pure completion-stability decision (fix 2026-08-07). The OLD check returned
 * completed after TWO identical readings — but Grok pauses mid-stream for 2-4s
 * between phases, so two 2s-apart polls can both catch the same truncated snapshot
 * (observed: latched 1592 chars of a 10205-char answer). Completion now requires
 * the hash to be unchanged for MIN_COMPLETION_STABILITY_MS of wall-clock time.
 *
 * FIX 2026-08-07 (async-ask): the clock previously started only on the SECOND
 * identical reading (prevHash === hash), so a response already complete at poll #1
 * needed 3 polls / ~34s to finalize, and the first 'completed' poll falsely
 * reported 'in progress'. Now the clock starts on the FIRST reading of the new
 * response (caller gates on sawNewResponse, so this IS new content), and holds
 * for the full window. Anti-truncation is preserved: 8s of true stability is
 * still required before completion.
 *
 * @param stableSince epoch ms when the current hash first became stable (null = none)
 * @param now epoch ms
 * @returns complete=true only when stability held the window; stableSince is the
 *   value to carry into the next poll (null when the hash changed/restarted).
 */
export function completionStability(
  hash: string | null,
  prevHash: string | null,
  stableSince: number | null,
  now: number,
  windowMs: number = MIN_COMPLETION_STABILITY_MS,
): { complete: boolean; stableSince: number | null } {
  const sameAsPrev = hash !== null && (prevHash === null || hash === prevHash);
  if (!sameAsPrev) {
    // content changed between polls — restart the stability clock
    return { complete: false, stableSince: null };
  }
  const since = stableSince ?? now; // first reading of this hash starts the clock
  const held = now - since >= windowMs;
  return { complete: held, stableSince: since };
}

/**
 * Update a TabSession's dedup anchors (P3; reconnect-dedup gate builds on these).
 * When the poll shows a completed response, ALSO checkpoint the extraction cursor to
 * the durable store — a later reconnect re-hydrates from it (tab-registry.poolTab),
 * so "unchanged content produces no new response event".
 */
export function updateSessionAnchors(session: TabSession, poll: PollResult): void {
  if (poll.messageId) session.lastKnownMessageId = poll.messageId;
  if (poll.contentHash) session.lastContentHash = poll.contentHash;
  if (poll.cursor) session.extractionCursor = poll.cursor;
  if (poll.state === 'completed') {
    session.lastCompletedAt = new Date().toISOString();
    const cursor = poll.cursor ?? poll.contentHash;
    if (cursor) checkpointCursor(session.provider, session.targetId, cursor);
  }
}

// ---------------------------------------------------------------------------
// P1 Half 2 — envelope lifecycle helpers (durable, idempotent sends)
// ---------------------------------------------------------------------------

/** Build a native-ask envelope (no relay): fresh correlation, idempotent key. */
export function makeEnvelope(source: ProviderId, idempotencyKey?: string): ConversationEnvelope {
  const key = idempotencyKey || `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    idempotencyKey: key,
    correlationId: `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    source,
    content: '', // filled by the caller before send
    provenance: {
      sourceProvider: source,
      attributedTo: source,
      safetyClaimed: false,
    },
    relay: { ...CONSERVATIVE_RELAY_DEFAULTS },
    budget: { ...DEFAULT_SEND_BUDGET, wallClockDeadlineMs: Date.now() + 5 * 60 * 1000 },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Replay guard (P1 gate: "recovery/replay creates no duplicate send"). When an
 * envelope with this idempotencyKey was already recorded, return the PRIOR outcome
 * (the last response.received for its correlation) instead of sending again.
 */
export function replayOutcomeIfRecorded(key: string): AskOutcome | null {
  const first = getIdempotencyEvent(key);
  if (!first) return null;
  const evs = eventsForCorrelation(first.correlationId);
  const resp = [...evs].reverse().find((e) => e.type === 'response.received' || e.type === 'response.deduplicated');
  if (resp?.response) {
    return {
      completed: true,
      response: resp.response.poll.response,
      markdown: null,
      steps: resp.response.poll.steps,
      currentStep: '',
      status: resp.response.poll.state,
      agentBrowsingUrl: '',
      timedOut: false,
      replayed: true,
    };
  }
  const receipt = [...evs].reverse().find((e) => e.type === 'delivery.receipt');
  return {
    completed: false,
    response: '',
    markdown: null,
    steps: [],
    currentStep: '',
    status: receipt?.receiptStatus ?? 'queued',
    agentBrowsingUrl: '',
    timedOut: false,
    replayed: true,
  };
}

/** A normalized ask outcome — the shared response shape for provider_ask/comet_ask. */
export interface AskOutcome {
  completed: boolean;
  response: string;
  markdown: string | null;
  steps: string[];
  currentStep: string;
  status: string;
  agentBrowsingUrl: string;
  timedOut: boolean;
  /** P1 Half 2: true when the outcome came from the event store (idempotent replay). */
  replayed?: boolean;
  /** P1 Half 2: correlation id of the envelope that produced this outcome. */
  correlationId?: string;
  /** P1 Half 2: idempotency key of the envelope. */
  idempotencyKey?: string;
  /** P3 reconnect-dedup: true when content was already recorded (no new response event). */
  deduped?: boolean;
  /** P6/2026-08-08: true when the outcome was recovered after the ask budget expired (soft expiry → watching). */
  late?: boolean;
  /**
   * 2026-08-10 (user request): dispatch timestamp stamped into the wire prompt
   * (ISO string in the thread) — generation + completion-detection latency is
   * measurable: prompt-sent time (this) vs the model's status-line time vs
   * response.received wall-clock in the event log.
   */
  sentAt?: string;
}

/** Normalize prompt — convert markdown/bullets to natural text (preserves comet_ask behavior). */
export function normalizePrompt(prompt: string): string {
  return prompt
    .replace(/^[-*•]\s*/gm, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Response store (ADR: file-backed, ID-based, retention-aware)
// ---------------------------------------------------------------------------
// 2026-08-07 critique integration (Perplexity + Grok): the compact result must be
// STRUCTURED (not a formatted string), retrieval should be ID-based chunked access
// (not filesystem paths), and the store needs retention. This module writes the full
// response (text + markdown) to responses/<id>.md, keeps an in-memory registry of
// {id, provider, path, hash, fullChars, markdownChars, createdAt, expiresAt}, and
// enforces a TTL + max-count retention.

const RESPONSES_DIR = () => join(packageRoot(), 'responses');
export const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_RESPONSES = 100;

export interface ResponseRecord {
  id: string;
  provider: string;
  path: string;
  contentHash: string;
  fullChars: number;
  markdownChars: number;
  createdAt: string;
  expiresAt: string;
}

const registry = new Map<string, ResponseRecord>();

/** FNV-1a content hash — same as the drivers use for PollResult.contentHash. */
export function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

// ---------------------------------------------------------------------------
// ADR 0010 — sentinel completion marker
// ---------------------------------------------------------------------------

/**
 * Generate a random per-ask sentinel (collision-proof for prose). Mixed-case
 * alphanumeric, ~10 chars — effectively impossible for the model to emit
 * accidentally, unique per ask so no cross-turn ambiguity.
 */
export function generateSentinel(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0/O/1/l/I
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * Append the status-line instruction to a prompt (ADR 0010/0011). The
 * instruction establishes a THREAD CONVENTION: every reply in this session ends
 * with one status line carrying the sentinel LAST. The OTHER fields (turn,
 * date, time, model, context%) are OPTIONAL — the model may estimate them or
 * skip them entirely (claude refuses fabricated turn counters / context%,
 * 2026-08-10). ONLY the sentinel code is MANDATORY — the completion contract is
 * its presence at the end of the line. Context% is the model's own estimate of
 * tokens-used ÷ window — observability, never trusted as truth.
 */
/**
 * ADR 0012 (2026-08-10, user directive): the WORKING status-line prompts per
 * provider. These are set up MANUALLY as platform Custom Instructions (project
 * level / Settings / Gem level) — the prompt is rejected or ineffective when
 * injected into the thread, so the platform carries it. Format is PIPE-
 * separated: `Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | [model name] |
 * [token usage estimate as %] | [10-char code]`. `{sentinel}` is replaced with
 * the per-ask code by withSentinelInstruction / statusLineReminder.
 */
const SENTINEL_INSTRUCTION_BY_PROVIDER: Record<string, string> = {
  perplexity: 'At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | [model name] | [token usage estimate as %] | {sentinel}\n\nRules:\nCount turns starting at 1 for the first turn of the thread.\nUse current system wall-clock time and time zone for the date and time fields.\nCalculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).\nKeep this formatting rule strictly active for every response in the thread.',
  grok: 'At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | Grok [model name] | [token usage estimate as %] | {sentinel}\n\nRules:\nCount turns starting at 1 for the first turn of the thread.\nUse current system wall-clock time and time zone for the date and time fields.\nCalculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).\nKeep this formatting rule strictly active for every response in the thread.',
  claude: 'At the very end of every response you give me in this conversation, add a status line in this exact format:\nTurn [n] | [MM-DD-YY] | Claude [model name] | {sentinel}\nCount turns starting at 1. Use the current date. Keep this rule active for the rest of the thread even if you forget to mention it later.',
  gemini: 'At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | Gemini [model name] | [token usage estimate as %] | {sentinel}\n\nRules:\nCount turns starting at 1 for the first turn of the thread.\nUse current system wall-clock time and time zone for the date and time fields.\nCalculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).\nKeep this formatting rule strictly active for every response in the thread.',
  chatgpt: 'At the very end of every response you give me in this conversation, add a status line in this exact format: Turn [n] | [MM-DD-YY, HH:MM AM/PM TimeZone] | [model name] | [token usage estimate as %] | {sentinel}\n\nRules:\nCount turns starting at 1 for the first turn of the thread.\nUse current system wall-clock time and time zone for the date and time fields.\nCalculate or estimate context window usage percentage based on conversation history (~4 chars per token relative to context capacity).\nKeep this formatting rule strictly active for every response in the thread.',
};

/** Resolve the ADR 0012 status-line instruction template for a provider. */
export function sentinelInstructionFor(provider: string): string {
  return SENTINEL_INSTRUCTION_BY_PROVIDER[provider] ?? SENTINEL_INSTRUCTION_BY_PROVIDER.chatgpt;
}

/**
 * 2026-08-10 (user directive): the short per-ask SENTINEL CODE TAG appended to
 * every completionMarker prompt. The FULL format instruction is an ADR 0012
 * Custom Instruction set up manually per platform (injected prompts are
 * rejected / ineffective) — so the driver only communicates the per-ask code
 * the model must end the status line with. This is the completion contract.
 */
export function sentinelCodeTag(sentinel: string): string {
  return `(Status-line sentinel code for this reply: ${sentinel} — end the status line with exactly this code.)`;
}

/**
 * Append the status-line instruction to a prompt (ADR 0010/0011). Uses the
 * ADR 0012 per-provider WORKING prompt (Custom Instruction text). Note: per
 * the 2026-08-10 user directive this is NOT injected on the first turn of a
 * new thread (the platform Custom Instruction already carries it) — it is used
 * by statusLineReminder and available for reference.
 */
export function withSentinelInstruction(prompt: string, sentinel: string, provider = 'chatgpt'): string {
  return `${prompt}\n\n(Technical: ${sentinelInstructionFor(provider).replace('{sentinel}', sentinel)})`;
}

/**
 * Parse a response's trailing status line (ADR 0011). Returns whether the line
 * is present, whether it is COMPLETE (all six fields), and the parsed fields.
 * Completion detection keys on the sentinel presence; field completeness is
 * observability + the reminder trigger, never a gate on completion itself.
 */
export function parseStatusLine(text: string, sentinel: string): {
  found: boolean;
  complete: boolean;
  line?: string;
  turn?: string;
  date?: string;
  time?: string;
  model?: string;
  contextPct?: string;
} {
  if (!sentinel) return { found: false, complete: false };
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith(sentinel)) return { found: false, complete: false };
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  if (!lastLine.includes(sentinel)) return { found: false, complete: false };
  const parts = lastLine.split(',').map((p) => p.trim());
  const [turn, date, time, model, contextPct] = parts;
  // 2026-08-10 (user directive): fields are OPTIONAL — the model may estimate
  // or skip them (claude refuses fabricated counters). The SENTINEL is the only
  // mandatory part; 'complete' (all fields) is observability, never a gate.
  const complete = parts.length >= 6 && !!turn && !!date && !!time && !!model && !!contextPct;
  return { found: true, complete, line: lastLine, turn, date, time, model, contextPct };
}

/**
 * 2026-08-10 (user directive): the completion signal is a 10-char alphanumeric
 * token at the VERY END of the model's reply — nothing else. The model
 * generates it per its ADR 0012 Custom Instruction; we DETECT it, we do NOT
 * control or verify its value (we don't inject a code). We must NOT rely on
 * the "Turn" line shape, the driver's confidence, or anything else for the
 * marker path.
 */
export function hasTrailingToken(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  return /[A-Za-z0-9]{10}$/.test(trimmed);
}

/**
 * 2026-08-10 (perplexity live bug, user report): detect a trailing status-line
 * SHAPE without requiring the sentinel token. The model followed the convention
 * (Turn <N>, <MM/DD/YY>, <time> <tz>, <model>, <context%>) but dropped the
 * control token — that is COMPLIANT-enough: the line is present, so the ADR
 * 0011 reminder must NOT fire (it interrupts the thread for nothing). The
 * reply still completes through the normal stability window / hash-confirm.
 */
/**
 * 2026-08-10 (user directive): fields are OPTIONAL — the model may estimate or
 * skip them (claude refuses fabricated counters). The shape is ANY line
 * starting with "Turn" (with or without the trailing fields); the SENTINEL is
 * the only mandatory part and is checked separately (stripSentinel).
 */
/**
 * 2026-08-10 (perplexity live bug, user report): detect a trailing status-line
 * SHAPE without requiring the sentinel token. The model followed the convention
 * (Turn <N>, <MM/DD/YY>, <time> <tz>, <model>, <context%>) but dropped the
 * control token — that is COMPLIANT-enough: the line is present, so the ADR
 * 0011 reminder must NOT fire (it interrupts the thread for nothing). The
 * reply still completes through the normal stability window / hash-confirm.
 * 2026-08-10 (user directive): fields are OPTIONAL — the model may estimate or
 * skip them (claude refuses fabricated counters). The shape is ANY line
 * starting with "Turn" (with or without the trailing fields); the SENTINEL is
 * the only mandatory part and is checked separately (stripSentinel).
 */
export function parseStatusLineShape(text: string): {
  found: boolean;
  line?: string;
} {
  const trimmed = text.trimEnd();
  if (!trimmed) return { found: false };
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  // shape = the last line is a status line: starts with "Turn" (pipe-separated
  // per ADR 0012, or comma/space — fields may be estimated, partial, or skipped)
  if (!/^Turn(?:\s|,|\||$)/.test(lastLine)) return { found: false };
  const parts = lastLine.split(',').map((p) => p.trim()).filter(Boolean);
  // require at least "Turn" + one value, or the sentinel (which is the only
  // mandatory part); a bare "Turn <sentinel>" also counts
  if (parts.length < 1) return { found: false };
  if (/^Turn(?:\s|,|\||$)/.test(parts[0] ?? '') && parts.length >= 1) {
    return { found: true, line: lastLine };
  }
  return { found: false };
}

/**
 * 2026-08-10 (live council test): the LAST status line anywhere in a response
 * (the reminder's own reply renders as a bare "Turn N, …" element, possibly
 * with a trailing mid-render fragment from the next line).
 */
export function lastStatusLine(text: string): string {
  const m = [...text.matchAll(/^Turn(?:\s|,)[^\n]*/gm)];
  return m.length ? m[m.length - 1][0] : text.trim();
}

/**
 * 2026-08-10 (live council test): true when a response is ONLY a status line
 * (plus at most a tiny trailing fragment) — i.e. it carries no substantive
 * answer text. The reminder prompt tells the model to "Reply with ONLY that
 * line", so its turn renders as a bare line; the driver's current-turn
 * scoping (last prose element) would otherwise deliver that bare line as the
 * answer, losing the real pre-reminder response.
 */
export function isBareStatusLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const without = trimmed.replace(/^Turn(?:\s|,)[^\n]*/gm, '');
  return without.trim().length <= 2;
}

/**
 * The reminder prompt (ADR 0011, 2026-08-10 user-validated phrasing): injected
 * into the thread when a completed reply is missing the status line. The
 * WORKING phrasing (user directive): "You forgot the status line on your last
 * response — please add it now in the format <per-provider ADR 0012 format>
 * and keep including it going forward." This soft-nudge phrasing works even on
 * claude (which rejects the old "Reply with ONLY that line" framing).
 */
export function statusLineReminder(sentinel: string, provider = 'chatgpt'): string {
  // 2026-08-10 (user directive): the MODEL generates its own code per the
  // Custom Instruction — we don't control it, so the reminder uses the
  // placeholder "[code]" unless a code is passed (legacy callers).
  const code = sentinel || '[code]';
  // the ADR 0012 template embeds the format line: "...in this exact format:
  // <format>" — extract just the format (with the sentinel substituted), not
  // the whole template + rules
  const template = sentinelInstructionFor(provider).replace('{sentinel}', code);
  const formatMatch = template.match(/in this exact format:\s*\n?\s*([^\n]+)/);
  const format = formatMatch?.[1]?.trim() ?? `Turn [n] | [MM-DD-YY] | [model name] | ${code}`;
  return `(You forgot the status line on your last response — please add it now in the format ${format} and keep including it going forward.)`;
}

/**
 * Strip the trailing SENTINEL TOKEN (not the status line) from the END of a
 * response, if present (ADR 0010/0011 amendment 2026-08-10). The sentinel is a
 * control artifact (completion detection) — it must NOT leak into storage,
 * replay, or relay. The STATUS LINE itself (Turn/date/time/model/context%) is
 * KEPT: it is provenance (which model, when, context pressure) — useful when
 * pulling the answer and self-attesting source attribution when relaying.
 * Runs BEFORE hashing/persistence/relay. Handles the bare-token case (no line).
 */
export function stripSentinel(text: string, sentinel: string): { text: string; found: boolean } {
  if (!sentinel) return { text, found: false };
  const trimmed = text.trimEnd();
  // 2026-08-10: separator before the token can be ", ", whitespace, OR the
  // ADR 0012 pipe " | " — strip all of them so the status line stays clean.
  const stripSep = (s: string) => s.replace(/[,\s|]+$/, '');
  // PRIMARY: the response ends with the sentinel (bare token, or status line
  // + token — the model was told to put the token last, nothing after).
  if (trimmed.endsWith(sentinel)) {
    return { text: stripSep(trimmed.slice(0, -sentinel.length)), found: true };
  }
  // 2026-08-10 (live): Perplexity streams the NEXT turn's render into the same
  // container, so a tiny mid-render fragment can trail the sentinel
  // ("…15%, <sentinel>\n\nT"). The sentinel is still the LAST TOKEN of the
  // status line — the completionMarker triggered. Recognize it there; a
  // trailing fragment ≤2 chars (a stray "T"/"T\n") is render noise, dropped.
  // 2026-08-10 (user directive): fields are optional — match ANY "Turn" line.
  const lastLineMatch = [...trimmed.matchAll(/^Turn(?:\s|,|\|)[^\n]*/gm)].pop();
  if (!lastLineMatch) return { text, found: false };
  const line = lastLineMatch[0];
  const trailingAfterLine = trimmed.slice(lastLineMatch.index! + line.length);
  const trailingFragment = trailingAfterLine.trim().length <= 2;
  if (!line.trimEnd().endsWith(sentinel)) return { text, found: false };
  const lineWithout = line.slice(0, -sentinel.length).replace(/[,\s|]+$/, '');
  const prefix = trimmed.slice(0, lastLineMatch.index!);
  const rebuilt = prefix + lineWithout + (trailingFragment ? '' : trailingAfterLine);
  return { text: rebuilt.trimEnd(), found: true };
}

/** Clean up expired + over-count responses on startup and after each write. */
export function enforceRetention(): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, rec] of registry) {
    if (new Date(rec.expiresAt).getTime() < now) {
      try { unlinkSync(rec.path); } catch { /* already gone */ }
      registry.delete(id);
      removed++;
    }
  }
  // max-count: drop oldest
  const sorted = [...registry.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  while (sorted.length > MAX_RESPONSES) {
    const [id, rec] = sorted.shift()!;
    try { unlinkSync(rec.path); } catch { /* already gone */ }
    registry.delete(id);
    removed++;
  }
  return removed;
}

/** Persist a full response, return its ID + structured record. */
export function storeResponse(provider: string, text: string, markdown: string | null): { id: string; rec: ResponseRecord } {
  const dir = RESPONSES_DIR();
  mkdirSync(dir, { recursive: true });
  enforceRetention();
  const id = `${provider}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const path = join(dir, `${id}.md`);
  const body = `# ${provider} response (${id})\n\n${text}\n\n---\n\n## Markdown\n\n${markdown ?? '(none)'}\n`;
  const now = Date.now();
  const rec: ResponseRecord = {
    id, provider, path, contentHash: simpleHash(text),
    fullChars: text.length, markdownChars: markdown?.length ?? 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RESPONSE_TTL_MS).toISOString(),
  };
  // atomic-ish write: write then register
  writeFileSync(path, body);
  registry.set(id, rec);
  return { id, rec };
}

/** Structured compact result (fits gateway budget). */
export function structuredCompact(rec: ResponseRecord, preview: string, status: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status,
    responseId: rec.id,
    preview: preview.length > 200 ? preview.slice(0, 200) + '…' : preview,
    previewChars: preview.length,
    fullChars: rec.fullChars,
    markdownChars: rec.markdownChars,
    contentHash: rec.contentHash,
    expiresAt: rec.expiresAt,
    ...extra,
  });
}

/** Persist a completed AskOutcome and return the structured compact tool-result string. */
export function compactAskResult(provider: string, outcome: AskOutcome): string {
  const { rec } = storeResponse(provider, outcome.response, outcome.markdown ?? null);
  const extra: Record<string, unknown> = {};
  if (outcome.correlationId) extra.correlationId = outcome.correlationId;
  if (outcome.idempotencyKey) extra.idempotencyKey = outcome.idempotencyKey;
  if (outcome.replayed) extra.replayed = true;
  if (outcome.deduped) extra.deduped = true;
  // 2026-08-10 (user request): expose dispatch time for latency measurement —
  // generation = status-line time − sentAt; detection = now − sentAt.
  if (outcome.sentAt) extra.sentAt = outcome.sentAt;
  if (outcome.late) extra.late = true;
  return structuredCompact(rec, outcome.response, outcome.completed ? 'completed' : outcome.status, extra);
}

/** Chunked retrieval by response ID (Perplexity+Grok critique: ID-based, not path-based). */
export function readResponseChunk(id: string, offset = 0, limit = 4000): { ok: boolean; rec?: ResponseRecord; chunk?: string; error?: string } {
  // registry may be empty after a restart — lazily scan the responses dir by id
  if (!registry.has(id) && existsSync(join(RESPONSES_DIR(), `${id}.md`))) {
    const path = join(RESPONSES_DIR(), `${id}.md`);
    try {
      const body = readFileSync(path, 'utf8');
      const m = body.match(/^# (\S+) response \(([^)]+)\)/m);
      const now = Date.now();
      registry.set(id, {
        id, provider: m?.[1] ?? 'unknown', path,
        contentHash: simpleHash(body), fullChars: body.length, markdownChars: 0,
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + RESPONSE_TTL_MS).toISOString(),
      });
    } catch { /* fall through to not-found */ }
  }
  const rec = registry.get(id);
  if (!rec) return { ok: false, error: `unknown responseId: ${id}` };
  try {
    const body = readFileSync(rec.path, 'utf8');
    const chunk = body.slice(offset, offset + limit);
    return { ok: true, rec, chunk, error: body.length > offset + limit ? `truncated (more at offset ${offset + limit})` : undefined };
  } catch (e) {
    return { ok: false, error: `read failed: ${e instanceof Error ? e.message : e}` };
  }
}

/** Poll once and render the human/progress view (shared by poll tools). */
export function renderPoll(poll: PollResult, provider = 'provider'): string {
  if (poll.state === 'completed' && poll.response) {
    const { rec } = storeResponse(provider, poll.response, poll.markdown ?? null);
    return structuredCompact(rec, poll.response, 'completed');
  }
  let out = `Status: ${poll.state.toUpperCase()}\n`;
  if (poll.agentBrowsingUrl) out += `Browsing: ${poll.agentBrowsingUrl}\n`;
  if (poll.currentStep) out += `Current: ${poll.currentStep}\n`;
  if (poll.steps.length > 0) out += `\nSteps:\n${poll.steps.map((s) => `  • ${s}`).join('\n')}\n`;
  if (poll.state === 'working' || poll.state === 'streaming') {
    out += `\n[Use provider_stop to interrupt, or comet_screenshot to see current page]`;
  }
  return out;
}

/**
 * Generic ask-and-wait: send the prompt, poll until completed (or timeout), return the
 * outcome. Provider-neutral — the driver's open() handles tab targeting/navigation.
 *
 * P3: the session opened here is kept across ask+poll (the registry holds it; drivers
 * route CDP ops through the per-tab pool handle, so no per-poll reconnect). The poll
 * loop applies per-tab backoff + circuit breaking.
 */
export async function askAndWait(driver: ChatDriver, prompt: string, timeoutMs: number): Promise<AskOutcome> {
  const session: TabSession = await driver.open();
  return askAndWaitOn(driver, session, prompt, timeoutMs);
}

/**
 * P3 variant: ask-and-wait against an EXISTING registered session (tab-addressed).
 * The caller (MCP handler) resolves the tabId; this keeps the session open across
 * ask+poll with no reconnect, and applies per-tab backoff + circuit breaking.
 */
export async function askAndWaitOn(driver: ChatDriver, session: TabSession, prompt: string, timeoutMs: number, opts: { idempotencyKey?: string; sentAt?: string } = {}): Promise<AskOutcome> {
  const targetId = session.targetId;
  const sentAt = opts.sentAt ?? new Date().toISOString();
  // 2026-08-10 (user request): dispatch timestamp stamped into the wire prompt
  // for latency measurement — visible in the thread + carried on the outcome.
  const stampedPrompt = `${prompt}\n\n[prompt sent at ${sentAt}]`;
  prompt = stampedPrompt;

  // P1 Half 2 — replay guard FIRST: a recorded idempotencyKey means this logical send
  // already happened; return its prior outcome, never re-send (P1 gate replay-safety).
  const envelope = makeEnvelope(driver.provider, opts.idempotencyKey);
  const replayed = opts.idempotencyKey ? replayOutcomeIfRecorded(opts.idempotencyKey) : null;
  if (replayed) {
    return { ...replayed, correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey };
  }

  // durable lifecycle: envelope.created → send.queued
  recordEnvelopeCreated({ ...envelope, content: prompt });
  recordSendEvent({ ...envelope, content: prompt }, 'send.queued');

  // Snapshot the conversation state BEFORE sending so we can detect the NEW
  // response reliably (a follow-up in an existing thread already has prior text
  // in the DOM — "any text exists" is not "this turn completed").
  const before = await driver.poll(session);
  updateSessionAnchors(session, before);
  const beforeHash = before.contentHash ?? simpleHash(before.response);
  const beforeLen = before.response.length;

  const askReceipt = await driver.ask(session, prompt);
  recordSendEvent({ ...envelope, content: prompt }, askReceipt.receipt.status === 'sent' ? 'send.accepted' : 'send.unknown');

  const startTime = Date.now();
  const stepsCollected: string[] = [];
  let sawNewResponse = false;
  let last: PollResult | null = null;
  let prevHash: string | null = null; // for the stability window (fix 2026-08-07)
  let stableSince: number | null = null; // wall-clock start of the current stable hash
  let delay = POLL_BASE_MS;

  while (Date.now() - startTime < timeoutMs) {
    if (isCircuitOpen(targetId)) {
      // breaker open — surface degraded instead of hammering a failing tab
      last = await driver.poll(session).catch(() => null);
      if (last) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      return {
        completed: false,
        response: '',
        markdown: null,
        steps: stepsCollected,
        currentStep: '',
        status: 'degraded',
        agentBrowsingUrl: '',
        timedOut: true,
        correlationId: envelope.correlationId,
        idempotencyKey: envelope.idempotencyKey,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    let poll: PollResult;
    try {
      poll = await driver.poll(session);
      recordPollSuccess(targetId);
      updateSessionAnchors(session, poll);
      delay = pollDelayFor(targetId);
    } catch {
      const cooldown = recordPollFailure(targetId);
      if (cooldown > 0) {
        return {
          completed: false,
          response: '',
          markdown: null,
          steps: stepsCollected,
          currentStep: '',
          status: 'degraded',
          agentBrowsingUrl: '',
          timedOut: true,
          correlationId: envelope.correlationId,
          idempotencyKey: envelope.idempotencyKey,
        };
      }
      continue; // transient failure — backoff, retry
    }
    last = poll;
    for (const step of last.steps) {
      if (!stepsCollected.includes(step)) stepsCollected.push(step);
    }
    // NEW response = content hash changed OR text grew past the pre-send snapshot.
    // Do NOT latch on mere presence of text (prior turns already have text).
    const hash = last.contentHash ?? simpleHash(last.response);
    if (last.response.length > 0 && (hash !== beforeHash || last.response.length > beforeLen)) {
      sawNewResponse = true;
    }
    // COMPLETED requires stability: the response hash must be unchanged for
    // MIN_COMPLETION_STABILITY_MS of wall-clock time. A single 'completed' reading
    // can catch the DOM mid-render (the "Worked for Xs" marker appears while the
    // answer is still appending — observed live: latched 1592 chars of a 10205-char
    // Grok answer after two identical 2s-apart readings caught a mid-stream pause).
    if (last.state === 'completed' && sawNewResponse) {
      const { complete, stableSince: nextSince } = completionStability(hash, prevHash, stableSince, Date.now());
      stableSince = nextSince;
      if (complete) {
        const outcome: AskOutcome = {
        completed: true,
        response: last.response || 'Task completed (no response text extracted)',
        markdown: last.markdown ?? null,
        steps: stepsCollected,
        currentStep: last.currentStep,
        status: last.state,
        agentBrowsingUrl: last.agentBrowsingUrl,
        timedOut: false,
        sentAt: opts.sentAt,
        correlationId: envelope.correlationId,
        idempotencyKey: envelope.idempotencyKey,
      };
      // durable: response.received (+ cursor checkpoint) → delivery.receipt completed.
      // P3 reconnect-dedup gate: if this correlation ALREADY recorded this exact
      // content hash (reconnect resumed an ask whose response was already logged),
      // record response.deduplicated instead — NO new response event for unchanged
      // content. The client still gets the answer; the log stays truthful.
      const alreadyRecorded = hasResponseHash(envelope.correlationId, hash);
      const responseEv = alreadyRecorded
        ? recordResponseDeduplicated(
            { ...envelope, content: prompt },
            driver.provider,
            {
              messageId: last.messageId,
              contentHash: hash,
              cursor: last.cursor ?? hash,
              state: last.state,
              text: outcome.response,
              steps: stepsCollected,
            },
          )
        : recordResponseReceived(
            { ...envelope, content: prompt },
            driver.provider,
            {
              messageId: last.messageId,
              contentHash: hash,
              cursor: last.cursor ?? hash, // durable extraction cursor (P3 reconnect-dedup)
              state: last.state,
              text: outcome.response,
              steps: stepsCollected,
            },
            targetId,
          );
      recordDeliveryReceipt({
        receiptId: `rct-${responseEv.seq}`, // one receipt per attempt, append-only
        envelopeId: envelope.idempotencyKey,
        correlationId: envelope.correlationId,
        idempotencyKey: envelope.idempotencyKey,
        status: 'completed',
        recordedAt: new Date().toISOString(),
        attempt: 1,
        contentHash: hash,
        providerMessageId: last.messageId,
        cursor: last.cursor ?? hash,
        details: alreadyRecorded ? 'reconnect-dedup: content already recorded for this correlation' : undefined,
      });
      return alreadyRecorded ? { ...outcome, deduped: true } : outcome;
      }
    }
    prevHash = hash;
  }

  const final = last ?? await driver.poll(session);
  const timedOut: AskOutcome = {
    completed: false,
    response: '',
    markdown: null,
    steps: stepsCollected,
    currentStep: final.currentStep,
    status: final.state,
    agentBrowsingUrl: final.agentBrowsingUrl,
    timedOut: true,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
  };
  recordSendEvent({ ...envelope, content: prompt }, 'send.timed_out');
  recordDeliveryReceipt({
    receiptId: `rct-${Date.now().toString(36)}`,
    envelopeId: envelope.idempotencyKey,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    status: 'timed_out',
    recordedAt: new Date().toISOString(),
    attempt: 1,
  });
  return timedOut;
}

/** Render the "still in progress" view (preserves comet_ask's message shape).
 * 2026-08-08 (four-opinion design): honest states — 'timed_out' is a SOFT expiry
 * (the ask is still watched and recoverable), 'watching' means the client
 * deadline passed but the tab keeps running, 'abandoned' is the hard-TTL end. */
export function renderInProgress(outcome: AskOutcome, useCometNames = false): string {
  const stop = useCometNames ? 'comet_stop' : 'provider_stop';
  const poll = useCometNames ? 'comet_poll' : 'provider_poll';
  if (outcome.status === 'reminder_sent') {
    return `Model reply missing the required status line — a bounded reminder was injected asking for it. Re-polling…\nStatus: REMINDER_SENT\n\nUse ${poll} to continue (the model's next reply should carry the status line).`;
  }
  if (outcome.status === 'timed_out') {
    return `Ask deadline expired — soft expiry, still watching the tab for a late completion.\nStatus: TIMED_OUT (watching)\n\nUse ${poll} again to recover the answer if it lands late, or ${stop} to cancel.`;
  }
  if (outcome.status === 'watching') {
    return `Client poll deadline reached — background task still running. Retrying poll…\nStatus: WATCHING\n\nUse ${poll} to retry, or ${stop} to cancel.`;
  }
  if (outcome.status === 'abandoned') {
    return `Ask abandoned — hard TTL (${Math.round(HARD_TTL_MS / 60000)} min) reached without completion.\nStatus: ABANDONED`;
  }
  if (outcome.status === 'tab_closed') {
    return `Provider tab closed or went offline — the ask cannot complete.\nStatus: TAB_CLOSED\n\nReopen the provider tab and re-ask if needed.`;
  }
  let msg = `Task in progress (${outcome.steps.length} steps so far).\n`;
  msg += `Status: ${outcome.status.toUpperCase()}\n`;
  if (outcome.currentStep) msg += `Current: ${outcome.currentStep}\n`;
  if (outcome.agentBrowsingUrl) msg += `Browsing: ${outcome.agentBrowsingUrl}\n`;
  if (outcome.steps.length > 0) msg += `\nSteps:\n${outcome.steps.map((s) => `  • ${s}`).join('\n')}\n`;
  msg += `\nUse ${poll} to check progress or ${stop} to cancel.`;
  return msg;
}

// ---------------------------------------------------------------------------
// Async ask registry (2026-08-07) — gateway-timeout survival
// ---------------------------------------------------------------------------
// The pi MCP gateway caps the RPC round-trip (~150s); a long provider ask that
// blocks inside askAndWaitOn can be abandoned by the gateway (-32001) mid-ask,
// stranding the prompt in the composer (observed live: review prompt typed but
// never submitted, tab left dirty). The file-backed response store only helps
// AFTER completion — it never solved the RPC-window problem.
//
// Fix: split ask into dispatch (fire-and-forget, returns immediately) + advance
// (one poll step, driven by provider_poll). The ask lifecycle (envelope, 8s
// stability window, dedup, receipt) runs server-side across polls; the client
// never holds the RPC open. provider_poll advances the registered ask and, on
// completion, stores the response (fetched via provider_response).

interface PendingAsk {
  driver: ChatDriver;
  session: TabSession;
  prompt: string;
  envelope: ConversationEnvelope;
  beforeHash: string;
  beforeLen: number;
  startTime: number;
  timeoutMs: number;
  /** 2026-08-08 (late reconciliation): 'active' until the ask budget expires, then 'watching'.
   * Expiry is NON-destructive — the key stays so a late CDP answer can be reunited. */
  phase: 'active' | 'watching';
  stepsCollected: string[];
  sawNewResponse: boolean;
  last: PollResult | null;
  prevHash: string | null;
  stableSince: number | null;
  /**
   * ADR 0010 (sentinel completion marker): when set, the prompt asked the model
   * to end its response with this exact random string. Its presence at the end
   * of a completed poll ⇒ authoritative completion (hash-confirmed, timer-free).
   * Absent (non-compliant model) ⇒ falls back to the provider's heuristic/weak.
   */
  sentinel?: string;
  /**
   * ADR 0011: true once the status-line reminder has been injected for a
   * non-compliant reply. Bounded — one reminder per ask, then fall back.
   */
  reminderSent?: boolean;
  /**
   * 2026-08-10 (live council test): the lineless response captured BEFORE the
   * reminder was injected. The reminder's own reply is often a BARE status
   * line (the model was told to reply with only the line) which the driver's
   * last-element scoping reads as the current turn — stitching the
   * pre-reminder answer back in keeps the delivered response the real answer
   * (plus the line), never just the reminder turn.
   */
  preReminderResponse?: string;
  /**
   * 2026-08-10 (live council test): whether the driver VERIFIED the prompt
   * actually submitted (e.g. grok composer emptied). False ⇒ never enter the
   * compliance/reminder loop (a phantom send must not trigger a reminder).
   */
  sendVerified: boolean;
  /**
   * 2026-08-10 (user request): ISO dispatch timestamp stamped into the wire
   * prompt — latency measurement (sent vs status-line vs response.received).
   */
  sentAt?: string;
}

/**
 * Hard-TTL bound for the pending-ask registry (2026-08-08, Claude/Grok design):
 * the reaper purges entries older than this regardless of client polling — sized
 * against the longest realistic generation (Perplexity research, multi-step
 * agents) plus margin (Grok sizing guidance; 30 min reasonable start).
 */
export const HARD_TTL_MS = 30 * 60 * 1000;
/** Reaper cadence — wall-clock sweep, independent of any client ever polling again. */
export const REAPER_INTERVAL_MS = 60 * 1000;

const pendingAsks = new Map<string, PendingAsk>();

/**
 * 2026-08-10 (user report): the status-line instruction is a THREAD CONVENTION —
 * it must be injected ONCE per tab (first completionMarker ask), not re-sent with
 * every prompt. This maps each tab (targetId) to the session sentinel established
 * on its first ask; later asks in the same tab reuse it for detection without
 * re-broadcasting the instruction. Reminders still cover non-compliance.
 */
const sessionSentinels = new Map<string, string>();

// 2026-08-10 (perplexity live bug): a tab reset navigates to a FRESH thread, so
// the thread-convention sentinel is dead — clear it. The next completionMarker
// ask must re-inject the status-line instruction (first-in-tab) instead of being
// sent raw and tripping the ADR 0011 reminder on a tokenless completion.
tabRegistry.onReset((targetId) => {
  sessionSentinels.delete(targetId);
});

/**
 * Reset the pending-ask registry (tests only). The advancer/reminder tests
 * share this module singleton across tests in a file — leftover pending asks
 * (e.g. reminder_sent states) would otherwise be swept by a later test's
 * advancePendingAsks call, corrupting its age-guard assertions.
 */
export function _resetPendingForTests(): void {
  pendingAsks.clear();
  lastDispatched.clear();
  advancingKeys.clear();
  sessionSentinels.clear();
}

/** Key a pending ask by idempotencyKey (replay-safe) or correlationId. */
function askKey(envelope: ConversationEnvelope): string {
  return envelope.idempotencyKey;
}

/** Last dispatched ask key per provider (for provider_poll to advance). */
const lastDispatched = new Map<string, string>();

/** The most recent dispatched-ask key for a provider ('' when none). */
export function lastDispatchedFor(provider: string): string {
  return lastDispatched.get(provider) ?? '';
}

/**
 * Dispatch an ask and return immediately. Records the durable lifecycle up to
 * send.accepted; the client polls via provider_poll to advance/completing.
 * Returns { correlationId, idempotencyKey, status }.
 */
export async function dispatchAsk(
  driver: ChatDriver,
  session: TabSession,
  prompt: string,
  opts: { idempotencyKey?: string; timeoutMs?: number; completionMarker?: boolean } = {},
): Promise<{ correlationId: string; idempotencyKey: string; status: string; replayed?: boolean }> {
  const envelope = makeEnvelope(driver.provider, opts.idempotencyKey);
  const replayed = opts.idempotencyKey ? replayOutcomeIfRecorded(opts.idempotencyKey) : null;
  if (replayed) {
    return { correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey, status: 'completed', replayed: true };
  }

  // ADR 0012 (2026-08-10, user-validated): the status line is a platform
  // Custom Instruction set up manually per provider. The MODEL generates the
  // full status line INCLUDING its own 10-char code — we do NOT control what
  // the code is, we only DETECT the line at the end of the reply (any "Turn …
  // | … | <10-char token>" line = the completionMarker triggered). No sentinel
  // is generated, no code tag is injected, no session sentinel is tracked —
  // the ask goes out raw (plus the dispatch timestamp). completionMarker:true
  // simply enables status-line detection + the bounded reminder for providers
  // that have the Custom Instruction set up (completionMarker:false ⇒ ask sent
  // raw, no reminder, native-signal completion only).
  const markerWanted = opts.completionMarker === true
    && loadEntry(driver.provider)?.driver?.completionMarker !== false;
  // 2026-08-10 (user request): stamp the DISPATCH time into the wire prompt so
  // generation + completion-detection latency are measurable end-to-end —
  // prompt-sent time (here) vs status-line time (model's own clock) vs
  // response.received (detection). Visible in the thread and the event store.
  const sentAt = new Date().toISOString();
  // 2026-08-10 (user directive, ADR 0012): the FULL status-line instruction is
  // an ADR 0012 Custom Instruction set up manually per platform (project level
  // ADR 0012 (2026-08-10, user-validated): the status-line format is a
  // platform Custom Instruction — the driver never injects it. The ask goes
  // out RAW (plus the dispatch timestamp). The MODEL generates the status line
  // with its own code; we detect it at completion.
  const wirePrompt = `${prompt}\n\n[prompt sent at ${sentAt}]`;

  // durable lifecycle: envelope.created → send.queued → snapshot → ask → accepted
  recordEnvelopeCreated({ ...envelope, content: wirePrompt });
  recordSendEvent({ ...envelope, content: wirePrompt }, 'send.queued');
  const before = await driver.poll(session);
  updateSessionAnchors(session, before);
  const beforeHash = before.contentHash ?? simpleHash(before.response);
  const beforeLen = before.response.length;
  const askReceipt = await driver.ask(session, wirePrompt);
  const sendVerified = askReceipt.receipt.status === 'sent';
  recordSendEvent({ ...envelope, content: wirePrompt }, sendVerified ? 'send.accepted' : 'send.unknown');

  pendingAsks.set(askKey(envelope), {
    driver, session, prompt: wirePrompt, envelope,
    beforeHash, beforeLen,
    startTime: Date.now(),
    sentAt,
    // 2026-08-08: default ask budget is a CLIENT-VISIBLE UX knob (when the client
    // first sees a deadline) — correctness lives in the non-destructive expiry
    // (advanceAsk soft-transition), not in this number.
    timeoutMs: opts.timeoutMs ?? 120000,
    phase: 'active',
    stepsCollected: [], sawNewResponse: false,
    last: null, prevHash: null, stableSince: null,
    sendVerified,
  });
  lastDispatched.set(driver.provider, askKey(envelope));
  return { correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey, status: 'in_progress' };
}

/**
 * Advance a dispatched ask by ONE poll step (called from provider_poll).
 * Returns the AskOutcome: completed (response stored + receipt recorded) when the
 * stability window holds; timedOut when the ask budget expires (SOFT expiry — the
 * entry stays 'watching' so a late CDP answer can still be recovered and recorded
 * as completed_late, 2026-08-08 four-opinion design); otherwise the in-progress
 * view. The pending entry is removed on completion or by the reaper (hard TTL).
 */
export async function advanceAsk(key: string): Promise<AskOutcome | null> {
  const p = pendingAsks.get(key);
  if (!p) return null;
  const { driver, session, envelope } = p;
  const targetId = session.targetId;

  // One-shot soft-expiry transition (Claude/Grok: fire timed_out EXACTLY once —
  // the elapsed >= timeoutMs check would otherwise re-fire on every later poll).
  // Non-destructive: the key is retained in 'watching' for late recovery.
  let justExpired = false;
  if (p.phase === 'active' && Date.now() - p.startTime >= p.timeoutMs) {
    p.phase = 'watching';
    justExpired = true;
    recordSendEvent({ ...envelope, content: p.prompt }, 'send.timed_out');
    recordDeliveryReceipt({
      receiptId: `rct-${Date.now().toString(36)}`,
      envelopeId: envelope.idempotencyKey,
      correlationId: envelope.correlationId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'timed_out', recordedAt: new Date().toISOString(), attempt: 1,
    });
  }

  // Watchdog guard: a watching entry past the hard TTL is dead — the reaper
  // sweeps these on a wall clock; guard here so a very-late poll cannot finalize.
  if (p.phase === 'watching' && Date.now() - p.startTime >= HARD_TTL_MS) {
    pendingAsks.delete(key);
    recordDeliveryReceipt({
      receiptId: `rct-${Date.now().toString(36)}`,
      envelopeId: envelope.idempotencyKey,
      correlationId: envelope.correlationId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'abandoned', recordedAt: new Date().toISOString(), attempt: 1,
      details: 'hard TTL reached without completion',
    });
    return {
      completed: false, response: '', markdown: null, steps: p.stepsCollected,
      currentStep: '', status: 'abandoned',
      agentBrowsingUrl: '', timedOut: true,
      correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey,
    };
  }

  let poll: PollResult;
  try {
    poll = await driver.poll(session);
    recordPollSuccess(targetId);
    updateSessionAnchors(session, poll);
  } catch {
    recordPollFailure(targetId);
    // 2026-08-08 (closed-window hang, user-reported): if the pooled session is
    // dead — the tab was closed OUTSIDE the bridge (browser-side) — escalate to a
    // terminal TAB_CLOSED state instead of treating it as a transient poll
    // failure and watching a dead target forever.
    const handle = sessionPool.get(targetId);
    const alive = handle ? await handle.isHealthy().catch(() => false) : false;
    if (!alive) {
      pendingAsks.delete(key);
      recordSendEvent({ ...envelope, content: p.prompt }, 'send.blocked');
      recordDeliveryReceipt({
        receiptId: `rct-${Date.now().toString(36)}`,
        envelopeId: envelope.idempotencyKey,
        correlationId: envelope.correlationId,
        idempotencyKey: envelope.idempotencyKey,
        status: 'blocked', recordedAt: new Date().toISOString(), attempt: 1,
        details: 'provider tab closed/offline — ask cannot complete',
      });
      return {
        completed: false, response: '', markdown: null, steps: p.stepsCollected,
        currentStep: '', status: 'tab_closed',
        agentBrowsingUrl: '', timedOut: true,
        correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey,
      };
    }
    return null; // transient — keep pending, client retries poll
  }
  p.last = poll;
  for (const step of poll.steps) if (!p.stepsCollected.includes(step)) p.stepsCollected.push(step);
  // ADR 0012 (2026-08-10, user directive): the completionMarker is the STATUS
  // LINE the model generates per its platform Custom Instruction, including
  // the model's OWN 10-char code — we do NOT control what the code is, we only
  // DETECT the line (parseStatusLineShape in the gate below). The model's code
  // is kept as-is in the response (provenance: which model, when) — there is
  // no pre-known sentinel to strip. Shape-compliant line = the completionMarker
  // triggered.
  const hash = simpleHash(poll.response);
  if (poll.response.length > 0 && (hash !== p.beforeHash || poll.response.length > p.beforeLen)) {
    // 2026-08-10: sawNewResponse means the response text changed since dispatch.
    // The current-turn prose scoping (perplexity driver) already prevents a
    // follow-up ask from reading the PREVIOUS turn as "new"; the hasResponseHash
    // dedup at finalize prevents re-recording. A session-level deliveredHash
    // guard here is WRONG: after the first completed poll stores the answer
    // hash into session.lastContentHash, the next poll with the same content
    // compares equal and sawNewResponse never fires again → the ask stuck
    // WATCHING forever with the answer on screen (live bug 2026-08-10).
    p.sawNewResponse = true;
  }

  // 2026-08-10 (user rule): the completion gate must NOT depend on
  // poll.state === 'completed'. That label is driver state-detection output
  // (UI markers, stop button) — it can fail (returns idle/working) while the
  // answer + status line are fully rendered. Gating the fallbacks on it meant
  // a state-detection failure hung the ask forever: the stability window,
  // hash-confirm, and bounded reminder were unreachable. CONTENT decides
  // completion, not the label: the sentinel/shape check + stability window
  // below are the real gates, and they work regardless of poll.state.
  // DEBUG SWITCH (2026-08-10, user request): COMET_STRICT_COMPLETION_GATE=1
  // restores the original poll.state==='completed' requirement — set it to
  // reproduce/diagnose the underlying state-detection bug in isolation (the
  // fallback would otherwise mask it). Read ONCE at module load: a per-call
  // read is racy under node's concurrent test runner (test files share the
  // process env) and let one file's toggle leak into another's assertions.
  const strictGate = STRICT_COMPLETION_GATE;
  if ((strictGate ? poll.state === 'completed' : true) && p.sawNewResponse) {
    const confidence = poll.completionConfidence ?? 'weak';
    // 2026-08-10 (user directive, ADR 0012): the completion signal is a 10-char
    // alphanumeric token at the VERY END of the model's reply — NOTHING else.
    // The model generates it per its platform Custom Instruction; we DETECT it,
    // we do not control or verify its value. hasTrailingToken ⇒ the
    // completionMarker triggered — authoritative, no stability window, no hash
    // wait, regardless of confidence or poll.state.
    const tokenPresent = hasTrailingToken(poll.response);
    let complete: boolean;
    if (tokenPresent) {
      complete = true;
    } else if (confidence === 'authoritative') {
      // NON-marker native markers (grok "Worked for Xs", perplexity
      // follow-up) keep hash confirmation AND require a prior poll
      // (prevHash !== null): grok renders the timing line at the START of the
      // message while the answer streams below, so a marker on the first poll
      // must NOT complete mid-stream (2026-08-10 live bug).
      complete = p.prevHash !== null && hash === p.prevHash;
    } else {
      // completionMarker ask with NO trailing token yet: wait for COMPLETION —
      // the DRIVER's verdict (state completed) hash-confirmed against the
      // prior poll (settle check, no stability window).
      complete = poll.state === 'completed'
        && p.prevHash !== null && hash === p.prevHash;
    }
    // 2026-08-10 (user rule): the reminder fires when the ask completed (driver
    // verdict) but the model's reply lacks the trailing 10-char token — it
    // skipped the completion signal. ONE bounded reminder using the
    // user-validated soft phrasing.
    if (complete && !tokenPresent && !p.reminderSent && p.sendVerified) {
      p.reminderSent = true;
      p.preReminderResponse = poll.response;
      recordSendEvent({ ...envelope, content: p.prompt }, 'send.queued');
      await driver.ask(session, statusLineReminder('', driver.provider));
      return {
        completed: false, response: '', markdown: null, steps: p.stepsCollected,
        currentStep: '', status: 'reminder_sent',
        agentBrowsingUrl: '', timedOut: false,
        correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey,
      };
    }
    if (complete) {
      // 2026-08-10 (user rule): for completionMarker asks the code is the
      // completion contract — the reminder path above is the ONLY place a
      // lineless reply can escalate, and it happens BEFORE finalize. Reaching
      // here means the reply carries the sentinel/shape (or the bounded
      // fallback after one reminder) — no separate compliance loop needed.
      pendingAsks.delete(key);
      const wasLate = p.phase === 'watching';
      // 2026-08-10 (reminder turn leak, live test): after a reminder the model
      // replies with ONLY the status line, and the driver's current-turn
      // scoping (last prose element) reads that bare line as the answer — the
      // real answer (preReminderResponse) would be lost. Stitch: if the final
      // response is just a status line (no substantive answer text), prepend
      // the pre-reminder answer so the delivered response is answer + line.
      let finalResponse: string;
      if (p.reminderSent && p.preReminderResponse
        && isBareStatusLine(poll.response) && !poll.response.includes(p.preReminderResponse)) {
        const stitched = `${p.preReminderResponse.trimEnd()}\n\n${lastStatusLine(poll.response)}`;
        // 2026-08-10 (ADR 0012): the line carries the MODEL's own code (we
        // don't control it) — preserved as provenance; nothing to strip
        finalResponse = stitched;
      } else {
        finalResponse = poll.response;
      }
      const outcome: AskOutcome = {
        completed: true,
        response: finalResponse || 'Task completed (no response text extracted)',
        markdown: poll.markdown ?? null,
        steps: p.stepsCollected,
        currentStep: poll.currentStep,
        status: poll.state,
        agentBrowsingUrl: poll.agentBrowsingUrl,
        timedOut: false,
        late: wasLate,
        sentAt: p.sentAt,
        correlationId: envelope.correlationId,
        idempotencyKey: envelope.idempotencyKey,
      };
      // 2026-08-10: when the reminder turn was stitched into the answer, the
      // durable contentHash must match the STORED text (hash-binding invariants:
      // relay prepare hashes the exact envelope content, dedup keys on the hash).
      const recordHash = finalResponse !== poll.response ? simpleHash(outcome.response) : hash;
      // durable: response.received (+ cursor checkpoint) → delivery.receipt
      // completed (normal) or completed_late (recovered after soft expiry).
      // ADR 0009 follow-up: if this content is a same-prefix GROWTH of an already
      // recorded terminal response (early authoritative finalize, content kept
      // streaming), record response.amended instead of a second response.received.
      const alreadyRecorded = hasResponseHash(envelope.correlationId, recordHash);
      const amended = !alreadyRecorded
        ? recordResponseAmended({ ...envelope, content: p.prompt }, driver.provider, {
            messageId: poll.messageId, contentHash: recordHash, cursor: poll.cursor ?? recordHash,
            state: poll.state, text: outcome.response, steps: p.stepsCollected,
          })
        : null;
      const responseEv = amended
        ?? (alreadyRecorded
          ? recordResponseDeduplicated({ ...envelope, content: p.prompt }, driver.provider, {
              messageId: poll.messageId, contentHash: recordHash, cursor: poll.cursor ?? recordHash,
              state: poll.state, text: outcome.response, steps: p.stepsCollected,
            })
          : recordResponseReceived({ ...envelope, content: p.prompt }, driver.provider, {
              messageId: poll.messageId, contentHash: recordHash, cursor: poll.cursor ?? recordHash,
              state: poll.state, text: outcome.response, steps: p.stepsCollected,
            }, targetId));
      recordDeliveryReceipt({
        receiptId: `rct-${responseEv.seq}`, envelopeId: envelope.idempotencyKey,
        correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey,
        status: wasLate ? 'completed_late' : 'completed', recordedAt: new Date().toISOString(), attempt: 1,
        contentHash: recordHash, providerMessageId: poll.messageId, cursor: poll.cursor ?? recordHash,
        details: alreadyRecorded ? 'reconnect-dedup: content already recorded for this correlation' : (wasLate ? 'recovered after soft expiry' : undefined),
      });
      return alreadyRecorded ? { ...outcome, deduped: true } : outcome;
    }
  }
  p.prevHash = hash;
  // 2026-08-07 (async-ask bug): when the tab shows a COMPLETED response but the
  // stability window is still confirming, report status='confirming' instead of
  // leaking poll.state='completed' — the previous output said "Task in progress …
  // Status: COMPLETED", which is contradictory and hid that the response was
  // actually received. The client polls again; the next advance finalizes.
  // 2026-08-08: after soft expiry, a non-complete advance reports 'watching' — a
  // genuinely distinct status so the render layer can be honest (Claude/Grok).
  const confirming = poll.state === 'completed' && p.sawNewResponse;
  return {
    completed: false, response: '', markdown: null, steps: p.stepsCollected,
    currentStep: poll.currentStep,
    // The transition poll reports the deadline itself (once); later watching
    // polls report the distinct 'watching' status (Claude/Grok honest render).
    status: justExpired && !confirming ? 'timed_out'
      : confirming ? 'confirming'
      : (p.phase === 'watching' ? 'watching' : poll.state),
    agentBrowsingUrl: poll.agentBrowsingUrl, timedOut: justExpired,
    correlationId: envelope.correlationId, idempotencyKey: envelope.idempotencyKey,
  };
}

/**
 * Reaper sweep body (2026-08-08, Claude/Grok design): purge entries past
 * HARD_TTL_MS and record an 'abandoned' receipt — runs on a wall clock, NOT on
 * client polling (an abandoned ask is by definition never polled again).
 * `now` is injectable for tests. Returns the number of entries purged.
 */
export function reapExpired(now: number = Date.now()): number {
  let purged = 0;
  for (const [key, p] of pendingAsks) {
    if (now - p.startTime >= HARD_TTL_MS) {
      pendingAsks.delete(key);
      recordDeliveryReceipt({
        receiptId: `rct-${Date.now().toString(36)}`,
        envelopeId: p.envelope.idempotencyKey,
        correlationId: p.envelope.correlationId,
        idempotencyKey: p.envelope.idempotencyKey,
        status: 'abandoned', recordedAt: new Date().toISOString(), attempt: 1,
        details: 'abandoned by reaper (hard TTL)',
      });
      purged++;
    }
  }
  return purged;
}

let reaperStarted = false;
/** Start the poll-independent reaper interval (idempotent). unref'd so tests/CLI can exit. */
export function startReaper(): void {
  if (reaperStarted) return;
  reaperStarted = true;
  const timer = setInterval(() => { reapExpired(); }, REAPER_INTERVAL_MS);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
}

// ---------------------------------------------------------------------------
// 2026-08-09 (user-requested latency fix): fast internal advance timer.
// The client learns completion only by polling; a slow client leaves a finished
// ask sitting. This sweeps pending asks on a SHORT wall clock (like the reaper
// but advancing instead of purging) so asks finalize between client polls — the
// client's next provider_poll is a pure read of an already-completed ask.
// ---------------------------------------------------------------------------

/** Advance cadence — short enough to feel immediate, long enough to not hammer CDP. */
export const ADVANCE_INTERVAL_MS = 1500;
/** Skip asks younger than this — the dispatch→submit window (don't race driver.ask). */
export const ADVANCE_MIN_AGE_MS = 1500;
/** Per-tick cap — at most this many CDP polls per sweep (thundering-herd guard). */
export const ADVANCE_MAX_PER_TICK = 4;

let advancerStarted = false;
let advancerTimer: NodeJS.Timeout | undefined;

/**
 * Sweep body: advance up to ADVANCE_MAX_PER_TICK pending asks older than
 * ADVANCE_MIN_AGE_MS. Skips in-flight keys (advanceAsk is async — a concurrent
 * poll would corrupt prevHash/stableSince bookkeeping). Returns advances done.
 * `now` injectable for tests.
 */
export async function advancePendingAsks(now: number = Date.now()): Promise<number> {
  let advanced = 0;
  for (const key of pendingAsks.keys()) {
    if (advanced >= ADVANCE_MAX_PER_TICK) break;
    const p = pendingAsks.get(key);
    if (!p) continue;
    if (now - p.startTime < ADVANCE_MIN_AGE_MS) continue; // dispatch→submit window
    if (advancingKeys.has(key)) continue; // already in flight
    advancingKeys.add(key);
    try {
      await advanceAsk(key); // finalizes + removes the entry when complete
    } catch {
      /* transient poll failure — advanceAsk handles tab-closed itself; keep sweeping */
    } finally {
      advancingKeys.delete(key);
    }
    advanced++;
  }
  return advanced;
}

/** Keys currently being advanced by the timer (re-entrancy guard). */
const advancingKeys = new Set<string>();

/** Start the fast advance interval (idempotent). unref'd so tests/CLI can exit. */
export function startAdvancer(): void {
  if (advancerStarted) return;
  advancerStarted = true;
  advancerTimer = setInterval(() => { void advancePendingAsks(); }, ADVANCE_INTERVAL_MS);
  if (typeof (advancerTimer as any).unref === 'function') (advancerTimer as any).unref();
}

/** Stop the advance interval (tests). */
export function stopAdvancer(): void {
  if (advancerTimer) clearInterval(advancerTimer);
  advancerTimer = undefined;
  advancerStarted = false;
}

/** True when a dispatched ask is still pending for this key. */
export function isAskPending(key: string): boolean {
  return pendingAsks.has(key);
}

/** List pending ask keys (diagnostics). */
export function listPendingAsks(): string[] {
  return [...pendingAsks.keys()];
}

/**
 * 2026-08-09 latency fix: the pending-ask KEY for a correlation, or '' when none.
 * Keys are envelope idempotencyKeys; this scans the pending registry by
 * correlationId so relay_prepare can auto-advance the source ask without the
 * client round-trip.
 */
export function pendingKeyForCorrelation(correlationId: string): string {
  for (const [key, p] of pendingAsks) {
    if (p.envelope.correlationId === correlationId) return key;
  }
  return '';
}
