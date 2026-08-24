/**
 * Conversation fabric types (P1).
 *
 * The executive synthesis rule this module implements: "the primary abstraction is a
 * conversation event and delivery receipt, not a raw message copied from one tab into
 * another." These types are provider-neutral — the fabric must not know whether a
 * transport is a browser tab or an official API (ADR 0001 §Transport 3).
 *
 * P1 scope: ConversationEnvelope, event log, delivery receipts, correlation IDs,
 * idempotency keys, and conservative relay defaults (relay disabled or
 * approval-required).
 */

/** Provider identifiers. Extend as adapters land (P6). */
export type ProviderId = 'perplexity' | 'grok' | 'gemini' | 'chatgpt' | 'claude';

/** Relay authorization mode. Conservative default: relay disabled or approval-required. */
export type RelayMode = 'disabled' | 'approval-required' | 'enabled';

/**
 * Delivery receipt statuses (executive synthesis §5, ADR 0001 §Relay policy 3-5).
 *
 * `unknown` is the honest answer to "did it land?" — an uncertain delivery outcome is
 * surfaced as `unknown`, and the server MUST NOT silently resend conversational content
 * (ADR 0001 §Relay policy 5).
 */
export type ReceiptStatus =
  | 'queued'       // accepted by the fabric, not yet handed to a driver
  | 'sent'         // handed to the driver / tab
  | 'accepted'     // provider acknowledged the input (visible in composer/UI)
  | 'completed'    // response received and recorded
  | 'blocked'      // policy or provider refused before input (approval, size, plan, login)
  | 'timed_out'    // bounded deadline exceeded
  | 'completed_late' // 2026-08-08: response recovered AFTER soft expiry (both receipts coexist — truthful)
  | 'abandoned'    // 2026-08-08: hard TTL reached — reaper purged the ask, no completion
  | 'unknown';     // outcome uncertain — never silently retry

/**
 * Provenance of a piece of content flowing through the fabric.
 *
 * IMPORTANT (ADR 0001 §Relay policy 4): the attribution header is an audit/provenance
 * control, NOT a claim of safety or a classifier bypass. A relayed provider response is
 * untrusted content. `safetyClaimed` is therefore a literal constant `false` — modeling
 * that no wrapper guarantees the receiving provider will accept or the content is safe.
 */
export interface Provenance {
  sourceProvider: ProviderId;
  /** Provider-native message ID when available (dedup anchor, P3). */
  sourceMessageId?: string;
  /** Hash of the source content (dedup anchor, P3). */
  sourceContentHash?: string;
  /** Human/audit attribution, e.g. "grok" or "grok via relay from perplexity". */
  attributedTo: string;
  /** When the content was relayed, if it was. */
  relayedAt?: string;
  readonly safetyClaimed: false;
}

/**
 * Bounded execution budget. Every orchestration plan must declare max turns and a
 * wall-clock deadline (ADR 0001 §Operational safeguards 1, build plan safety defaults).
 */
export interface ConversationBudget {
  maxTurns: number;
  /** Wall-clock deadline in epoch ms after which the send/plan must halt. */
  wallClockDeadlineMs: number;
  /** Optional content byte limit (enforced before provider input, P4). */
  contentBytesLimit?: number;
  /** Optional relay byte limit. */
  relayBytesLimit?: number;
}

/** Relay controls on an envelope. Enforced before transmission (P4 gate). */
export interface RelayControls {
  mode: RelayMode;
  /** Client approval required when mode is `approval-required`. */
  approved: boolean;
  approvalRef?: string;
  /** Explicit destination-provider enablement. */
  destinationEnabled: boolean;
  /** Attribution header / wrapper text carried with the relayed content. */
  attributionHeader?: string;
  /** Content-size limit for this relay. */
  contentSizeLimitBytes?: number;
  /** Relay deadline. */
  deadlineMs?: number;
  /**
   * P4 R1: policy schema version, stamped into the envelope hash. Bumps when the
   * hashed policy field set changes so old approvals can never validate new
   * envelopes (design 05 §3.1). Defaults to RELAY_POLICY_VERSION when unset.
   */
  policyVersion?: number;
  /**
   * P4 R2: per-destination content persistence mode (design 05 §2).
   * full = content+hashes; redacted = metadata-only (no content, no PII);
   * none = control plane only (ids/hashes/status/timestamps). When unset,
   * resolveContentPersistenceMode() defaults: relay ⇒ redacted, native ⇒ full.
   */
  contentPersistenceMode?: ContentPersistenceMode;
  /**
   * P4 R3: absolute rule — never auto-resend (design 05 §1.3). Default false;
   * a resend requires fresh client approval every time, never automatic.
   */
  allowResend?: boolean;
  /**
   * P4 R3: hard cap on relay sends per correlation (design 05 §3.3). Prevents
   * runaway relay chains even under client error; undefined = no cap (caller
   * explicitly opted out), 0 = no relays allowed.
   */
  maxRelaysPerCorrelation?: number;
  /**
   * P4 R3: markdown trust-boundary control (design 05 §2 resolution). Default
   * false ⇒ structural markdown neutralized in approval-required mode (strip
   * link URLs, remove embedded media, fence code blocks). true = opt-in raw
   * pass-through (grok's content-preservation case).
   */
  rawMarkdown?: boolean;
}

/**
 * The unit of work the fabric moves between providers.
 *
 * Every send uses a ConversationEnvelope with a correlation/idempotency key,
 * source/destination, content, untrusted provenance, relay mode, approval state, and
 * bounded budget (executive synthesis §5).
 */
export interface ConversationEnvelope {
  /**
   * Idempotency key — unique per logical send. Replay/retry with the same key must not
   * produce a duplicate send (P1 gate: "recovery/replay creates no duplicate send").
   */
  idempotencyKey: string;
  /**
   * Correlation ID — groups one logical exchange across providers (a relay chain is
   * one correlation, many envelopes). Distinct from idempotencyKey.
   */
  correlationId: string;
  source: ProviderId;
  /** Undefined for a native ask; set for a relay (P4). */
  destination?: ProviderId;
  content: string;
  /** Untrusted, but always recorded. */
  provenance: Provenance;
  relay: RelayControls;
  budget: ConversationBudget;
  createdAt: string;
}

/** Event types in the append-only conversation log. */
export type ConversationEventType =
  | 'envelope.created'
  | 'send.queued'
  | 'send.accepted'
  | 'send.blocked'
  | 'send.timed_out'
  | 'send.unknown'
  | 'response.received'
  /** Same content hash / provider message id as a prior event — dedup, no new send. */
  | 'response.deduplicated'
  /**
   * ADR 0009 follow-up (2026-08-09): content GROWTH after an early authoritative
   * finalize — a later poll sees a longer same-prefix superset of an already
   * recorded response. Recorded INSTEAD of a second response.received so
   * downstream consumers can see the amendment without confusing two terminal
   * events. relay_prepare picks the newest terminal, so this is belt-and-braces.
   */
  | 'response.amended'
  | 'delivery.receipt'
  | 'relay.approved'
  | 'relay.rejected'
  /** P4 R5: CAS consumption of a relay approval (single-use; appended by relay_send). */
  | 'relay.approval_consumed'
  | 'plan.halted';

/**
 * Content persistence mode (ADR 0001 §Persistence and privacy 3): relayed conversations
 * can contain sensitive material, so persistence must support redaction or no-content.
 */
export type ContentPersistenceMode = 'full' | 'redacted' | 'none';

/** One append-only row in the conversation event log. */
export interface ConversationEvent {
  eventId: string;
  /** Monotonic sequence — the log is append-only. */
  seq: number;
  type: ConversationEventType;
  correlationId: string;
  envelopeId?: string;
  idempotencyKey?: string;
  /** Set on delivery.receipt events. */
  receiptStatus?: ReceiptStatus;
  /** Set on response events: provider-native dedup anchors + poll snapshot. */
  response?: {
    provider: ProviderId;
    messageId?: string;
    contentHash: string;
    cursor?: string;
    poll: {
      state: string;
      response: string;
      steps: string[];
    };
    /**
     * P4 R2: character length of the ORIGINAL response text. Present only in
     * `redacted` mode — metadata without content (design 05 §2).
     */
    contentLength?: number;
  };
  /** How conversation content was persisted for this event. */
  persistenceMode: ContentPersistenceMode;
  /** P4 R5: approval hash bound by relay.approved/rejected (single-use CAS key). */
  approvalHash?: string;
  /** P4 R5: approval expiry (ISO) on relay.approved; when the approval lapses. */
  approvalExpiresAt?: string;
  /** P4 R5: seq of the consuming relay_send on relay.approval_consumed (CAS marker). */
  consumedBySeq?: number;
  /** P4 R6: relay policy version in effect (receipts carry it, design 05 §3.6). */
  policyVersion?: number;
  at: string;
}

/**
 * The delivery receipt — the fabric's answer to "what happened to this send?".
 * One receipt per attempt; `unknown` statuses are never auto-resent.
 *
 * P1 Half 2 (critique L35/L37): receipts are an APPEND-ONLY stream, not a mutable
 * record — each attempt gets a fresh receiptId, retries reuse the idempotencyKey
 * and carry increasing attempt numbers, and extraction evidence (contentHash,
 * providerMessageId, cursor) rides ON the receipt so reconnect-dedup (P3) and
 * unknown-delivery reconciliation (P4) have the anchors without a second lookup.
 */
export interface DeliveryReceipt {
  receiptId: string;
  envelopeId: string;
  correlationId: string;
  idempotencyKey: string;
  status: ReceiptStatus;
  recordedAt: string;
  /** Attempt number (1-based). Retries reuse idempotencyKey, fresh id per attempt. */
  attempt?: number;
  /** Extraction evidence (dedup anchors, P1 Half 2 / P3). */
  contentHash?: string;
  providerMessageId?: string;
  cursor?: string;
  /** Optional driver/provider detail (e.g. "blocked: size 12KB > 8KB limit"). */
  details?: string;
  /**
   * P4 R2: content persistence mode in effect for this receipt's correlation
   * (design 05 §3.2 — receipts carry the mode). Mirrors the event's mode.
   */
  persistenceMode?: ContentPersistenceMode;
  /**
   * P4 R6: relay policy version in effect when the attempt was made (design
   * 05 §3.6 — receipts carry the policyVersion). Set on relay receipts.
   */
  policyVersion?: number;
}

/** Conservative relay defaults (P1 task list item 7, build plan safety defaults). */
export const CONSERVATIVE_RELAY_DEFAULTS: RelayControls = {
  mode: 'approval-required',
  approved: false,
  destinationEnabled: false,
  // P4 R3: absolute no-auto-resend + security-first markdown defaults
  allowResend: false,
  rawMarkdown: false,
};

/** Default budget — every send is bounded even before a plan exists. */
export const DEFAULT_SEND_BUDGET: ConversationBudget = {
  maxTurns: 1,
  wallClockDeadlineMs: 0, // must be set by the caller before use
};
