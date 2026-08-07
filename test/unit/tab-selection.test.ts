/**
 * P3 tab-selection tests (fix 2026-08-07): getProviderTab must prefer the
 * most-recently-completed tab over the first-registered one, so default asks
 * don't hit a stale tab (observed live: default ask to the FIRST grok tab
 * gateway-timed-out while the second tab would have answered).
 *
 * Run: node --test test/unit/tab-selection.test.ts  (after npx tsc)
 */
import assert from 'node:assert';
import { test } from 'node:test';
import { tabRegistry } from '../../dist/tab-registry.js';

function session(provider, tabId, lastCompletedAt, openedAt) {
  return {
    provider, tabId, targetId: tabId, cdpSessionId: 'ws://x',
    openedAt, state: 'connected',
    ...(lastCompletedAt ? { lastCompletedAt } : {}),
  };
}

test('P3 tab selection: most-recent-completed wins over first-registered', () => {
  // directly inject into the singleton's maps (dist build = plain JS properties)
  tabRegistry.tabs = new Map();
  tabRegistry.providerTabs = new Map();
  const old = tabRegistry.tabs.get('tab-1');
  const stale = session('grok', 'tab-1', '2026-08-07T10:00:00Z', '2026-08-07T09:00:00Z');
  const fresh = session('grok', 'tab-2', '2026-08-07T12:00:00Z', '2026-08-07T09:30:00Z');
  tabRegistry.tabs.set('tab-1', stale);
  tabRegistry.tabs.set('tab-2', fresh);
  tabRegistry.providerTabs.set('grok', ['tab-1', 'tab-2']); // tab-1 registered FIRST

  const chosen = tabRegistry.getProviderTab('grok');
  assert.equal(chosen?.targetId, 'tab-2', 'default must prefer the freshest completed tab');
});

test('P3 tab selection: no completed tabs → newest openedAt wins', () => {
  tabRegistry.tabs = new Map();
  tabRegistry.providerTabs = new Map();
  tabRegistry.tabs.set('a', session('grok', 'a', null, '2026-08-07T09:00:00Z'));
  tabRegistry.tabs.set('b', session('grok', 'b', null, '2026-08-07T11:00:00Z'));
  tabRegistry.providerTabs.set('grok', ['a', 'b']);
  assert.equal(tabRegistry.getProviderTab('grok')?.targetId, 'b', 'newest openedAt wins when nothing completed');
});

test('P3 tab selection: closed tabs excluded', () => {
  tabRegistry.tabs = new Map();
  tabRegistry.providerTabs = new Map();
  tabRegistry.tabs.set('a', { ...session('grok', 'a', null, '2026-08-07T09:00:00Z'), state: 'closed' });
  tabRegistry.tabs.set('b', session('grok', 'b', null, '2026-08-07T10:00:00Z'));
  tabRegistry.providerTabs.set('grok', ['a', 'b']);
  assert.equal(tabRegistry.getProviderTab('grok')?.targetId, 'b');
});

test('P3 tab selection: no registered tabs → null', () => {
  tabRegistry.tabs = new Map();
  tabRegistry.providerTabs = new Map();
  assert.equal(tabRegistry.getProviderTab('grok'), null);
});
