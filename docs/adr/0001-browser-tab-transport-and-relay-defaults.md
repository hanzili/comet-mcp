# ADR 0001: Browser-tab transport and relay defaults

- **Status:** Accepted
- **Date:** 2026-07-28
- **Decision owners:** Comet-MCP project

## Context

Comet-MCP is intended to evolve from a single-provider, single-tab bridge into a multi-provider conversation backbone. The initial providers are Perplexity, Grok, Gemini, ChatGPT, and Claude.ai, each operating in an independent tab within one Comet browser profile.

Provider browser interfaces are dynamic and may be subject to selector drift, login expiry, rate limits, CAPTCHA/anomaly checks, plan restrictions, and provider terms. A relayed provider response is also untrusted content: an attribution header improves provenance but does not neutralize prompt injection or guarantee a receiving provider will accept the content.

## Decision

### Transport

1. **Comet browser tabs are the initial provider transport.** Each provider interaction is performed through a tab-specific adapter over CDP.
2. **One Comet process and one shared authenticated browser profile are in scope for v1.** A tab registry and CDP session pool provide isolation at the tab/session level.
3. **Browser transport is replaceable.** The control plane and conversation fabric must depend on provider-neutral contracts, so official APIs or other transports can be added later without rewriting routing, policy, persistence, or scheduling.

### Scope boundaries

The following are out of scope for v1:

- Multiple Comet processes or browser profiles.
- Multi-account isolation.
- A full visual selector-picker interface.
- Fully autonomous provider-to-provider conversations.
- A generic browser automation platform replacing Comet.
- Guaranteed compatibility with every provider UI, plan, or account state.

### Relay policy

1. **Cross-provider relay is disabled or client-approval-required by default.** A provider response is never automatically transmitted to another provider solely because it was received.
2. Every relay must preserve source provenance and use a durable conversation envelope and delivery receipt.
3. Relay policy must enforce an explicit mode, content-size limit, deadline, destination-provider enablement, and attribution header when the relay is allowed.
4. A wrapper or attribution header is an audit/provenance control, not a claim of safety or classifier bypass.
5. An uncertain delivery outcome is surfaced as `unknown`; the server must not silently resend the conversational content.

### Persistence and privacy

1. Persist only the data needed for recovery, auditing, selector overrides, and health observation.
2. Store selector overrides, session state, and append-only health observations locally under the user’s Comet-MCP data directory.
3. Conversation-content persistence must support redaction or a no-content mode, because relayed conversations can contain sensitive material.
4. Provider credentials remain in the user’s existing Comet/browser profile; Comet-MCP does not copy or export them into its own persistence store.

### Operational safeguards

1. Every orchestration plan must have a maximum turn count and wall-clock deadline.
2. Provider failures are isolated by tab. A selector failure, expired login, or stalled generation in one provider must not reset or close sibling provider tabs.
3. Provider adapters expose structured health, including hook-resolution source and `login_required`/`degraded` states.
4. Live UI discovery and repair are opt-in operational workflows, not a normal hot-path dependency.

## Consequences

### Positive

- Establishes a narrow, testable first release: two independently controlled provider tabs, approved relay, durable event trail, and recovery without duplicate sends.
- Keeps provider-specific browser mechanics behind adapters.
- Makes relay policy, provenance, and uncertain-delivery behavior explicit before higher-level debate or routing features are introduced.
- Allows future API adapters to coexist with browser-tab adapters.

### Costs and risks accepted

- Provider UI changes require ongoing selector maintenance and fixture updates.
- Browser-based control can be rate-limited, challenged, blocked, or affected by provider terms.
- Shared-profile tabs do not provide multi-account isolation.
- Client approval adds interaction overhead before provider-to-provider relay.
- Persisted conversation state requires deliberate local retention and redaction controls.

## Validation

This decision is validated by P0 and subsequent phase gates:

- Measure the safe concurrent CDP tab limit on the actual Comet endpoint.
- Demonstrate independent operation of Perplexity and Grok tabs.
- Demonstrate one approval-required relay with provenance and a delivery receipt.
- Demonstrate that an uncertain send is surfaced without duplicate resend.

## Related documents

- [Build plan](../build-plan.md)
- [Complete Turn-02 synthesis](../design/02-turn-02-complete-synthesis-phases-and-task-list.md)
- [Accepted risks](../accepted-risks.md) — to be created during operational hardening.

