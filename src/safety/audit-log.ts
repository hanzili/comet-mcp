// Ring-buffer audit log for URL-policy decisions.
//
// Every checkUrl() outcome (allow OR deny) goes through here so callers
// and the user can inspect what got blocked and why. Bounded by max
// entries so a misbehaving caller can't OOM the process. Pure data + pure
// functions; no CDP, no I/O.
//
// The log is intentionally in-memory. For audit-grade persistence,
// export the entries and pipe to a file/socket at the call site.

export type AuditOutcome = 'allow' | 'deny';

export interface AuditEntry {
  /** ISO timestamp the decision was made. */
  ts: string;
  /** MCP tool name that triggered the check (or 'manual' for direct calls). */
  caller: string;
  /** The URL that was evaluated. */
  url: string;
  /** Allow or deny. */
  outcome: AuditOutcome;
  /** Denial reason (one of BlockedUrlReason). Undefined when outcome='allow'. */
  reason?: string;
  /** Free-text context (e.g. which policy field triggered the deny). */
  note?: string;
}

/** Default ring-buffer size. ~10KB at typical entry size (200 bytes). */
const DEFAULT_MAX_ENTRIES = 500;

/** Internal: FIFO ring buffer of AuditEntry. */
class AuditRing {
  private buf: AuditEntry[] = [];
  constructor(private max: number = DEFAULT_MAX_ENTRIES) {}

  push(e: AuditEntry): void {
    this.buf.push(e);
    if (this.buf.length > this.max) this.buf.shift();
  }

  /** Most recent N entries, newest first. */
  recent(n: number = 50): AuditEntry[] {
    return this.buf.slice(-Math.max(0, n)).reverse();
  }

  /** All entries that match a filter predicate, newest first. */
  filter(pred: (e: AuditEntry) => boolean): AuditEntry[] {
    return this.buf.filter(pred).reverse();
  }

  /** Total number of recorded decisions (allow + deny). */
  size(): number {
    return this.buf.length;
  }

  /** Wipe the buffer — used by tests and `comet_reset_audit_log`. */
  clear(): void {
    this.buf = [];
  }

  /** Reset the cap. Test-only; production calls this at most once at boot. */
  setMax(max: number): void {
    this.max = max;
    if (this.buf.length > max) this.buf.splice(0, this.buf.length - max);
  }
}

const audit = new AuditRing();

export function getAuditLog(): AuditRing {
  return audit;
}

/** Override the singleton's cap. Use sparingly — primarily from tests. */
export function setMaxEntries(max: number): void {
  audit.setMax(max);
}

/**
 * Record a decision. Returns the entry that was stored so callers can
 * surface it if they want.
 */
export function recordDecision(
  caller: string,
  url: string,
  outcome: AuditOutcome,
  reason?: string,
  note?: string,
): AuditEntry {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    caller,
    url,
    outcome,
    reason,
    note,
  };
  audit.push(entry);
  return entry;
}

/** Convenience: record a denial from a BlockedUrlError-shaped object. */
export function recordDenial(
  caller: string,
  url: string,
  reason: string,
  message: string,
): AuditEntry {
  return recordDecision(caller, url, 'deny', reason, message);
}

/** Convenience: record an allow. */
export function recordAllow(caller: string, url: string, note?: string): AuditEntry {
  return recordDecision(caller, url, 'allow', undefined, note);
}
