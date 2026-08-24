# Perplexity critique (2026-08-07)

The plan's core sequencing bet—measure concurrency first, prove the fabric on one provider, then go heterogeneous—has been validated by execution. But P2 over-delivered while P1 under-delivered, and that asymmetry should reshape P3–P5.

1. Sequencing critique

Split P1 formally: P1a (types + Perplexity refactor) is done, but the P1 gate's replay-safety criterion cannot pass without the event-store runtime, so the gate is only partially met.
02-turn-02-complete-synthesis-phases-and-task-list.md

Re-scope P6: discovery for all five providers already shipped as a CLI/MCP tool, so P6 shrinks to driver implementation, per-provider typing/markdown quirks, and login-expiry simulation.
02-turn-02-complete-synthesis-phases-and-task-list.md

Split P5: the ship-boundary demo needs wait_any but not run_plan/step_plan. Ship P5a (wait_any) in the minimal release; defer plan machinery.
02-turn-02-complete-synthesis-phases-and-task-list.md

P3 has a hidden prerequisite: the P2 dispatcher shipped provider_ask/poll/stop before the registry exists, so it likely encodes a one-tab-per-provider singleton assumption. Audit it before P3, since the registry changes addressing from providerKey to tabId.

2. Risks: P3, P4, event store

P3's reconnect-dedup gate ("unchanged content produces no new response event") is impossible without a durable extraction cursor—making the deferred event store a P3 dependency, not just P4's.
02-turn-02-complete-synthesis-phases-and-task-list.md

P4's biggest gap is approval binding: relay_prepare → relay_send needs the approval bound to a hash of the exact envelope, single-use and expiring, or content can mutate between approval and send.

No reconciliation protocol exists for unknown delivery: the plan forbids silent retries but doesn't say how to resolve uncertainty. Specify read-only re-extraction (match content hash / providerMessageId at the destination) before any client-approved resend.
02-turn-02-complete-synthesis-phases-and-task-list.md

The P0 spike measured evaluate/insert load, not sustained five-tab streaming extraction; add per-tab poll backoff and a circuit breaker to the P3 pool.

3. Type contracts

Add schemaVersion to envelopes, receipts, and stored events—ProviderEntry has it, the fabric types don't.
02-turn-02-complete-synthesis-phases-and-task-list.md

Separate idempotencyKey from id: retries reuse the key, each attempt gets a fresh id, and receipts carry attempt numbers.

Put extraction evidence (contentHash, providerMessageId, cursor) on the DeliveryReceipt itself, and treat receipts as an append-only stream, not a mutable record.

Add taint propagation: any event derived from provider output (summary, wrapped relay) inherits trusted: false automatically; the literal false type is a good tripwire—keep it.
02-turn-02-complete-synthesis-phases-and-task-list.md

Define replay behavior for expired budget.deadlineAt: after restart, expired envelopes transition to blocked, never sent.

4. Next steps

Build a minimal event store first, then P3. Not full P1b—just append-only JSONL, an idempotency index, and durable cursor checkpoints. Rationale: P3's own gate depends on it, the scope is days not weeks, and retrofitting persistence into a finished registry means touching it twice. Minimal path: P1b-minimal → P3 (registry, CDP pool, open/list/close/health, scoped reset, reconnect dedup) → P4 (approval-bound relay, receipts, redaction, unknown-delivery reconciliation) → P5a (wait_any). That satisfies all six ship-boundary

---

## Markdown

Define replay behavior for expired `budget.deadlineAt`: after restart, expired envelopes transition to blocked, never sent.
