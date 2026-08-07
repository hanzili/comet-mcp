# Grok critique (2026-08-07)

Critique of the Comet-MCP phase plan vs. current state (2026-08-07)

The plan remains strong: provider-neutral fabric first, tabs as independent sessions, approval-required relay, and measurable gates. Current progress (P0 complete, P1 types + Perplexity driver, P2 Grok + discovery shipped for all five providers) validates the core thesis faster than the original sequence expected. Discovery is no longer a P2/P6 artifact; it is production tooling (CLI + MCP, ADR 0003 self-healing). This compresses later work and surfaces a few sequencing and scope mismatches.

1. Sequencing and scope

Sequencing is mostly right, but two adjustments are warranted.

Finish the P1 event-store half before full P3. Types and Perplexity compatibility exist; the runtime store (idempotency keys, receipts, correlation) was deliberately deferred. P3’s reconnect logic and P4’s delivery receipts both need it. Building the store now prevents rework when multi-tab reconnects and relay attempts appear.
P6 is largely discovery-complete. Adapters remain, but the expensive discovery/fixture work is done. Keep P6 focused on wiring the three remaining drivers + per-provider health and typing/markdown settings; do not re-run the full discovery workflow.
Do not inflate P3. The tab registry + CDP pool is the correct next infrastructure, but keep last-tab protection, scoped reset, and independent degradation as the hard gate. Avoid sneaking in plan or relay primitives.

No phase needs splitting; P5 (wait_any + bounded plans) correctly stays after the fabric and multi-tab layer are solid.

2. Biggest risks/gaps (P3, P4, event store)
Event store is the silent dependency. Without durable envelopes + receipts, reconnects in P3 and uncertain deliveries in P4 cannot be made idempotent. The plan correctly forbids silent resend of conversational content; the store is the mechanism that makes that enforceable.
P3 concurrency surface. The P0 spike proved 5 tabs are stable under synthetic load. Real multi-provider work (different typing models, stop-button absence on Grok Fast, login expiry) will surface cross-tab effects the spike did not. Session-pool lifecycle and “never cache dynamic nodes” must be iron-clad.
P4 delivery uncertainty. unknown is already in the DeliveryState union—good. The gap is operational: how long to wait before declaring unknown, how the client is told, and how the store prevents a later poll from looking like a new completion.
3. Architecture / type contracts

ConversationEnvelope and DeliveryReceipt are well-designed. Minor tightenings:

Make provenance.trusted always false for any browser-derived content (already the spirit); add an explicit sourceContentHash on the envelope so reconnects can dedupe without relying solely on provider-native IDs.
Add a cursor / version field to extraction results (plan already mentions this under P3) so the fabric can distinguish “same content, new poll” from “new content.”
Keep the fabric as the sole owner of conversation identity; never let a tab’s local history become the source of truth for cross-provider events.

No larger redesign is required.

4. Best next steps and minimal path to useful release

Do the deferred P1 runtime event store first, then P3.

Reason: the store is small, unblocks both reconnect safety (P3) and receipt recording (P4), and can be unit-tested against the existing types without browser involvement. Once the store exists, implement the P3 tab registry + CDP pool + independent open/list/close/health for the two live providers. That yields the “two independent tabs, ask both, poll, degrade one without affecting the other” gate.

Minimal path to the stated ship boundary (P0–P5, Perplexity + Grok only):

Event-store runtime (finish P1).
P3 multi-tab control plane (registry, pool, independent lifecycle).
P4 approval relay + receipts (using the store).
P5 wait_any + bounded run_plan/step_plan.

Gemini/ChatGPT/Claude stay out of the critical path. Target: two live providers, durable envelopes, approval-gated relay, no duplicate sends on restart or uncertain delivery.

5. Under-weighted operational/security concerns
Selector drift & self-healing. Discovery is shipped and fingerprint rebind exists, but the plan still under-emphasizes continuous health-log observation of confidence decay. Surface “last successful high-confidence verification” in provider_health early.
Prompt injection via relay. Wrapped mode + forced attribution header is necessary but not sufficient. Bound content size aggressively and treat every relayed body as untrusted input to the destination model.
Provenance & redaction. Cross-provider logs can contain sensitive material. Make redaction / no-content logging a first-class config before P4 ships, not an afterthought.
Terms / rate-limit / CAPTCHA. The plan acknowledges them; operational posture should default to “fail the individual provider, never the fabric” and never auto-retry a conversational send after an unknown receipt.

Overall the plan is still the right backbone. Closing the event-store gap, locking P3 independence, then shipping the two-provider vertical slice (ask → poll → approved relay → durable trail) is the highest-leverage sequence.

---

## Markdown

Worked for 5s

**Critique of the Comet-MCP phase plan vs. current state (2026-08-07)**

The plan remains strong: provider-neutral fabric first, tabs as independent sessions, approval-required relay, and measurable gates. Current progress (P0 complete, P1 types + Perplexity driver, P2 Grok + discovery shipped for all five providers) validates the core thesis faster than the original sequence expected. Discovery is no longer a P2/P6 artifact; it is production tooling (CLI + MCP, ADR 0003 self-healing). This compresses later work and surfaces a few sequencing and scope mismatches.

### 1\. Sequencing and scope

Sequencing is mostly right, but two adjustments are warranted.

-   **Finish the P1 event-store half before full P3.** Types and Perplexity compatibility exist; the runtime store (idempotency keys, receipts, correlation) was deliberately deferred. P3’s reconnect logic and P4’s delivery receipts both need it. Building the store now prevents rework when multi-tab reconnects and relay attempts appear.
-   **P6 is largely discovery-complete.** Adapters remain, but the expensive discovery/fixture work is done. Keep P6 focused on wiring the three remaining drivers + per-provider health and typing/markdown settings; do not re-run the full discovery workflow.
-   **Do not inflate P3.** The tab registry + CDP pool is the correct next infrastructure, but keep last-tab protection, scoped reset, and independent degradation as the hard gate. Avoid sneaking in plan or relay primitives.

No phase needs splitting; P5 (wait\_any + bounded plans) correctly stays after the fabric and multi-tab layer are solid.

### 2\. Biggest risks/gaps (P3, P4, event store)

-   **Event store is the silent dependency.** Without durable envelopes + receipts, reconnects in P3 and uncertain deliveries in P4 cannot be made idempotent. The plan correctly forbids silent resend of conversational content; the store is the mechanism that makes that enforceable.
-   **P3 concurrency surface.** The P0 spike proved 5 tabs are stable under synthetic load. Real multi-provider work (different typing models, stop-button absence on Grok Fast, login expiry) will surface cross-tab effects the spike did not. Session-pool lifecycle and “never cache dynamic nodes” must be iron-clad.
-   **P4 delivery uncertainty.** unknown is already in the DeliveryState union—good. The gap is operational: how long to wait before declaring unknown, how the client is told, and how the store prevents a later poll from looking like a new completion.

### 3\. Architecture / type contracts

ConversationEnvelope and DeliveryReceipt are well-designed. Minor tightenings:

-   Make provenance.trusted always false for any browser-derived content (already the spirit); add an explicit sourceContentHash on the envelope so reconnects can dedupe without relying solely on provider-native IDs.
-   Add a cursor / version field to extraction results (plan already mentions this under P3) so the fabric can distinguish “same content, new poll” from “new content.”
-   Keep the fabric as the sole owner of conversation identity; never let a tab’s local history become the source of truth for cross-provider events.

No larger redesign is required.

### 4\. Best next steps and minimal path to useful release

**Do the deferred P1 runtime event store first, then P3.**

Reason: the store is small, unblocks both reconnect safety (P3) and receipt recording (P4), and can be unit-tested against the existing types without browser involvement. Once the store exists, implement the P3 tab registry + CDP pool + independent open/list/close/health for the two live providers. That yields the “two independent tabs, ask both, poll, degrade one without affecting the other” gate.

Minimal path to the stated ship boundary (P0–P5, Perplexity + Grok only):

1.  Event-store runtime (finish P1).
2.  P3 multi-tab control plane (registry, pool, independent lifecycle).
3.  P4 approval relay + receipts (using the store).
4.  P5 wait\_any + bounded run\_plan/step\_plan.

Gemini/ChatGPT/Claude stay out of the critical path. Target: two live providers, durable envelopes, approval-gated relay, no duplicate sends on restart or uncertain delivery.

### 5\. Under-weighted operational/security concerns

-   **Selector drift & self-healing.** Discovery is shipped and fingerprint rebind exists, but the plan still under-emphasizes continuous health-log observation of confidence decay. Surface “last successful high-confidence verification” in provider\_health early.
-   **Prompt injection via relay.** Wrapped mode + forced attribution header is necessary but not sufficient. Bound content size aggressively and treat every relayed body as untrusted input to the destination model.
-   **Provenance & redaction.** Cross-provider logs can contain sensitive material. Make redaction / no-content logging a first-class config before P4 ships, not an afterthought.
-   **Terms / rate-limit / CAPTCHA.** The plan acknowledges them; operational posture should default to “fail the individual provider, never the fabric” and never auto-retry a conversational send after an unknown receipt.

Overall the plan is still the right backbone. Closing the event-store gap, locking P3 independence, then shipping the two-provider vertical slice (ask → poll → approved relay → durable trail) is the highest-leverage sequence.
