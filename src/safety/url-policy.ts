// URL policy — mirrors Perplexity Comet's hard-boundary checks
// (isInternalPage, isUrlBlocked, isDomainBlacklist from the comet-agent
// extension, per Zenity's reversing story). Pure functions, no CDP.

import { readFileSync, existsSync } from 'node:fs';
import { recordAllow, recordDenial } from './audit-log.js';
import { homedir } from 'node:os';
import path from 'node:path';

// ---- Blocked schemes (Comet's isInternalPage + file/url protection) ----

const INTERNAL_SCHEMES = [
  'chrome:',
  'chrome-untrusted:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-error:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
] as const;

const FILE_SCHEMES = ['file:', 'ftp:'] as const;

// ---- Blocked document extensions (file download / open protection) ----
// Mirrors Perplexity's isUrlBlocked doc-type list. Limit to "drop everything
// that could auto-execute" rather than over-blocking. NOTE: these match
// against the URL path's last segment only, so a TLD like `.com` in the host
// does NOT false-positive.
const BLOCKED_EXTENSIONS = [
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.pif', '.vbs',
  '.js', '.jse', '.wsf', '.wsh', '.ps1', '.psm1',
  '.sh', '.bash', '.command',
  '.app', '.dmg', '.pkg', '.iso', '.img',
  '.jar', '.jnlp',
] as const;

// ---- Types ----

export interface UrlPolicy {
  /** If true, reject chrome://, edge://, devtools://, etc. Default true. */
  blockInternal: boolean;
  /** If true, reject file:// and ftp://. Default true. */
  blockFile: boolean;
  /** If true, reject URLs whose path ends with a blocked extension. Default true. */
  blockDangerousExtensions: boolean;
  /** Wildcard domains allowed regardless of denylist (e.g. ["*.mycompany.com"]). */
  domainAllowlist?: string[];
  /** Wildcard domains always blocked (e.g. ["*.bank.com"]). Wins over allowlist. */
  domainDenylist?: string[];
}

/** A permissive default — blocks the dangerous stuff, allows everything else. */
export const DEFAULT_POLICY: UrlPolicy = {
  blockInternal: false,
  blockFile: true,
  blockDangerousExtensions: true,
};

/** Thrown by `assertUrlAllowed` and consumed by callers that want to surface
 * a clean error to the LLM (via `formatCaughtError`). */
export class BlockedUrlError extends Error {
  readonly url: string;
  readonly reason: BlockedUrlReason;
  constructor(url: string, reason: BlockedUrlReason, message: string) {
    super(message);
    this.name = 'BlockedUrlError';
    this.url = url;
    this.reason = reason;
  }
}

export type BlockedUrlReason =
  | 'internal-scheme'
  | 'file-scheme'
  | 'dangerous-extension'
  | 'domain-denylist'
  | 'malformed-url';

/** Reason returned by `checkUrl` for callers that want to log / branch
 * without throwing. */
export interface UrlCheckResult {
  allowed: boolean;
  reason?: BlockedUrlReason;
  /** Human-readable explanation, always populated when allowed=false. */
  message?: string;
}

// ---- Pure checks ----

/** True if the URL uses a browser-internal scheme (chrome://, etc.). */
export function isInternalUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return INTERNAL_SCHEMES.some((s) => lower.startsWith(s));
}

/** True if the URL uses a local file scheme. */
export function isFileUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return FILE_SCHEMES.some((s) => lower.startsWith(s));
}

/**
 * True if the URL PATH ends with one of the blocked document extensions.
 * Strips query string and fragment first. CRITICAL: only checks the path's
 * last segment, never the full URL — otherwise TLDs like `.com` would
 * false-positive on `https://example.com`.
 */
export function isBlockedDocType(url: string): boolean {
  if (!url) return false;
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    const noQuery = url.split('?')[0]!.split('#')[0]!;
    pathname = noQuery;
  }
  const lower = pathname.toLowerCase();
  const lastSegment = lower.split('/').pop() ?? '';
  if (!lastSegment || lastSegment.endsWith('/')) return false;
  const dot = lastSegment.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = lastSegment.slice(dot);
  return BLOCKED_EXTENSIONS.some((e) => ext === e);
}

/**
 * Extract the registrable host (no scheme, no path, no port, lowercased).
 * Returns null for malformed URLs.
 */
export function extractHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Wildcard match: pattern may start with `*.` to mean "this domain and
 * any subdomain". Examples:
 *   matchWildcard('www.perplexity.ai', '*.perplexity.ai') → true
 *   matchWildcard('perplexity.ai', '*.perplexity.ai')     → true
 *   matchWildcard('evil.com',       '*.perplexity.ai')     → false
 *   matchWildcard('www.perplexity.ai', 'perplexity.ai')    → true (no leading *.)
 */
export function matchWildcard(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith('.' + suffix);
  }
  return h === p;
}

// ---- Combined check ----

/**
 * Evaluate `url` against `policy`. Returns an allow/deny verdict with a
 * human-readable reason on deny. Never throws.
 */
export function checkUrl(url: string, policy: UrlPolicy = DEFAULT_POLICY): UrlCheckResult {
  if (!url || typeof url !== 'string') {
    return { allowed: false, reason: 'malformed-url', message: 'URL is empty or not a string' };
  }

  if (policy.blockInternal && isInternalUrl(url)) {
    return {
      allowed: false,
      reason: 'internal-scheme',
      message: `Refusing to navigate to internal browser URL: ${url}`,
    };
  }

  if (policy.blockFile && isFileUrl(url)) {
    return {
      allowed: false,
      reason: 'file-scheme',
      message: `Refusing to navigate to local filesystem URL: ${url}`,
    };
  }

  if (policy.blockDangerousExtensions && isBlockedDocType(url)) {
    return {
      allowed: false,
      reason: 'dangerous-extension',
      message: `Refusing to navigate to executable document: ${url}`,
    };
  }

  const host = extractHost(url);
  if (host) {
    // Denylist wins over allowlist (security-first).
    if (policy.domainDenylist?.some((p) => matchWildcard(host, p))) {
      return {
        allowed: false,
        reason: 'domain-denylist',
        message: `Refusing to navigate to denylisted domain: ${host}`,
      };
    }
    if (
      policy.domainAllowlist &&
      policy.domainAllowlist.length > 0 &&
      !policy.domainAllowlist.some((p) => matchWildcard(host, p))
    ) {
      return {
        allowed: false,
        reason: 'domain-denylist', // semantic: not on the allowlist
        message: `Refusing to navigate to ${host}: not on the allowlist`,
      };
    }
  } else if (
    policy.domainAllowlist ||
    (policy.domainDenylist && policy.domainDenylist.length > 0)
  ) {
    return {
      allowed: false,
      reason: 'malformed-url',
      message: `Refusing URL with no host while policy lists allow/deny patterns: ${url}`,
    };
  }

  return { allowed: true };
}

/**
 * Throwing variant of `checkUrl`. Use inside `cometClient.navigate` and any
 * other call site that drives the browser.
 */
export function assertUrlAllowed(url: string, policy: UrlPolicy = DEFAULT_POLICY): void {
  const result = checkUrl(url, policy);
  if (!result.allowed) {
    throw new BlockedUrlError(url, result.reason ?? 'malformed-url', result.message ?? 'URL blocked');
  }
}

/**
 * Side-effectful wrapper around `checkUrl`: evaluates the URL against the
 * policy AND records the decision to the audit log. Use this from call
 * sites that drive the browser (navigate, newTab, connect target check).
 * `caller` is the MCP tool name (or 'manual' for direct invocations).
 *
 * Returns the same UrlCheckResult as `checkUrl` so callers can branch on it
 * without re-doing the work.
 */
export function evaluateUrl(
  url: string,
  policy: UrlPolicy = DEFAULT_POLICY,
  caller: string = 'manual',
): UrlCheckResult {
  const result = checkUrl(url, policy);
  if (result.allowed) {
    recordAllow(caller, url);
  } else {
    recordDenial(caller, url, result.reason ?? 'malformed-url', result.message ?? 'URL blocked');
  }
  return result;
}

// ---- Mutable in-memory policy holder ----

class PolicyRegistry {
  private current: UrlPolicy = { ...DEFAULT_POLICY };

  get(): UrlPolicy {
    return {
      ...this.current,
      domainAllowlist: this.current.domainAllowlist ? [...this.current.domainAllowlist] : undefined,
      domainDenylist: this.current.domainDenylist ? [...this.current.domainDenylist] : undefined,
    };
  }

  set(next: UrlPolicy): void {
    this.current = {
      ...next,
      domainAllowlist: next.domainAllowlist ? [...next.domainAllowlist] : undefined,
      domainDenylist: next.domainDenylist ? [...next.domainDenylist] : undefined,
    };
  }

  /** Reset to defaults — for tests / `comet_set_url_policy {reset:true}`. */
  reset(): void {
    this.current = { ...DEFAULT_POLICY };
  }
}

export const policyRegistry = new PolicyRegistry();

/** Convenience for call sites. */
export function getActivePolicy(): UrlPolicy {
  return policyRegistry.get();
}

/** Convenience for `comet_set_url_policy` tool. */
export function setActivePolicy(next: UrlPolicy): void {
  policyRegistry.set(next);
}

/** Convenience for the same tool's "reset to defaults" action. */
export function resetActivePolicy(): void {
  policyRegistry.reset();
}

// ---- Hot-loaded JSON policies ----

/**
 * Resolve the JSON file to load a saved policy from. Order:
 *   1. $COMET_URL_POLICY env var
 *   2. ~/.comet-mcp/url-policy.json
 * Returns null if neither exists. Caller may fall back to DEFAULT_POLICY.
 */
export function resolvePolicyPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string | null {
  const candidates = [
    env.COMET_URL_POLICY,
    path.join(home, '.comet-mcp', 'url-policy.json'),
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

/**
 * Load a policy from disk. Throws on malformed JSON so the caller can
 * surface it. Defaults applied via `normalizePolicy`.
 */
export function loadPolicyFromFile(
  p: string,
  reader: (path: string, encoding: 'utf8') => string = (q) => readFileSync(q, 'utf8'),
): UrlPolicy {
  const raw = reader(p, 'utf8');
  const parsed = JSON.parse(raw);
  return normalizePolicy(parsed);
}

/** Apply defaults for any missing boolean flag, drop unknown keys. */
export function normalizePolicy(input: unknown): UrlPolicy {
  if (!input || typeof input !== 'object') {
    return { ...DEFAULT_POLICY };
  }
  const obj = input as Partial<UrlPolicy> & Record<string, unknown>;
  return {
    blockInternal: typeof obj.blockInternal === 'boolean' ? obj.blockInternal : DEFAULT_POLICY.blockInternal,
    blockFile: typeof obj.blockFile === 'boolean' ? obj.blockFile : DEFAULT_POLICY.blockFile,
    blockDangerousExtensions: typeof obj.blockDangerousExtensions === 'boolean'
      ? obj.blockDangerousExtensions
      : DEFAULT_POLICY.blockDangerousExtensions,
    domainAllowlist: Array.isArray(obj.domainAllowlist)
      ? (obj.domainAllowlist as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
    domainDenylist: Array.isArray(obj.domainDenylist)
      ? (obj.domainDenylist as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
  };
}
