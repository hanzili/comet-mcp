/**
 * P4 R1 envelope tests — canonicalization determinism + envelopeHash binding
 * (design 05 §3.1: hash content + provenance + destination + policy together,
 * policyVersion stamped; never content alone).
 *
 * Run: node --test test/unit/envelope.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { makeEnvelope } from '../../dist/drivers/index.js';
import {
  canonicalJson,
  canonicalizeEnvelope,
  computeEnvelopeHash,
  envelopeFingerprint,
  RELAY_POLICY_VERSION,
} from '../../dist/core/envelope.js';
import type { ConversationEnvelope, RelayMode } from '../../dist/types/conversation.js';

function relayEnvelope(overrides: {
  content?: string;
  source?: ConversationEnvelope['source'];
  destination?: ConversationEnvelope['destination'];
  attributedTo?: string;
  mode?: RelayMode;
  approved?: boolean;
  attributionHeader?: string;
  contentSizeLimitBytes?: number;
  policyVersion?: number;
} = {}): ConversationEnvelope {
  const env = makeEnvelope(overrides.source ?? 'grok', `env-${Math.random().toString(36).slice(2, 8)}`);
  return {
    ...env,
    content: overrides.content ?? 'the answer',
    destination: overrides.destination ?? 'perplexity',
    provenance: {
      ...env.provenance,
      sourceProvider: overrides.source ?? 'grok',
      sourceMessageId: 'msg-1',
      sourceContentHash: 'hash-1',
      attributedTo: overrides.attributedTo ?? 'grok',
      relayedAt: '2026-08-09T00:00:00.000Z',
      safetyClaimed: false,
    },
    relay: {
      ...env.relay,
      mode: overrides.mode ?? 'approval-required',
      approved: overrides.approved ?? false,
      destinationEnabled: true,
      attributionHeader: overrides.attributionHeader ?? 'grok via relay from perplexity',
      contentSizeLimitBytes: overrides.contentSizeLimitBytes ?? 8000,
      deadlineMs: 120000,
      policyVersion: overrides.policyVersion,
    },
  };
}

test('R1: canonicalJson — key-sorted, whitespace-free, undefined omitted', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: { d: 4, c: 3 }, b: [1, 2] }), '{"a":{"c":3,"d":4},"b":[1,2]}');
  assert.equal(canonicalJson({ a: undefined, b: 'x' }), '{"b":"x"}');
  assert.equal(canonicalJson({ a: null }), '{"a":null}');
  // array order is preserved (never sorted)
  assert.equal(canonicalJson({ a: [2, 1, 3] }), '{"a":[2,1,3]}');
});

test('R1: canonicalization — same logical envelope, different key order, same canonical form', () => {
  const env1 = relayEnvelope({ content: 'same' });
  const env2 = relayEnvelope({ content: 'same' });
  // Different random idempotency/correlation keys must NOT change the canonical form
  assert.notEqual(env1.idempotencyKey, env2.idempotencyKey);
  assert.equal(canonicalizeEnvelope(env1), canonicalizeEnvelope(env2));
});

test('R1: policyVersion is stamped into the canonical form', () => {
  const env = relayEnvelope({ content: 'v' });
  const canonical = canonicalizeEnvelope(env);
  assert.ok(canonical.includes('"policyVersion":1'), 'default policyVersion stamped');
  const envV2 = relayEnvelope({ content: 'v', policyVersion: 2 });
  assert.ok(canonicalizeEnvelope(envV2).includes('"policyVersion":2'));
  // explicit version changes the hash even with identical other fields
  assert.notEqual(canonicalizeEnvelope(env), canonicalizeEnvelope(envV2));
});

test('R1: envelopeHash — sha256 hex, 64 chars, deterministic', () => {
  const env = relayEnvelope({ content: 'h' });
  const hash = computeEnvelopeHash(env);
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(computeEnvelopeHash(env), computeEnvelopeHash(relayEnvelope({ content: 'h' })));
});

test('R1: hash binds content — changing content changes the hash', () => {
  const a = computeEnvelopeHash(relayEnvelope({ content: 'answer A' }));
  const b = computeEnvelopeHash(relayEnvelope({ content: 'answer B' }));
  assert.notEqual(a, b);
});

test('R1: hash binds destination — same content, different target, different hash', () => {
  const a = computeEnvelopeHash(relayEnvelope({ content: 'x', destination: 'perplexity' }));
  const b = computeEnvelopeHash(relayEnvelope({ content: 'x', destination: 'grok' }));
  assert.notEqual(a, b);
});

test('R1: hash binds provenance — attribution change changes the hash', () => {
  const a = computeEnvelopeHash(relayEnvelope({ content: 'x', attributedTo: 'grok' }));
  const b = computeEnvelopeHash(relayEnvelope({ content: 'x', attributedTo: 'claude' }));
  assert.notEqual(a, b);
});

test('R1: hash binds policy — approval state / header change changes the hash', () => {
  const base = relayEnvelope({ content: 'x', mode: 'approval-required', approved: false });
  const approved = relayEnvelope({ content: 'x', mode: 'approval-required', approved: true });
  assert.notEqual(computeEnvelopeHash(base), computeEnvelopeHash(approved));

  const header = relayEnvelope({ content: 'x', attributionHeader: 'different header' });
  assert.notEqual(computeEnvelopeHash(base), computeEnvelopeHash(header));
});

test('R1: hash is content+policy+destination together — never content alone', () => {
  // Two envelopes with identical content but different policy must differ
  const free = relayEnvelope({ content: 'y', contentSizeLimitBytes: 8000 });
  const strict = relayEnvelope({ content: 'y', contentSizeLimitBytes: 100 });
  assert.notEqual(computeEnvelopeHash(free), computeEnvelopeHash(strict));
  // and the canonical form contains all four groups
  const canonical = canonicalizeEnvelope(relayEnvelope({ content: 'z' }));
  for (const key of ['"content"', '"provenance"', '"destination"', '"policy"']) {
    assert.ok(canonical.includes(key), `canonical form includes ${key}`);
  }
});

test('R1: envelopeFingerprint — returns canonical + hash + stamped version together', () => {
  const env = relayEnvelope({ content: 'fp' });
  const fp = envelopeFingerprint(env);
  assert.equal(fp.canonical, canonicalizeEnvelope(env));
  assert.equal(fp.envelopeHash, createHash('sha256').update(fp.canonical, 'utf8').digest('hex'));
  assert.equal(fp.policyVersion, RELAY_POLICY_VERSION);
});
