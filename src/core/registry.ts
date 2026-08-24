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
import type { ProviderEntry, ProviderControl, ProviderControlName, ProviderDriver } from '../types/provider.js';
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

/** Load one entry file. P6: merges the hand-authored driver section from
 * entries/<p>.driver.json (separate file — discovery never overwrites it, R1). */
export function loadEntry(provider: ProviderId): ProviderEntry | null {
  const path = join(ENTRIES_DIR, `${provider}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const result = validateEntry(raw);
    if (!result.ok) return null;
    const entry = result.entry;
    entry.driver = loadDriverSection(provider) ?? undefined;
    return entry;
  } catch {
    return null;
  }
}

/** Load the hand-authored driver section for a provider (null when absent). */
export function loadDriverSection(provider: ProviderId): ProviderDriver | null {
  const path = join(ENTRIES_DIR, `${provider}.driver.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw as ProviderDriver;
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

/** Persist an entry produced by discovery. Returns the written path.
 * P6: the hand-authored `driver` section is STRIPPED before writing — it lives
 * in entries/<p>.driver.json and discovery must never clobber it (R1). */
export function writeEntry(entry: ProviderEntry): string {
  mkdirSync(ENTRIES_DIR, { recursive: true });
  const path = join(ENTRIES_DIR, `${entry.provider}.json`);
  const { driver: _driver, ...discoveryOwned } = entry;
  writeFileSync(path, JSON.stringify(discoveryOwned, null, 2) + '\n');
  return path;
}

/** Resolve a control's best selector from an entry (known selector → alias). */
export function resolveControl(entry: ProviderEntry, name: ProviderControlName): string | null {
  const control = entry.controls[name];
  return control?.selector ?? null;
}

// ---------- ADR 0003: confidence-scored controls ----------
// Learn-only-from-success, asymmetric scoring (success +0.05, failure −0.15),
// evict below 0.3, trust threshold 0.7 (above = hot-path direct resolve).
// Mirrors Bladebro's KnowledgeBase (src/knowledge.rs).

export const CONFIDENCE_TRUST = 0.7;
export const CONFIDENCE_EVICT = 0.3;
export const CONFIDENCE_SUCCESS_INCREMENT = 0.05;
export const CONFIDENCE_FAIL_DECREMENT = 0.15;

/** Map a discovery confidence grade to a numeric start. */
export function confidenceStart(grade: 'high' | 'medium' | 'low'): number {
  return grade === 'high' ? 0.9 : grade === 'medium' ? 0.6 : 0.3;
}

/** True when the control's selector is trusted enough for hot-path direct resolve. */
export function isTrusted(control: ProviderControl | undefined): boolean {
  return !!control && (control.confidence ?? confidenceStart('medium')) >= CONFIDENCE_TRUST;
}

/**
 * Record a successful resolve: bump confidence, counters, last_validated.
 * Learn only from success — a miss never learns a new selector.
 * Returns a NEW control (immutable update).
 */
export function recordSuccess(control: ProviderControl): ProviderControl {
  const c = control.confidence ?? confidenceStart('medium');
  return {
    ...control,
    confidence: Math.min(1, c + CONFIDENCE_SUCCESS_INCREMENT),
    success_count: (control.success_count ?? 0) + 1,
    last_validated: Math.floor(Date.now() / 1000),
  };
}

/**
 * Record a failed resolve: decrement confidence (asymmetric — costs 3x a success).
 * Returns { control, evicted } — evicted=true when confidence dropped below EVICT.
 */
export function recordFailure(control: ProviderControl): { control: ProviderControl; evicted: boolean } {
  const c = control.confidence ?? confidenceStart('medium');
  const next = Math.max(0, c - CONFIDENCE_FAIL_DECREMENT);
  return {
    control: {
      ...control,
      confidence: next,
      fail_count: (control.fail_count ?? 0) + 1,
      last_validated: Math.floor(Date.now() / 1000),
    },
    evicted: next < CONFIDENCE_EVICT,
  };
}

/**
 * Resolve a control with confidence awareness (ADR 0003).
 * - trusted (≥0.7): return the stored selector unconditionally (hot path).
 * - untrusted: return the stored selector (caller will fall back to heuristics on miss).
 * - evicted (<0.3): return null — caller must use heuristics and flag discovery.
 * Returns { selector, trusted }.
 */
export function resolveWithConfidence(
  entry: ProviderEntry,
  name: ProviderControlName,
): { selector: string | null; trusted: boolean; control: ProviderControl | undefined } {
  const control = entry.controls[name];
  if (!control?.selector) return { selector: null, trusted: false, control };
  const c = control.confidence ?? confidenceStart('medium');
  if (c < CONFIDENCE_EVICT) return { selector: null, trusted: false, control };
  return { selector: control.selector, trusted: c >= CONFIDENCE_TRUST, control };
}

/**
 * Persist a control's updated confidence back into the entry file (read-modify-write
 * with a timestamp guard against concurrent writers). Returns the updated entry, or
 * null if the file vanished between load and write.
 */
export function persistControlUpdate(
  provider: ProviderId,
  name: ProviderControlName,
  updater: (control: ProviderControl) => ProviderControl,
): ProviderEntry | null {
  const entry = loadEntry(provider);
  if (!entry) return null;
  const control = entry.controls[name];
  if (!control) return null;
  entry.controls[name] = updater(control);
  writeEntry(entry);
  return entry;
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
