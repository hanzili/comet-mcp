/**
 * P4 R4 — relay orchestration (provider-neutral; grows across R4→R7).
 *
 * R4 scope (design 05 §3.4): relay_prepare — select a terminal-success source
 * event (completed / completed_late — §1.5: never watching/abandoned), build +
 * canonicalize + hash the relay envelope (R1), run eager policy checks (R3),
 * return envelope + policy evaluation + approvalRequired + approvalHash. NO
 * contact with the destination.
 *
 * The relay chain is ONE correlation, many envelopes (types/conversation.ts
 * ConversationEnvelope.correlationId doc). The prepared envelope's
 * idempotencyKey is fresh per logical send; the envelopeHash is stable across
 * re-prepares because R1 deliberately excludes idempotencyKey/correlationId/
 * createdAt from canonicalization — the same source+destination+policy always
 * yields the same approval hash.
 */

import type { ContentPersistenceMode, ConversationEnvelope, ConversationEvent, DeliveryReceipt, ProviderId, RelayControls } from '../types/conversation.js';
import { computeEnvelopeHash, canonicalizeEnvelope } from './envelope.js';
import { evaluateRelayPolicy, neutralizeMarkdown, type RelayPolicyEvaluation } from './relay-policy.js';
import {
  eventsForCorrelation,
  receiptsForCorrelation,
  recordEnvelopeCreated,
  recordRelayApproval,
  recordDeliveryReceipt,
  resolveContentPersistenceMode,
  getRelayApproval,
  consumeRelayApproval,
} from './event-store.js';

/** A relay source: the terminal-success provider response being relayed. */
export interface RelaySource {
  correlationId: string;
  sourceProvider: ProviderId;
  sourceMessageId?: string;
  sourceContentHash: string;
  /** Full response text — only available when the source event persisted it. */
  content: string;
  /** 'completed' (poll state) — terminal-success per §1.5. */
  state: string;
  cursor?: string;
}

/**
 * Find the terminal-success source for a correlation. §1.5: relay consumes only
 * completed / completed_late — never watching/abandoned. Returns null when no
 * terminal-success response exists (client must finish/verify the ask first).
 */
export function findRelaySource(correlationId: string): RelaySource | null {
  const evs = eventsForCorrelation(correlationId);
  // newest response event (received or deduplicated — same content, no new send)
  const resp = [...evs].reverse().find(
    (e) => e.type === 'response.received' || e.type === 'response.deduplicated',
  );
  if (!resp?.response) return null;
  const receipts = receiptsForCorrelation(correlationId);
  const latest = [...receipts].reverse().find((r) => r.receiptStatus !== undefined);
  const terminal =
    resp.response.poll.state === 'completed' ||
    latest?.receiptStatus === 'completed' ||
    latest?.receiptStatus === 'completed_late';
  if (!terminal) return null; // watching / abandoned / timed_out — not relayable
  return {
    correlationId,
    sourceProvider: resp.response.provider,
    sourceMessageId: resp.response.messageId,
    sourceContentHash: resp.response.contentHash,
    content: resp.response.poll.response,
    state: resp.response.poll.state,
    cursor: resp.response.cursor,
  };
}

/** Inputs to relay_prepare (R4). destination + attribution are the hard ones. */
export interface RelayPrepareInput {
  /** Correlation of the terminal-success source response (the ask to relay). */
  sourceCorrelationId: string;
  destination: ProviderId;
  /** Mandatory in approval-required mode — fail closed if unset (§3.3). */
  attributionHeader?: string;
  contentSizeLimitBytes?: number;
  /** Approval/relay deadline (epoch ms). */
  deadlineMs?: number;
  maxRelaysPerCorrelation?: number;
  /** Opt-in raw markdown pass-through (default false = neutralize structure). */
  rawMarkdown?: boolean;
  contentPersistenceMode?: ContentPersistenceMode;
}

/** Successful prepare result (R4). */
export interface RelayPrepareResult {
  ok: true;
  /** The relay chain's correlation (== source correlation per §correlation doc). */
  correlationId: string;
  idempotencyKey: string;
  envelope: ConversationEnvelope;
  canonical: string;
  envelopeHash: string;
  approvalRequired: boolean;
  evaluation: RelayPolicyEvaluation;
}

export interface RelayPrepareError {
  ok: false;
  error: string;
  /** Set when policy evaluation failed — the reason is machine-checkable. */
  policyReason?: RelayPolicyEvaluation['reason'];
  evaluation?: RelayPolicyEvaluation;
  /** 2026-08-09 latency fix: how many source-advance steps were attempted before giving up. */
  advancedSteps?: number;
}

/** Relay policy defaults for a prepared envelope (R3 defaults + mandatory enablement). */
function buildRelayControls(input: RelayPrepareInput): RelayControls {
  return {
    mode: 'approval-required',
    approved: false, // approval comes from relay_approve (R5)
    destinationEnabled: true, // the client explicitly named this destination
    attributionHeader: input.attributionHeader,
    contentSizeLimitBytes: input.contentSizeLimitBytes,
    deadlineMs: input.deadlineMs,
    maxRelaysPerCorrelation: input.maxRelaysPerCorrelation,
    rawMarkdown: input.rawMarkdown,
    contentPersistenceMode: input.contentPersistenceMode,
  };
}

/**
 * R4: prepare a relay. Selects the terminal-success source, builds + canonicalizes
 * + hashes the envelope, runs eager policy checks. NEVER contacts the destination.
 *
 * 2026-08-09 latency fix (consult fold #4): when `deps.advanceSource` is provided
 * (the tool layer wires it to advanceAsk), a PENDING source ask is advanced up to
 * MAX_RELAY_ADVANCE_STEPS times, bounded by a wall-clock budget, so a just-finished
 * source is relayable immediately without a client round-trip. Only the SOURCE is
 * ever advanced — never the destination, no new turns opened.
 */
export async function prepareRelay(
  input: RelayPrepareInput,
  deps: { advanceSource?: () => Promise<void>; isSourcePending?: () => boolean } = {},
): Promise<RelayPrepareResult | RelayPrepareError> {
  // bounded auto-advance of a pending source ask (consult fold #4)
  let advancedSteps = 0;
  if (deps.advanceSource && deps.isSourcePending && !findRelaySource(input.sourceCorrelationId)) {
    const budget = { wallStart: Date.now() };
    const MAX_STEPS = 3;
    const WALL_BUDGET_MS = 10_000;
    while (
      deps.isSourcePending() &&
      !findRelaySource(input.sourceCorrelationId) &&
      advancedSteps < MAX_STEPS &&
      Date.now() - budget.wallStart < WALL_BUDGET_MS
    ) {
      await deps.advanceSource();
      advancedSteps++;
    }
  }
  const built = buildRelayEnvelope(input);
  if (!built.ok) {
    return { ok: false, error: built.error, policyReason: built.policyReason, advancedSteps };
  }
  const { envelope, canonical, envelopeHash, evaluation } = built;

  // Durable trail anchor: envelope.created with the relay's persistence mode.
  // (R2 wired the mode into the write path — relay content defaults to redacted.)
  recordEnvelopeCreated(envelope);

  return {
    ok: true,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    envelope,
    canonical,
    envelopeHash,
    approvalRequired: envelope.relay.mode === 'approval-required',
    evaluation,
  };
}

/**
 * Pure envelope build + canonicalize + hash + policy evaluation (NO writes).
 * Shared by prepareRelay (records envelope.created) and sendRelay (re-validates
 * the SAME envelope without double-recording). Exported for R6 + tests.
 */
export function buildRelayEnvelope(input: RelayPrepareInput):
  | { ok: true; envelope: ConversationEnvelope; canonical: string; envelopeHash: string; evaluation: RelayPolicyEvaluation }
  | { ok: false; error: string; policyReason?: RelayPolicyEvaluation['reason'] } {
  const source = findRelaySource(input.sourceCorrelationId);
  if (!source) {
    return {
      ok: false,
      error: `no terminal-success source for correlation '${input.sourceCorrelationId}' — only completed/completed_late responses are relayable (design 05 §1.5)`,
    };
  }
  if (source.content.length === 0) {
    return {
      ok: false,
      error: 'source event has no persisted content (redacted/none mode) — cannot prepare a relay from it',
    };
  }

  const now = new Date().toISOString();
  const envelope: ConversationEnvelope = {
    idempotencyKey: `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    correlationId: source.correlationId, // relay chain = one correlation
    source: source.sourceProvider,
    destination: input.destination,
    content: source.content,
    provenance: {
      sourceProvider: source.sourceProvider,
      sourceMessageId: source.sourceMessageId,
      sourceContentHash: source.sourceContentHash,
      attributedTo: `${source.sourceProvider} via relay to ${input.destination}`,
      relayedAt: now,
      safetyClaimed: false, // ADR 0001 §Relay policy 4 — untrusted, literal false
    },
    relay: buildRelayControls(input),
    budget: {
      maxTurns: 1,
      wallClockDeadlineMs: input.deadlineMs ?? Date.now() + 5 * 60 * 1000,
    },
    createdAt: now,
  };

  // Eager policy checks (R3) — fail closed before any approval is minted.
  // deferApproval: prepare builds approved:false by design; approval_required
  // is the NEXT step (relay_approve), not a prepare-time failure (§3.4).
  const evaluation = evaluateRelayPolicy(envelope, { deferApproval: true });
  if (!evaluation.ok) {
    return {
      ok: false,
      error: `relay policy blocked: ${evaluation.reason} — ${evaluation.details}`,
      policyReason: evaluation.reason,
    };
  }

  return {
    ok: true,
    envelope,
    canonical: canonicalizeEnvelope(envelope),
    envelopeHash: computeEnvelopeHash(envelope),
    evaluation,
  };
}

// ---------------------------------------------------------------------------
// P4 R5 — relay_approve / relay_reject (single-use, append-only)
// ---------------------------------------------------------------------------

/** Inputs to relay_approve / relay_reject (R5). */
export interface RelayApprovalInput {
  /** The envelopeHash returned by relay_prepare — what is being approved. */
  approvalHash: string;
  correlationId: string;
  /** The prepared envelope's idempotencyKey (audit trail), when known. */
  envelopeId?: string;
  /** ISO expiry — defaults to +5min from now (matches prepare's default budget). */
  expiresAt?: string;
}

export interface RelayApprovalResult {
  ok: boolean;
  status: 'approved' | 'rejected' | 'already_recorded' | 'error';
  error?: string;
  /** The append-only event row, when recorded. */
  event?: ConversationEvent;
  expiresAt?: string;
}

const APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 min default — same as prepare's default budget

/**
 * R5: approve a prepared relay. Records relay.approved (append-only, keyed by
 * approvalHash) with an expiry. Single-use is enforced at CONSUME time (CAS in
 * consumeRelayApproval) — recording is idempotent-first: a hash is recorded
 * once; re-approving the same hash returns already_recorded without mutation.
 */
export function approveRelay(input: RelayApprovalInput): RelayApprovalResult {
  const expiresAt = input.expiresAt ?? new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const ev = recordRelayApproval({
    approvalHash: input.approvalHash,
    correlationId: input.correlationId,
    envelopeId: input.envelopeId,
    approved: true,
    expiresAt,
  });
  if (!ev) {
    const existing = getRelayApproval(input.approvalHash);
    return {
      ok: false,
      status: 'already_recorded',
      error: `approvalHash ${input.approvalHash} was already ${existing?.type === 'relay.approved' ? 'approved' : 'rejected'} (single-use)`,
    };
  }
  return { ok: true, status: 'approved', event: ev, expiresAt };
}

/**
 * R5: reject a prepared relay — records relay.rejected (append-only, terminal;
 * no expiry — a rejection can never be consumed). Same single-record rule.
 */
export function rejectRelay(input: RelayApprovalInput): RelayApprovalResult {
  const ev = recordRelayApproval({
    approvalHash: input.approvalHash,
    correlationId: input.correlationId,
    envelopeId: input.envelopeId,
    approved: false,
  });
  if (!ev) {
    const existing = getRelayApproval(input.approvalHash);
    return {
      ok: false,
      status: 'already_recorded',
      error: `approvalHash ${input.approvalHash} was already ${existing?.type === 'relay.approved' ? 'approved' : 'rejected'} (single-use)`,
    };
  }
  return { ok: true, status: 'rejected', event: ev };
}

/**
 * R5/R6 bridge: the single-use CAS consume relay_send performs BEFORE touching
 * the destination. Exposed here so relay_send (R6) and tests share one path.
 */
export function casConsumeApproval(
  approvalHash: string,
  correlationId: string,
  envelopeId?: string,
): { ok: true; event: ConversationEvent } | { ok: false; reason: string } {
  return consumeRelayApproval(approvalHash, correlationId, envelopeId);
}

// ---------------------------------------------------------------------------
// P4 R6 — relay_send (design 05 §3.6)
// ---------------------------------------------------------------------------

/** How relay_send hands the wire payload to the destination (provider-neutral). */
export interface RelaySendDeps {
  /**
   * Pre-flight: verify the destination surface is present (surface-gone check,
   * §3.6/§3.7). Returns ok:false with a reason when the surface is gone — the
   * send MUST NOT proceed and the approval is NOT consumed.
   */
  preflight?: () => Promise<{ ok: boolean; reason?: string }>;
  /**
   * Send the wire payload to the destination provider. Returns the destination
   * correlation/idempotencyKey for the caller to poll. MUST NOT throw — return
   * { ok:false } instead (receipts are append-only per attempt).
   */
  send: (wireContent: string) => Promise<{
    ok: boolean;
    correlationId?: string;
    idempotencyKey?: string;
    error?: string;
  }>;
}

/** Inputs to relay_send (R6) — must match the prepare inputs to re-validate the hash. */
export type RelaySendInput = RelayPrepareInput & { approvalHash: string };

export interface RelaySendResult {
  ok: boolean;
  status: 'sent' | 'blocked' | 'surface_gone' | 'approval_failed' | 'error';
  error?: string;
  /** The prepared relay envelope (content for provenance header). */
  envelope?: ConversationEnvelope;
  envelopeHash?: string;
  /** Destination ask identifiers (set when ok). */
  destinationCorrelationId?: string;
  destinationIdempotencyKey?: string;
  /** The receipt row seq (append-only per attempt). */
  receiptSeq?: number;
}

/**
 * Build the WIRE payload for the destination: attribution header + content,
 * with structural markdown neutralized when the policy demands it (design §2:
 * markdown is a trust-boundary control, rawMarkdown opt-in).
 */
export function buildWireContent(envelope: ConversationEnvelope, evaluation: RelayPolicyEvaluation): string {
  const header = envelope.relay.attributionHeader?.trim() ? envelope.relay.attributionHeader.trim() + '\n\n' : '';
  const body = evaluation.markdownAction === 'neutralize' ? neutralizeMarkdown(envelope.content) : envelope.content;
  return header + body;
}

/**
 * R6: send a prepared + approved relay. Order (fail-closed):
 *  1. re-validate the envelope hash against the approvalHash (hash binding)
 *  2. re-validate policy (no deferApproval — approval is REQUIRED here)
 *  3. surface-gone pre-flight (destination present?) — no consume on failure
 *  4. CAS-consume the approval (single-use) — after pre-flight, before send
 *  5. send via deps.send, receipt on EVERY attempt (append-only)
 *
 * The approval is consumed only when the send is actually attempted — a
 * surface-gone pre-flight failure leaves it consumable (client may retry after
 * fixing the destination).
 */
export async function sendRelay(
  input: RelaySendInput,
  deps: RelaySendDeps,
): Promise<RelaySendResult> {
  // build the SAME envelope the approval was minted on (no re-record — prepare
  // already wrote envelope.created; send re-validates, it does not re-create)
  const prepared = buildRelayEnvelope(input);
  if (!prepared.ok) {
    return { ok: false, status: prepared.policyReason ? 'blocked' : 'error', error: prepared.error };
  }
  const { envelope, envelopeHash, evaluation } = prepared;

  // 1. hash binding: the recomputed envelope must hash to the approved hash
  if (envelopeHash !== input.approvalHash) {
    return {
      ok: false,
      status: 'approval_failed',
      error: 'envelope hash mismatch — the relay was re-prepared with different content/policy/destination since approval; re-run relay_prepare + relay_approve',
    };
  }

  // 2. policy re-validation. The envelope's `approved` flag is a PLACEHOLDER
  // (approval lives in the store via relay_approve) — so the policy check here
  // defers approval (deferApproval) and the APPROVAL GATE is the CAS consume
  // below, which checks store state (approved + unexpired + unconsumed).
  if (!evaluation.ok) {
    return { ok: false, status: 'blocked', error: `policy blocked: ${evaluation.reason} — ${evaluation.details}` };
  }

  // 2b. fail-fast approval EXISTENCE check (before surface pre-flight): a hash
  // never approved (or already rejected) must fail here — approval_failed —
  // regardless of surface state. The single-use CAS consume below remains the
  // authoritative gate (expiry + consumed), after pre-flight.
  const approvalRecord = getRelayApproval(input.approvalHash);
  if (!approvalRecord || approvalRecord.type !== 'relay.approved') {
    return {
      ok: false,
      status: 'approval_failed',
      error: approvalRecord
        ? `approval for hash was ${approvalRecord.type === 'relay.rejected' ? 'rejected' : 'not approved'} — relay_approve first`
        : 'no approval recorded for this hash — run relay_prepare + relay_approve first',
    };
  }

  // 3. surface-gone pre-flight (design §3.6/§3.7: distinct terminal, no consume)
  if (deps.preflight) {
    const surface = await deps.preflight();
    if (!surface.ok) {
      return {
        ok: false,
        status: 'surface_gone',
        error: `destination surface gone: ${surface.reason ?? 'unknown'} — fix the destination and retry (approval NOT consumed)`,
      };
    }
  }

  // 4. CAS-consume the approval (single-use) — after pre-flight, before send
  const consumed = casConsumeApproval(input.approvalHash, envelope.correlationId, envelope.idempotencyKey);
  if (!consumed.ok) {
    return { ok: false, status: 'approval_failed', error: `approval cannot be consumed: ${consumed.reason}` };
  }

  // 5. send + receipt on EVERY attempt (append-only)
  const wire = buildWireContent(envelope, evaluation);
  const sendResult = await deps.send(wire);
  const status = sendResult.ok ? 'sent' : 'blocked';
  const receipt = recordDeliveryReceipt({
    receiptId: `rct-${envelope.correlationId}-${Date.now().toString(36)}`,
    envelopeId: envelope.idempotencyKey,
    correlationId: envelope.correlationId,
    idempotencyKey: envelope.idempotencyKey,
    status: status === 'sent' ? 'sent' : 'blocked',
    recordedAt: new Date().toISOString(),
    persistenceMode: resolveContentPersistenceMode(envelope),
    policyVersion: evaluation.effective.policyVersion,
    details: sendResult.ok ? undefined : sendResult.error,
  });

  return {
    ok: sendResult.ok,
    status,
    error: sendResult.ok ? undefined : sendResult.error,
    envelope,
    envelopeHash,
    destinationCorrelationId: sendResult.correlationId,
    destinationIdempotencyKey: sendResult.idempotencyKey,
    receiptSeq: receipt.seq,
  };
}

// ---------------------------------------------------------------------------
// P4 R7 — unknown-delivery reconciliation (design 05 §3.7, inherits ADR 0007)
// ---------------------------------------------------------------------------

/**
 * Reconciliation states for a relayed delivery. Inherits the async-ask machine
 * (soft expiry → watching → completed_late; abandoned on hard TTL) plus the
 * RELAY_SURFACE_GONE terminal (closed-tab analogue, §1.6) and the ambiguous
 * bucket (never auto-promoted, §2).
 */
export type RelayReconcileState =
  | 'in_progress'      // destination ask active — poll again
  | 'reconciled'       // destination response attributable to the relay
  | 'timed_out'        // soft expiry — still watched, may complete late
  | 'ambiguous'        // response present but NOT confidently attributable — never auto-promote
  | 'surface_gone'     // RELAY_SURFACE_GONE terminal — destination surface vanished
  | 'blocked'          // terminal — destination refused
  | 'abandoned';       // terminal — hard TTL reached, no completion

export interface RelayReconcileEvidence {
  /** Destination ask still tracked by the async-ask registry. */
  destinationPending: boolean;
  /** Latest destination ask status: completed / timed_out / watching / tab_closed / abandoned / blocked. */
  destinationStatus?: string;
  /** providerMessageId from the destination response (PRIMARY match key, §2). */
  destinationProviderMessageId?: string;
  /** contentHash from the destination response (secondary match key, §2). */
  destinationContentHash?: string;
  /** The relay's own send receipt status (sent / blocked). */
  relaySendStatus?: string;
  /** Whether a destination response event exists at all. */
  destinationResponded: boolean;
}

export interface RelayReconcileResult {
  ok: boolean;
  state: RelayReconcileState;
  /** True for terminal states — the client must NOT auto-resend; fresh approval required. */
  terminal: boolean;
  matchedBy?: 'providerMessageId' | 'contentHash' | 'ambiguous';
  providerMessageId?: string;
  contentHash?: string;
  details?: string;
}

/** Terminal states — no further polling/retry without a fresh approval (§3.7). */
const TERMINAL_STATES: ReadonlySet<RelayReconcileState> = new Set([
  'reconciled', 'ambiguous', 'surface_gone', 'blocked', 'abandoned',
]);

/**
 * Classify relay delivery from async-ask + event-store evidence. Pure and
 * provider-neutral. Never auto-promotes: a response that cannot be attributed
 * (no providerMessageId, no contentHash anchor) is AMBIGUOUS — terminal, and a
 * fresh client approval is required before any resend.
 */
export function classifyRelayReconciliation(evidence: RelayReconcileEvidence): RelayReconcileResult {
  const status = evidence.destinationStatus;

  // terminal destination failures, mapped to relay states
  if (status === 'tab_closed') {
    return {
      ok: false, state: 'surface_gone', terminal: true,
      details: 'destination surface gone — distinct terminal (design 05 §1.6); fix the destination, then re-run relay_prepare + relay_approve + relay_send',
    };
  }
  if (status === 'abandoned') {
    return { ok: false, state: 'abandoned', terminal: true, details: 'destination ask abandoned by reaper (hard TTL) — fresh approval required before any resend' };
  }
  if (status === 'blocked') {
    return { ok: false, state: 'blocked', terminal: true, details: 'destination refused the relay — fresh approval required before any resend' };
  }
  if (status === 'timed_out' || status === 'watching') {
    // soft expiry — the ask is STILL pending (ADR 0007 retains the key in
    // 'watching'); a late destination response may reconcile later. Must be
    // checked BEFORE the generic pending test below.
    return { ok: false, state: 'timed_out', terminal: false, details: 'soft expiry — destination still watched; poll again (may complete_late)' };
  }

  // still in flight — non-terminal (active/working/etc.)
  if (evidence.destinationPending && status !== 'completed') {
    return { ok: true, state: 'in_progress', terminal: false };
  }

  // completed (or responded): attribute it — providerMessageId PRIMARY, contentHash secondary (§2)
  if (evidence.destinationResponded || status === 'completed') {
    if (evidence.destinationProviderMessageId) {
      return {
        ok: true, state: 'reconciled', terminal: true,
        matchedBy: 'providerMessageId', providerMessageId: evidence.destinationProviderMessageId,
        contentHash: evidence.destinationContentHash,
      };
    }
    if (evidence.destinationContentHash) {
      return {
        ok: true, state: 'reconciled', terminal: true,
        matchedBy: 'contentHash', contentHash: evidence.destinationContentHash,
      };
    }
    // response exists but no anchor — NEVER auto-promote (§2 ambiguous bucket)
    return {
      ok: false, state: 'ambiguous', terminal: true,
      matchedBy: 'ambiguous',
      details: 'destination responded but no providerMessageId/contentHash anchor — ambiguous, never auto-promoted; fresh approval required before any resend',
    };
  }

  // relay send itself was refused
  if (evidence.relaySendStatus === 'blocked') {
    return { ok: false, state: 'blocked', terminal: true, details: 'relay send was blocked (receipt status blocked)' };
  }

  // nothing pending, nothing terminal, no response — surface lost mid-flight
  return {
    ok: false, state: 'surface_gone', terminal: true,
    details: 'destination ask is no longer tracked and no response was recorded — surface gone; fresh approval required before any resend',
  };
}

/** Inputs to relay_reconcile (R7). */
export interface RelayReconcileInput {
  /** The relay chain correlationId (== source correlation, from relay_send). */
  relayCorrelationId: string;
  /** The destination ask's correlationId (from relay_send). */
  destinationCorrelationId: string;
  /** The destination ask's idempotencyKey — pending check key (from relay_send). */
  destinationIdempotencyKey?: string;
}

export interface RelayReconcileDeps {
  /** True when the destination ask is still tracked by the async-ask registry. */
  isDestinationPending?: (idempotencyKey: string) => boolean;
}

/**
 * R7: reconcile a relayed delivery — read-only probe (never advances the ask,
 * never resends). Gathers evidence from the event store + async-ask registry
 * and classifies against the inherited state machine.
 */
export function reconcileRelay(input: RelayReconcileInput, deps: RelayReconcileDeps = {}): RelayReconcileResult {
  const relayReceipts = receiptsForCorrelation(input.relayCorrelationId);
  // the relay's OWN send receipt: status sent/blocked AND carries policyVersion (R6)
  const relaySend = [...relayReceipts].reverse().find(
    (r) => r.policyVersion !== undefined && (r.receiptStatus === 'sent' || r.receiptStatus === 'blocked'),
  );

  const destEvents = eventsForCorrelation(input.destinationCorrelationId);
  const destReceipts = receiptsForCorrelation(input.destinationCorrelationId);
  const destLatestReceipt = [...destReceipts].reverse().find((r) => r.receiptStatus !== undefined);
  const destResponse = [...destEvents].reverse().find(
    (e) => e.type === 'response.received' || e.type === 'response.deduplicated',
  );
  const destPending =
    !!deps.isDestinationPending && !!input.destinationIdempotencyKey
      ? deps.isDestinationPending(input.destinationIdempotencyKey)
      : false;

  return classifyRelayReconciliation({
    destinationPending: destPending,
    destinationStatus: destLatestReceipt?.receiptStatus,
    destinationProviderMessageId: destResponse?.response?.messageId,
    destinationContentHash: destResponse?.response?.contentHash,
    relaySendStatus: relaySend?.receiptStatus,
    destinationResponded: !!destResponse,
  });
}
