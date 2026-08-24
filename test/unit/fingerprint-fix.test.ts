/**
 * Self-healing fixes (2026-08-07): ephemeral framework IDs must never be primary
 * selectors or rebind targets, and discovery seeds fingerprints so the rebind
 * path has an anchor from day one.
 *
 * Found live: claude modelPicker was stored as `#base-ui-_r_cp_` (rotating
 * React/Radix id) — it broke on the first re-render, verify counted failures,
 * and because fingerprints were only captured on a SUCCESSFUL resolve, the
 * broken selector could never acquire a fingerprint → rebind (guarded on
 * fingerprint !== 0) was permanently dead. Chicken-and-egg.
 *
 * Run: node --test test/unit/fingerprint-fix.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { isEphemeralId, selectorFromElement } from '../../dist/core/fingerprint.js';

test('fix 2026-08-07: React/Radix/Base-UI ids are ephemeral', () => {
  assert.equal(isEphemeralId('base-ui-_r_cp_'), true, 'base-ui-_r_* rotates');
  assert.equal(isEphemeralId('_r_cp_'), true, '_r_* rotates');
  assert.equal(isEphemeralId('radix-:r0:'), true, 'radix-* rotates');
  assert.equal(isEphemeralId('base-ui-_r_1c_'), true);
  // stable ids are NOT ephemeral
  assert.equal(isEphemeralId('composer'), false);
  assert.equal(isEphemeralId('model-select-trigger'), false);
  assert.equal(isEphemeralId(''), false);
  assert.equal(isEphemeralId(null), false);
  assert.equal(isEphemeralId(undefined), false);
});

test('fix 2026-08-07: selectorFromElement never rebinds onto an ephemeral id', () => {
  // element with an ephemeral id but a real testid → must prefer the testid
  const fromEphemeral = selectorFromElement({ id: 'base-ui-_r_cp_', testid: 'model-picker', aria: 'Model select', tag: 'button', cls: 'some-class' });
  assert.equal(fromEphemeral, '[data-testid="model-picker"]', 'testid preferred over rotating id');
  // element with a stable id → id still wins
  const fromStable = selectorFromElement({ id: 'model-select-trigger', aria: 'Model select', tag: 'button' });
  assert.equal(fromStable, '#model-select-trigger');
  // no id at all → aria fallback (space escaped as \  — valid CSS)
  const fromAria = selectorFromElement({ aria: 'Model select', tag: 'button' });
  assert.equal(fromAria, '[aria-label="Model\\ select"]');
});

test('fix 2026-08-07: selectorFromElement falls to class when everything else is absent', () => {
  const fromClass = selectorFromElement({ tag: 'button', cls: 'px-2 hover:bg-1a2b3c hover:opacity-50' });
  // hash-like class tokens are filtered (the :hover tokens are split out by whitespace)
  assert.ok(fromClass?.startsWith('button.'), `class fallback: ${fromClass}`);
});
