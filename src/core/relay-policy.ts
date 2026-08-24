/**
 * P4 R3 — relay policy fields + enforcement module (design 05 §3.3).
 *
 * Policy field additions (design §3.3): mode, approved, approvalRef,
 * destinationEnabled, attributionHeader (MANDATORY in approval-required mode,
 * fail closed if unset), contentSizeLimitBytes, deadlineMs, contentPersistenceMode,
 * allowResend (default false — absolute no-auto-resend rule, §1.3),
 * maxRelaysPerCorrelation, policyVersion (R1), rawMarkdown (default false).
 *
 * Enforcement targets: approval / attribution / length / markdown / deadline /
 * enablement. The module is provider-neutral and pure — relay_send (R6) calls
 * evaluateRelayPolicy() as pre-flight; relay_prepare (R4) uses the same
 * evaluation for eager checks + surfaces markdownAction for wire shaping.
 *
 * Markdown trust boundary (design §2 resolution — Claude's security-first
 * default): in approval-required mode structural markdown is NEUTRALIZED unless
 * rawMarkdown:true opt-in (grok's preservation case). Neutralize = strip link
 * URLs to text, remove embedded media, fence code blocks. Text content is
 * preserved; only structure is bounded.
 */

import type { ConversationEnvelope, RelayControls } from '../types/conversation.js';
import { RELAY_POLICY_VERSION } from './envelope.js';

/** Stable, machine-checkable block reasons (each maps to one policy check). */
export type RelayPolicyBlockReason =
  | 'relay_disabled'
  | 'approval_required'
  | 'destination_disabled'
  | 'attribution_missing'
  | 'content_too_large'
  | 'deadline_expired';

/** How the wire payload must be shaped under the evaluated policy. */
export type MarkdownAction = 'neutralize' | 'passthrough';

/** Result of evaluating an envelope against relay policy (fail-closed). */
export interface RelayPolicyEvaluation {
  ok: boolean;
  /** Set when !ok — first failing check wins (fail-closed ordering). */
  reason?: RelayPolicyBlockReason;
  details?: string;
  /** Effective policy with R3 defaults applied (what the send path enforces). */
  effective: RelayControls & { policyVersion: number };
  markdownAction: MarkdownAction;
}

/**
 * Apply R3 defaults to a relay policy: allowResend=false (absolute rule §1.3),
 * rawMarkdown=false (security-first §2), policyVersion stamped (R1). Returns a
 * new object — never mutates the input. Pure.
 */
export function applyRelayPolicyDefaults(relay: RelayControls): RelayControls & { policyVersion: number } {
  return {
    ...relay,
    allowResend: relay.allowResend ?? false,
    rawMarkdown: relay.rawMarkdown ?? false,
    policyVersion: relay.policyVersion ?? RELAY_POLICY_VERSION,
  };
}

function markdownActionFor(relay: RelayControls & { policyVersion: number }): MarkdownAction {
  // Security-first default: neutralize structural markdown in approval-required
  // mode; rawMarkdown:true opts into pass-through (design §2 resolution).
  return relay.mode === 'approval-required' && !relay.rawMarkdown ? 'neutralize' : 'passthrough';
}

/**
 * Evaluate an envelope against relay policy — the single enforcement entry
 * point. Fail-closed ordering: disabled → destination → approval →
 * attribution → size → deadline. Returns the effective policy + markdown
 * action so callers shape the wire payload identically to what was checked.
 *
 * `deferApproval` (R4 prepare): when true, the approval_required check is
 * SKIPPED — prepare builds approved:false by design (approval is the NEXT
 * step, §3.4 output), so approval is not a prepare-time failure. relay_send
 * (R6) evaluates WITHOUT deferApproval, enforcing approval fully.
 */
export function evaluateRelayPolicy(
  envelope: ConversationEnvelope,
  opts: { nowMs?: number; deferApproval?: boolean } = {},
): RelayPolicyEvaluation {
  const relay = applyRelayPolicyDefaults(envelope.relay);
  const effective = relay;
  const nowMs = opts.nowMs ?? Date.now();

  const blocked = (reason: RelayPolicyBlockReason, details: string): RelayPolicyEvaluation => ({
    ok: false,
    reason,
    details,
    effective,
    markdownAction: markdownActionFor(effective),
  });

  if (relay.mode === 'disabled') {
    return blocked('relay_disabled', 'relay mode is disabled');
  }
  if (!relay.destinationEnabled) {
    return blocked('destination_disabled', 'destinationEnabled is false');
  }
  if (relay.mode === 'approval-required' && !relay.approved && !opts.deferApproval) {
    return blocked('approval_required', 'approval required but not granted');
  }
  if (relay.mode === 'approval-required' && !relay.attributionHeader?.trim()) {
    // attributionHeader is MANDATORY in approval-required mode — fail closed
    return blocked('attribution_missing', 'attributionHeader is mandatory in approval-required mode (fail closed)');
  }
  if (relay.contentSizeLimitBytes !== undefined && envelope.content.length > relay.contentSizeLimitBytes) {
    return blocked('content_too_large', `content ${envelope.content.length}B exceeds ${relay.contentSizeLimitBytes}B limit`);
  }
  if (relay.deadlineMs !== undefined && nowMs > relay.deadlineMs) {
    return blocked('deadline_expired', `relay deadline passed (${relay.deadlineMs} < ${nowMs})`);
  }

  return { ok: true, effective, markdownAction: markdownActionFor(effective) };
}

/**
 * Neutralize structural markdown (design §2): strip link URLs to text, remove
 * embedded media (image alt preserved as text), fence code blocks (normalize
 * to triple-backtick on their own lines so an unclosed fence can't swallow
 * following text). Text content is preserved; only structure is bounded.
 * Deterministic, regex-only — no parser dependency.
 */
export function neutralizeMarkdown(text: string): string {
  return text
    // remove embedded media: ![alt](url) → alt (media dropped, alt kept as text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // strip link URLs to text: [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // fence code blocks: collapse backtick runs to exactly ``` on their own lines
    .replace(/```+/g, '```')
    .replace(/(^|\n)```(?=\S)/g, '$1```\n')
    .replace(/(\S)```(\n|$)/g, '$1\n```$2');
}
