/**
 * P4 R1 — envelope canonicalization + envelopeHash (design 05 §3.1).
 *
 * Approval binds to the hash of the EXACT envelope: canonicalize content +
 * provenance + destination + policy together (never content alone), stamp the
 * policyVersion, then sha256 the deterministic JSON. Same logical envelope ⇒
 * same hash; any field change (content, provenance, destination, policy) ⇒
 * different hash — so a stale approval can never validate a modified envelope.
 *
 * Determinism contract: canonical JSON is key-sorted (recursively), undefined
 * values omitted, no insignificant whitespace. This is the single canonical
 * serialization for relay approval — do not hand-roll JSON elsewhere.
 */

import { createHash } from 'node:crypto';
import type { ConversationEnvelope, RelayControls } from '../types/conversation.js';

/** Current relay-policy schema version (bump on hashed-field changes, design 05 §3.3). */
export const RELAY_POLICY_VERSION = 1;

/** JSON values that participate in canonicalization. */
type CanonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | CanonValue[]
  | { [key: string]: CanonValue }
  | Readonly<Record<string, unknown>>;

/**
 * Deterministic JSON serialization: keys sorted recursively, undefined omitted,
 * no whitespace. Throws on non-finite numbers (never silently emit NaN/Infinity
 * into a hash input — they'd serialize to null in standard JSON, but we fail
 * loudly instead of hashing a mutated envelope).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    // Array order is significant — never sort arrays. Undefined entries become
    // null per JSON semantics; we drop them defensively to keep hashes stable.
    return value.map((v) => (v === undefined ? null : sortCanonical(v)));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // omit undefined — deterministic
      out[key] = sortCanonical(v);
    }
    return out;
  }
  return value;
}

/**
 * The canonical hash input for an envelope: content + provenance + destination +
 * policy, with policyVersion stamped. idempotencyKey/correlationId/createdAt are
 * deliberately EXCLUDED — the hash binds WHAT is relayed, not transport plumbing;
 * the same logical relayed content always yields the same approval hash.
 */
export function canonicalizeEnvelope(envelope: ConversationEnvelope): string {
  const { content, provenance, destination, relay } = envelope;
  const policy: RelayControls & { policyVersion: number } = {
    ...relay,
    policyVersion: relay.policyVersion ?? RELAY_POLICY_VERSION,
  };
  return canonicalJson({
    content,
    // relayedAt is transport metadata (when, not what) — excluded like
    // createdAt so the same logical relay hashes identically across prepares
    // AND relay_send's hash re-validation matches the approved hash (R6).
    provenance: {
      sourceProvider: provenance.sourceProvider,
      sourceMessageId: provenance.sourceMessageId,
      sourceContentHash: provenance.sourceContentHash,
      attributedTo: provenance.attributedTo,
      safetyClaimed: provenance.safetyClaimed,
    },
    destination: destination ?? null,
    policy,
  });
}

/**
 * P4 R1: envelopeHash — sha256 hex over the canonical envelope form.
 * This is the value relay_approve binds to (CAS) and relay_send re-validates.
 */
export function computeEnvelopeHash(envelope: ConversationEnvelope): string {
  return createHash('sha256').update(canonicalizeEnvelope(envelope), 'utf8').digest('hex');
}

/**
 * Convenience: build an envelope (native or relay) and return both its
 * canonical form and hash in one call — the shape relay_prepare will surface.
 */
export function envelopeFingerprint(envelope: ConversationEnvelope): {
  canonical: string;
  envelopeHash: string;
  policyVersion: number;
} {
  const canonical = canonicalizeEnvelope(envelope);
  return {
    canonical,
    envelopeHash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    policyVersion: envelope.relay.policyVersion ?? RELAY_POLICY_VERSION,
  };
}
