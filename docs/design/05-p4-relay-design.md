# P4 — Safe relay and shared conversation state (design, two-provider review)

**Status:** ✅ IMPLEMENTED 2026-08-09 — R1–R9 all landed (commits f652ed3 → this;
ADR 0008; 199/199 tests). Deferred to P4b: summarization handoff.
**Sources:** [Grok consultation](../../responses/grok-p4-consultation-2026-08-08.md)
(9594 chars, active tab); [Claude consultation](../../responses/claude-p4-consultation-2026-08-08.md)
(7775 chars, via MCP). Turn-02 §P4; ADR 0001 (relay defaults), ADR 0002
(fabric types), ADR 0007 (async-ask late reconciliation — the state machine P4
reconciliation inherits).

## 1. Convergence (both providers agree)

1. **ContentPersistenceMode / redaction lands FIRST** — it shapes the event
   schema everything else writes into; retrofitting redaction after relay
   traffic flows creates audit holes (Grok #8 → front of critical path; Claude
   build order #2).
2. **Approval = hash of the EXACT envelope**: canonicalize before hashing, hash
   content + policy + destination together (not content alone), single-use,
   expiring. Claude refines single-use to **compare-and-swap against the
   append-only store**, not a boolean flag.
3. **No automatic resend, ever** (absolute rule). Every attempt gets an
   append-only receipt.
4. **Summarization handoff is deferred** (P4b) — not required by the gate,
   collides with approval-binding scope.
5. **Relay consumes only terminal-success source events** (completed /
   completed_late) — never watching/abandoned (Grok §7).
6. **Closed-tab escalation analogue required** (Claude's new flag; Grok's
   "surface gone" framing): relay reconciliation must distinguish
   surface-gone from slow, with a distinct terminal state — reuse the
   async-ask `TAB_CLOSED` pattern, don't reinvent.
7. **Reconciliation reuses the async-ask state machine** — one shared "what
   does unknown mean" logic (Claude §7: the exact failure mode that produced
   the original bridge bug).
8. **wait_any (P5a) is held** until single-item reconciliation is trustworthy
   (Claude §7 — stronger than before).
9. **Markdown on the wire is a trust-boundary control, not a formatting
   concern** (Claude's security reading; grok's preservation concern handled as
   an opt-in).

## 2. Divergences and resolutions

| Topic | Grok | Claude | Resolution |
| --- | --- | --- | --- |
| Tool surface | 2 tools: relay_prepare + relay_send (no relay_approve — single-client approval is a hashed token; a third tool adds state-machine surface) | **3 tools**: relay_prepare → relay_approve → relay_send (collapsing approval into a send flag reopens a TOCTOU gap; no independent record of what was approved) | **3 tools.** `relay.approved`/`relay.rejected` events already exist; Claude's TOCTOU + audit argument is decisive. Non-approval modes emit an auto-approved receipt through the same tools (one state-machine shape). |
| Markdown on the wire | Content-preserving opaque byte string; no sanitization without a concrete threat model; normalization belongs in destination drivers | Structural markdown (fenced blocks, links/images) is an instruction-smuggling vector into a second model's context; default to strip/neutralize in approval-required mode; raw pass-through opt-in | **Security-first default (Claude)**: neutralize structural markdown in approval-required mode (strip link URLs to text, remove embedded media, fence code blocks); `relayPolicy.rawMarkdown: true` opt-in for grok's preservation case. Text content is preserved; only structure is bounded. |
| Single-use enforcement | approvalHash + `used: boolean` in the store | **compare-and-swap against the append-only store** | **CAS**: consume via a conditional append (approval record has `consumedBy` seq; relay_send appends only if unconsumed). |
| Reconciliation key | contentHash OR providerMessageId | **providerMessageId PRIMARY** (repeat-content collisions), contentHash secondary; explicit ambiguous/fuzzy-match third bucket | **providerMessageId primary**, contentHash secondary, explicit `ambiguous` outcome bucket (never auto-promote). |
| Persistence scope | Conversation-level config; immutable per correlation; client can't override stricter | **Per-destination** scoping; approval UI legitimately needs full content on a surface allowed to diverge from the log; audit escalation/exception paths for side-channel leakage | **Per-destination mode + conversation default**; approval UI is an allowed-divergence surface; escalation paths audited specifically (Claude's rare-branch leak warning). |
| 'redacted' spec | hash/length/provenance + marker | Needs an actual spec (truncation vs metadata-only vs PII scrub) or writers improvise; 'none' still persists hashes/ids/receipts | **Spec**: `full` = content+hashes; `redacted` = metadata-only (hashes, sourceMessageId, length, provenance, marker — no content, no PII); `none` = control plane only (ids, hashes, status, timestamps, approval refs). Reconciliation works under all three via hashes/ids. |

## 3. Final build order (both providers, reconciled)

1. **Envelope hash definition + canonicalization** (deterministic JSON: content +
   provenance + destination + policy fields; policyVersion stamped in).
2. **ContentPersistenceMode contract** (per-destination, spec'd modes above) —
   wired into the event-store write path + receipts carry the mode.
3. **Relay policy fields** — `mode` (approval-required | approved), `approved`,
   `approvalRef`, `destinationEnabled`, `attributionHeader` (**mandatory** in
   approval-required mode, fail closed if unset), `contentSizeLimitBytes`,
   `deadlineMs`, **+ `contentPersistenceMode`**, **+ `allowResend: false`
   default**, **+ `maxRelaysPerCorrelation`**, **+ `policyVersion`**,
   **+ `rawMarkdown: false` default**.
4. **relay_prepare** — select source event (terminal-success only: completed /
   completed_late), build + canonicalize + hash the envelope, eager
   size/structure/destination checks, return envelope + policy evaluation +
   `approvalRequired` + `approvalHash`. No contact with the destination.
5. **relay_approve** — record `relay.approved`/`relay.rejected` (append-only,
   approvalHash, expiresAt); approval is single-use via CAS.
6. **relay_send** — re-validate hash binding + policy + expiry, CAS-consume the
   approval, wrapped relay with provenance header, receipt every attempt
   (append-only, carries persistence mode + policyVersion), reconciliation as
   pre-flight (incl. surface-gone check). Auto-approved receipt for
   non-approval modes.
7. **Unknown-delivery reconciliation** — state machine inherited from
   async-ask (soft expiry + watching + terminal states), providerMessageId
   primary + ambiguous bucket, surface-gone → distinct terminal
   (`RELAY_SURFACE_GONE`), read-only probe, fresh client approval before any
   resend.
8. **Test matrix — crossed axes** (Claude): timed-out + destination-disabled-
   since-prepare; expired-approval + ambiguous-match; surface-gone +
   pending-approval; blocked/timed-out/uncertain without auto-resend (grok #10);
   all three persistence modes exercised (grok trap); no full-content leak in
   escalation paths under redacted/none (Claude).

**Deferred (P4b):** summarization handoff.

## 4. Gate (unchanged)

A selected provider answer can be relayed to another provider **only after
approval**, with a complete event trail (envelope → approve → send → receipt →
reconcile) and safe failure behavior (no auto-resend; distinct terminal states
for timed-out / blocked / surface-gone).

## 5. Task checklist

- [x] **R1** Envelope canonicalization + `envelopeHash` (sha256 over
      content+provenance+destination+policy, `policyVersion` stamped). — DONE 2026-08-09 (f652ed3)
- [x] **R2** ContentPersistenceMode contract (per-destination) + event-store
      write-path wiring (modes: full/redacted/none per §2 spec); receipts carry
      the mode; escalation paths audited for leakage. — DONE 2026-08-09 (194dc77)
- [x] **R3** Relay policy fields (additions above) + enforcement module
      (approval/attribution/length/markdown/deadline/enablement). — DONE 2026-08-09 (d625572)
- [x] **R4** `relay_prepare` tool (build/canonicalize/hash, eager checks,
      terminal-success source selection, approvalHash). — DONE 2026-08-09 (86d8535)
- [x] **R5** `relay_approve` tool (relay.approved/rejected events, expiry,
      single-use via CAS). — DONE 2026-08-09 (4a13e0c)
- [x] **R6** `relay_send` tool (re-validate, CAS-consume, provenance header,
      receipt every attempt, reconciliation pre-flight incl. surface-gone). — DONE 2026-08-09 (0a95492)
- [x] **R7** Reconciliation state machine (inherit async-ask soft-expiry +
      `RELAY_SURFACE_GONE` terminal; providerMessageId primary, ambiguous
      bucket; read-only probe; fresh approval before resend). — DONE 2026-08-09 (b3dd0e8)
- [x] **R8** Crossed-axis test matrix (§3.8) + all persistence modes + no-leak
      escalation audit. Full suite green. — DONE 2026-08-09 (2006ada, 199/199)
- [x] **R9** Docs: ADR 0008 (relay + approval binding), build-plan P4 row,
      Turn-02 checkboxes. — DONE 2026-08-09 (this commit)
