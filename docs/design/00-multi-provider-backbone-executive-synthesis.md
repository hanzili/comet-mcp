# Comet-MCP Multi-Provider Conversation Backbone

## Executive synthesis

Build Comet-MCP as a provider-neutral conversation fabric with browser-tab automation as its first transport, not as a Perplexity driver enlarged to five websites.

The project needs a provider registry and common driver contract, independent Comet tabs controlled through concurrent CDP sessions, offline/on-demand selector discovery, and explicit handling for selector drift, login expiry, streaming state, and browser UI differences.

The central design rule is: **the primary abstraction is a conversation event and delivery receipt, not a raw message copied from one tab into another.** This makes relay, recovery, scheduling, provenance, and future API-based providers possible without coupling them to the Comet UI.

## Scope

An MCP client can coordinate independent Comet tabs for Perplexity, Grok, Gemini, ChatGPT, and Claude.ai; collect responses concurrently; and perform policy-controlled, approval-required relays between providers.

Version-one non-goals are multiple Comet processes, multi-account isolation, fully autonomous provider-to-provider conversations, a visual selector picker, and replacing Comet with generic browser automation.

## Architecture

```text
MCP client -> control plane -> conversation fabric -> provider adapters -> Comet tabs
```

The control plane owns MCP tools, approval, budgets, cancellation, and health. The conversation fabric owns append-only events, provenance, relay-policy decisions, idempotency keys, and delivery receipts. Provider adapters use browser tabs initially and may later be joined by official API transports.

Every send uses a `ConversationEnvelope` with a correlation/idempotency key, source/destination, content, untrusted provenance, relay mode, approval state, and bounded budget. Every send has a receipt: `queued`, `sent`, `accepted`, `completed`, `blocked`, `timed_out`, or `unknown`.

## Core implementation direction

- Define `ChatDriver`, `ProviderEntry`, `TabSession`, `HealthReport`, `ConversationEnvelope`, and `DeliveryReceipt` before adding providers.
- Keep one CDP session per tab in a session pool and a `Map<tabId, TabSession>` registry.
- Use known selector -> heuristic -> persisted override resolution; never cache dynamic stop buttons.
- Keep browser discovery off the hot path; use it to create and refresh provider entries and synthetic fixtures.
- Capture provider-native message IDs when available, plus response hash/version/cursor, to prevent reconnect duplicates.
- Require client approval for cross-provider relay; bound bytes, time, turns, and failed deliveries.
- Do not silently retry an uncertain conversational send.
- Return response bundles to the MCP client for ranking; do not assume the server itself is Claude.

## Delivery sequence

1. P0: Architecture decision record and measured CDP concurrency ceiling.
2. P1: Conversation fabric and Perplexity compatibility refactor.
3. P2: Grok adapter plus discovery-to-fixture validation.
4. P3: Concurrent tab registry and independent provider control.
5. P4: Approval-required relay with provenance and durable receipts.
6. P5: `wait_any`, cancellation, and a bounded resumable scheduler.
7. P6: Gemini, ChatGPT, and Claude.ai adapters.
8. P7: Optional fanout, critique, routing, and debate patterns.
9. P8: Observability, drift detection, runbooks, and release hardening.

The minimum useful release is P0-P5 with Perplexity and Grok: ask both, collect normalized results, approve one relay, persist the event chain, and recover from restart without duplicate work.

