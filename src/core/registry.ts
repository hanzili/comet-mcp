/**
 * Provider registry — loads, validates, and resolves provider entries.
 *
 * Entries are DATA (JSON in src/providers/entries/), written directly by the discovery
 * engine (src/core/discovery.ts). This module is the single reader: drivers resolve
 * controls through it using known selector → heuristic → persisted override, so a
 * provider DOM change is repaired by re-running discovery and committing the new JSON —
 * no code changes (ADR 0001 §Transport 3, build plan discovery workflow).
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ProviderEntry, ProviderControl, ProviderControlName } from '../types/provider.js';
import type { ProviderId } from '../types/conversation.js';

/** Package root = dir containing package.json, found by walking up from this file. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return dir;
}

/** Entries live in src/providers/entries (source of truth, git-committed). */
export const ENTRIES_DIR = join(packageRoot(), 'src', 'providers', 'entries');

/** Validation errors found while loading an entry. */
export interface EntryValidationIssue {
  provider: string;
  field: string;
  problem: string;
}

const CONTROL_NAMES: ProviderControlName[] = [
  'composer', 'sendButton', 'modelPicker', 'newChat',
  'userMessage', 'assistantMessage', 'workingIndicator', 'responseContainer',
];

/** Basic structural validation of a parsed entry (no external deps). */
export function validateEntry(raw: unknown): { ok: true; entry: ProviderEntry } | { ok: false; issues: EntryValidationIssue[] } {
  const issues: EntryValidationIssue[] = [];
  if (!raw || typeof raw !== 'object') return { ok: false, issues: [{ provider: '?', field: 'root', problem: 'not an object' }] };
  const e = raw as Record<string, unknown>;

  const str = (f: string): string => {
    const v = e[f];
    if (typeof v === 'string' && v.length > 0) return v;
    issues.push({ provider: String(e.provider ?? '?'), field: f, problem: 'missing or empty' });
    return '';
  };
  const provider = str('provider');
  const url = str('url');
  const version = str('version');
  const discoveredAt = str('discoveredAt');
  const method = str('method');

  const confidence = e.confidence;
  if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') {
    issues.push({ provider, field: 'confidence', problem: `invalid: ${String(confidence)}` });
  }

  const controls = (e.controls && typeof e.controls === 'object') ? e.controls as Record<string, unknown> : {};
  if (!e.controls || typeof e.controls !== 'object') {
    issues.push({ provider, field: 'controls', problem: 'missing' });
  } else {
    for (const name of CONTROL_NAMES) {
      const c = controls[name];
      if (c === undefined) continue; // provider-specific subset is fine
      if (!c || typeof c !== 'object' || typeof (c as ProviderControl).selector !== 'string') {
        issues.push({ provider, field: `controls.${name}`, problem: 'invalid control (selector required)' });
      }
    }
  }

  const heuristics = (e.heuristics && typeof e.heuristics === 'object') ? e.heuristics as Record<string, unknown> : {};
  if (!e.heuristics || typeof e.heuristics !== 'object') {
    issues.push({ provider, field: 'heuristics', problem: 'missing' });
  } else {
    for (const f of ['composerFallback', 'sendButtonFallback', 'responseFallback', 'stopDetection']) {
      if (typeof heuristics[f] !== 'string') issues.push({ provider, field: `heuristics.${f}`, problem: 'missing' });
    }
    if (!heuristics.stateMachine || typeof heuristics.stateMachine !== 'object') {
      issues.push({ provider, field: 'heuristics.stateMachine', problem: 'missing' });
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, entry: raw as ProviderEntry };
}

/** Load one entry file. */
export function loadEntry(provider: ProviderId): ProviderEntry | null {
  const path = join(ENTRIES_DIR, `${provider}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const result = validateEntry(raw);
    return result.ok ? result.entry : null;
  } catch {
    return null;
  }
}

/** Load all entries that have files. */
export function loadAllEntries(): Map<ProviderId, ProviderEntry> {
  const map = new Map<ProviderId, ProviderEntry>();
  if (!existsSync(ENTRIES_DIR)) return map;
  for (const f of readdirSync(ENTRIES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const provider = f.replace(/\.json$/, '') as ProviderId;
    const entry = loadEntry(provider);
    if (entry) map.set(provider, entry);
  }
  return map;
}

/** Persist an entry produced by discovery. Returns the written path. */
export function writeEntry(entry: ProviderEntry): string {
  mkdirSync(ENTRIES_DIR, { recursive: true });
  const path = join(ENTRIES_DIR, `${entry.provider}.json`);
  writeFileSync(path, JSON.stringify(entry, null, 2) + '\n');
  return path;
}

/** Resolve a control's best selector from an entry (known selector → alias). */
export function resolveControl(entry: ProviderEntry, name: ProviderControlName): string | null {
  const control = entry.controls[name];
  return control?.selector ?? null;
}

/** All selectors an entry carries, for health/verify checks. */
export function allControlSelectors(entry: ProviderEntry): { name: ProviderControlName; selector: string; conditional: boolean }[] {
  const out: { name: ProviderControlName; selector: string; conditional: boolean }[] = [];
  for (const name of CONTROL_NAMES) {
    const control = entry.controls[name];
    if (control?.selector) out.push({ name, selector: control.selector, conditional: control.conditional === true });
  }
  return out;
}
