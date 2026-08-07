/**
 * Discovery downgrade-guard + composer-ranking tests (2026-08-07).
 *
 * Guard: a low-confidence / partial discovery run must NOT overwrite a strictly
 * better existing entry (found live: a claude run ended streaming/low, lost
 * sendButton, and flattened confidence — clobbering the committed HIGH entry).
 *
 * Composer ranking: discovery must prefer a VISIBLE contenteditable composer
 * over a hidden a11y textarea (found live: claude's real composer is a
 * contenteditable div, but a hidden 0x0 textarea sits first in DOM order).
 *
 * Run: node --test test/unit/discovery-guard.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';

// pure guard decision — mirrors runDiscovery's logic so it's testable without CDP
function guardDecision(existing, fresh) {
  const existingControlCount = existing ? Object.keys(existing.controls ?? {}).length : 0;
  const newControlCount = Object.keys(fresh.controls).length;
  const existingHasSendButton = !!existing?.controls?.sendButton;
  const newHasSendButton = !!fresh.controls.sendButton;
  const rank = { high: 3, medium: 2, low: 1 };
  const existingBetter =
    existing && (
      (existingHasSendButton && !newHasSendButton) ||
      (existingControlCount > newControlCount) ||
      (rank[existing.confidence] > rank[fresh.confidence])
    );
  return existingBetter;
}

const highEntry = {
  confidence: 'high',
  controls: { composer: {}, sendButton: {}, modelPicker: {}, responseContainer: {} },
};
const lowEntry = {
  confidence: 'low',
  controls: { composer: {}, modelPicker: {}, responseContainer: {} }, // lost sendButton
};
const lowWithSend = {
  confidence: 'low',
  controls: { composer: {}, sendButton: {}, modelPicker: {} }, // same count, but low conf
};
const freshHigh = {
  confidence: 'high',
  controls: { composer: {}, sendButton: {}, modelPicker: {}, responseContainer: {} },
};

test('guard: low run that lost sendButton must not overwrite HIGH entry', () => {
  assert.equal(guardDecision(highEntry, lowEntry), true, 'existing HIGH has sendButton, new lost it');
});

test('guard: fewer controls in new run → refuse', () => {
  const existing4 = { confidence: 'medium', controls: { a: {}, b: {}, c: {}, d: {} } };
  const fresh3 = { confidence: 'medium', controls: { a: {}, b: {}, c: {} } };
  assert.equal(guardDecision(existing4, fresh3), true);
});

test('guard: same controls but lower confidence → refuse', () => {
  assert.equal(guardDecision(highEntry, lowWithSend), true, 'existing HIGH > new LOW');
});

test('guard: strictly-better fresh run → allow', () => {
  assert.equal(guardDecision(highEntry, freshHigh), false, 'equal or better → write');
});

test('guard: no existing entry → allow', () => {
  assert.ok(!guardDecision(null, lowEntry), 'first discovery always writes');
});

test('guard: existing conditional flags lost in new run → refuse', () => {
  const withConditionals = {
    confidence: 'high',
    controls: {
      sendButton: { conditional: true },
      responseContainer: { conditional: true },
      composer: {},
    },
  };
  const noConditionals = {
    confidence: 'high',
    controls: { sendButton: {}, responseContainer: {}, composer: {} }, // same count, flags dropped
  };
  // mirror must include the conditional-count comparison
  const mirror = (existing, fresh) => {
    const existingCond = existing ? Object.values(existing.controls ?? {}).filter((c) => c?.conditional === true).length : 0;
    const newCond = Object.values(fresh.controls).filter((c) => c?.conditional === true).length;
    return guardDecision(existing, fresh) || (existing && existingCond > newCond);
  };
  assert.ok(mirror(withConditionals, noConditionals), 'existing conditional flags must be protected');
  // equal conditional counts → allow
  assert.ok(!mirror(noConditionals, withConditionals), 'new run with MORE conditional flags is fine');
});

// composer ranking — mirrors the INVENTORY sort: visible+editable first
function rankComposers(composers) {
  return [...composers]
    .sort((a, b) => (b.__visible + b.__editable) - (a.__visible + a.__editable) ||
      ((a.__editable === 1 ? 0 : 1) - (b.__editable === 1 ? 0 : 1)))
    .map((c) => c.id || c.testid || c.aria || 'unknown');
}

test('composer ranking: visible contenteditable beats hidden textarea', () => {
  const hiddenTextarea = { id: 'static-composer-input', tag: 'textarea', __visible: 0, __editable: 0 };
  const visibleDiv = { testid: 'chat-input', tag: 'div', __visible: 1, __editable: 1 };
  const ranked = rankComposers([hiddenTextarea, visibleDiv]);
  assert.equal(ranked[0], 'chat-input', 'contenteditable div must rank first');
});

test('composer ranking: visible textbox beats visible textarea', () => {
  const visibleTextarea = { id: 'ta', tag: 'textarea', __visible: 1, __editable: 0 };
  const visibleTextbox = { aria: 'Message', tag: 'div', __visible: 1, __editable: 1 };
  const ranked = rankComposers([visibleTextarea, visibleTextbox]);
  assert.equal(ranked[0], 'Message');
});

test('composer ranking: hidden elements always last', () => {
  const hidden = { id: 'hidden', __visible: 0, __editable: 0 };
  const visible = { aria: 'prompt', __visible: 1, __editable: 0 };
  const ranked = rankComposers([hidden, visible]);
  assert.equal(ranked[0], 'prompt');
});
