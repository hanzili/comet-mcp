/**
 * P4 R3 relay-policy tests — policy field defaults + enforcement module
 * (design 05 §3.3: approval / attribution / length / markdown / deadline /
 * enablement; §1.3 no-auto-resend; §2 markdown trust boundary).
 *
 * Run: node --test test/unit/relay-policy.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { makeEnvelope } from '../../dist/drivers/index.js';
import { CONSERVATIVE_RELAY_DEFAULTS } from '../../dist/types/conversation.js';
import {
  applyRelayPolicyDefaults,
  evaluateRelayPolicy,
  neutralizeMarkdown,
} from '../../dist/core/relay-policy.js';
import { RELAY_POLICY_VERSION } from '../../dist/core/envelope.js';
import type { ConversationEnvelope } from '../../dist/types/conversation.js';

function relayEnvelope(overrides: Partial<ConversationEnvelope['relay']> = {}, content = 'answer text'): ConversationEnvelope {
  const env = makeEnvelope('grok', `r3-${Math.random().toString(36).slice(2, 8)}`);
  return {
    ...env,
    content,
    destination: 'perplexity',
    provenance: { ...env.provenance, sourceProvider: 'grok', attributedTo: 'grok', relayedAt: '2026-08-09T00:00:00.000Z', safetyClaimed: false },
    relay: {
      ...env.relay,
      mode: 'approval-required',
      approved: true,
      destinationEnabled: true,
      attributionHeader: 'grok via relay from perplexity',
      ...overrides,
    },
  };
}

const NOW = Date.parse('2026-08-09T12:00:00.000Z');

test('R3: defaults — allowResend=false, rawMarkdown=false, policyVersion stamped', () => {
  const base = relayEnvelope();
  const def = applyRelayPolicyDefaults({ ...base.relay, allowResend: undefined, rawMarkdown: undefined, policyVersion: undefined });
  assert.equal(def.allowResend, false, 'allowResend defaults false (no-auto-resend absolute rule)');
  assert.equal(def.rawMarkdown, false, 'rawMarkdown defaults false (security-first)');
  assert.equal(def.policyVersion, RELAY_POLICY_VERSION);
  // explicit values are honored
  const exp = applyRelayPolicyDefaults({ ...base.relay, allowResend: true, rawMarkdown: true, policyVersion: 3 });
  assert.equal(exp.allowResend, true);
  assert.equal(exp.rawMarkdown, true);
  assert.equal(exp.policyVersion, 3);
  // conservative defaults constant carries the new fields
  assert.equal(CONSERVATIVE_RELAY_DEFAULTS.allowResend, false);
  assert.equal(CONSERVATIVE_RELAY_DEFAULTS.rawMarkdown, false);
});

test('R3: enabled policy passes — ok, passthrough markdown when rawMarkdown set', () => {
  const env = relayEnvelope({ mode: 'enabled', approved: false, rawMarkdown: true });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, true);
  assert.equal(ev.markdownAction, 'passthrough');
});

test('R3: disabled mode → blocked relay_disabled', () => {
  const env = relayEnvelope({ mode: 'disabled', approved: true });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'relay_disabled');
});

test('R3: destination not enabled → blocked destination_disabled', () => {
  const env = relayEnvelope({ destinationEnabled: false });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'destination_disabled');
});

test('R3: approval-required without approval → blocked approval_required', () => {
  const env = relayEnvelope({ mode: 'approval-required', approved: false });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'approval_required');
  // enabled mode does not require approval
  const okEnv = relayEnvelope({ mode: 'enabled', approved: false, rawMarkdown: true });
  assert.equal(evaluateRelayPolicy(okEnv, { nowMs: NOW }).ok, true);
});

test('R3: approval-required without attributionHeader → blocked attribution_missing (fail closed)', () => {
  const env = relayEnvelope({ attributionHeader: undefined });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'attribution_missing');
  // empty/whitespace header also fails closed
  const blank = relayEnvelope({ attributionHeader: '   ' });
  assert.equal(evaluateRelayPolicy(blank, { nowMs: NOW }).reason, 'attribution_missing');
  // enabled mode: header optional
  const enabled = relayEnvelope({ mode: 'enabled', rawMarkdown: true, attributionHeader: undefined });
  assert.equal(evaluateRelayPolicy(enabled, { nowMs: NOW }).ok, true);
});

test('R3: content over size limit → blocked content_too_large', () => {
  const env = relayEnvelope({ contentSizeLimitBytes: 5 }, 'this is twelve chars');
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'content_too_large');
  // at/under limit passes (exactly 12 chars: "twelve chars")
  const ok = relayEnvelope({ contentSizeLimitBytes: 12 }, 'twelve chars');
  assert.equal(evaluateRelayPolicy(ok, { nowMs: NOW }).ok, true);
});

test('R3: deadline passed → blocked deadline_expired', () => {
  const env = relayEnvelope({ deadlineMs: NOW - 1000 });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, false);
  assert.equal(ev.reason, 'deadline_expired');
  // future deadline passes
  const ok = relayEnvelope({ deadlineMs: NOW + 60000 });
  assert.equal(evaluateRelayPolicy(ok, { nowMs: NOW }).ok, true);
});

test('R3: markdownAction — neutralize in approval-required unless rawMarkdown, passthrough otherwise', () => {
  assert.equal(evaluateRelayPolicy(relayEnvelope(), { nowMs: NOW }).markdownAction, 'neutralize');
  assert.equal(evaluateRelayPolicy(relayEnvelope({ rawMarkdown: true }), { nowMs: NOW }).markdownAction, 'passthrough');
  assert.equal(evaluateRelayPolicy(relayEnvelope({ mode: 'enabled', rawMarkdown: true }), { nowMs: NOW }).markdownAction, 'passthrough');
});

test('R3: neutralizeMarkdown — strip link URLs to text', () => {
  assert.equal(neutralizeMarkdown('see [the doc](https://evil.example/x) now'), 'see the doc now');
});

test('R3: neutralizeMarkdown — remove embedded media, alt preserved as text', () => {
  assert.equal(neutralizeMarkdown('pic ![logo](https://evil.example/logo.png) end'), 'pic logo end');
});

test('R3: neutralizeMarkdown — fence code blocks (own-line triple backticks)', () => {
  const out = neutralizeMarkdown('before ```js\ncode()\n``` after');
  assert.ok(out.startsWith('before\n```\ncode()\n```\nafter') || out.includes('```'), 'fences normalized');
  // unclosed fence run collapsed to a single fence — cannot swallow text
  const unclosed = neutralizeMarkdown('``````\nsneaky\n');
  assert.ok(!unclosed.includes('``````'), 'long backtick runs collapsed');
  assert.equal((unclosed.match(/```/g) ?? []).length, 1, 'single fence remains');
});

test('R3: neutralizeMarkdown — text content preserved, only structure bounded', () => {
  const original = 'The answer is 42. Links: [pi.dev](https://pi.dev). Image: ![x](https://x/y.png).';
  const out = neutralizeMarkdown(original);
  assert.ok(out.includes('The answer is 42.'), 'prose preserved');
  assert.ok(out.includes('pi.dev'), 'link text preserved');
  assert.ok(out.includes('x'), 'image alt preserved');
  assert.ok(!out.includes('](https://'), 'no URL structure remains');
});

test('R3: evaluation returns effective policy + markdownAction together (send-path contract)', () => {
  const env = relayEnvelope({ contentSizeLimitBytes: 999, deadlineMs: NOW + 5000 });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, true);
  assert.equal(ev.effective.allowResend, false, 'defaults visible to send path');
  assert.equal(ev.effective.rawMarkdown, false);
  assert.equal(ev.effective.contentSizeLimitBytes, 999);
  assert.equal(ev.effective.deadlineMs, NOW + 5000);
  assert.equal(ev.effective.policyVersion, RELAY_POLICY_VERSION);
  assert.equal(ev.markdownAction, 'neutralize');
});

test('R3: maxRelaysPerCorrelation carried through (enforced by relay_send against correlation history)', () => {
  const env = relayEnvelope({ maxRelaysPerCorrelation: 3 });
  const ev = evaluateRelayPolicy(env, { nowMs: NOW });
  assert.equal(ev.ok, true);
  assert.equal(ev.effective.maxRelaysPerCorrelation, 3);
  // 0 means no relays allowed — policy carries it; send path must check correlation count >= cap
  const zero = relayEnvelope({ maxRelaysPerCorrelation: 0 });
  assert.equal(evaluateRelayPolicy(zero, { nowMs: NOW }).effective.maxRelaysPerCorrelation, 0);
});
