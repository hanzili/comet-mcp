# Comet-MCP Build Plan

## Objective

Evolve the Perplexity-only Comet MCP bridge into a multi-provider conversation backbone. An MCP client can operate independent Comet tabs for Perplexity, Grok, Gemini, ChatGPT, and Claude.ai, collect their responses concurrently, and perform policy-controlled relays between them.

The complete rationale, architecture, detailed task list, phase gates, and test matrix are in [the complete Turn-02 synthesis](design/02-turn-02-complete-synthesis-phases-and-task-list.md). [The executive synthesis](design/00-multi-provider-backbone-executive-synthesis.md) is a concise entry point; the original Codex review is retained in [the Turn-01 critique](design/01-turn-01-critique-and-outline.md).

## Architectural rule

Browser-tab automation is a provider transport. The durable product core is a conversation fabric that records envelopes, provenance, policy decisions, and delivery receipts.

```text
MCP client -> control plane -> conversation fabric -> provider adapters -> Comet tabs
```

## Delivery phases

| Phase | Deliverable | Completion gate |
| --- | --- | --- |
| P0 | Architecture decision record and CDP concurrency spike | Measured safe concurrent-tab ceiling |
| P1 | Conversation fabric and Perplexity contract refactor | Existing behavior preserved; replay-safe deliveries |
| P2 | Grok adapter and discovery pipeline | Ask/poll/stop/health PONG validation passes |
| P3 | Concurrent tab registry and CDP session pool | Perplexity and Grok operate independently |
| P4 | Approval-required relay with provenance and receipts | Safe relay succeeds or fails explicitly |
| P5 | `wait_any` and bounded scheduler | Plans halt/resume without duplicate sends |
| P6 | Gemini, ChatGPT, and Claude.ai adapters | Each has structured degradation handling |
| P7 | Optional fanout, critique, routing, and debate | All features obey budgets and relay policy |
| P8 | Observability and operational hardening | Drift, failures, and delivery state are diagnosable |

## Initial source layout

```text
src/
  core/          Conversation fabric, delivery, tab registry, CDP pool, policy, scheduler
  providers/     Provider registry entries and limited adapter overrides
  tools/         MCP tool implementations
  types/         Conversation, provider, and driver contracts
test/
  fixtures/      Sanitized DOM/state snapshots per provider
  unit/          Contract, policy, extraction, and scheduler tests
  integration/   CDP and live opt-in integration tests
docs/
  reference/     Read-only background documents copied from Downloads
  adr/           Architecture decisions
  runbooks/      Discovery, repair, and release procedures
```

## Core safety defaults

- Cross-provider relay requires client approval.
- Every send has an idempotency key and delivery receipt.
- Plans require a turn limit and wall-clock deadline.
- A provider failure never retries an uncertain conversational send automatically.
- Provider browser UI automation may be rate-limited, blocked, or subject to provider terms; keep it opt-in and observable.

## Reference-material copy map

Copy source files from `C:\Users\Janos\Downloads` into the following folders without renaming their original contents:

| Source file | Destination |
| --- | --- |
| `doc - 07-27-26 comet-mcp-multi-agent-backbone-outline - Sonnet 5.md` | `docs/reference/01-sonnet/` |
| `doc - 07-27-26 comet-mcp-multi-agent-backbone-outline - GPT-5p6.md` | `docs/reference/02-gpt-5p6/` |
| `doc - 07-27-26 comet-mcp-multi-agent-backbone-outline - Grok 4p5.txt` | `docs/reference/03-grok-4p5/` |
| `doc - 07-27-26 comet-mcp-final-synthesis-and-task-list - Sonnet 5.md` | `docs/reference/04-sonnet-synthesis/` |
| `doc - 07-28-26 comet-mcp-final-synthesis-Expanded-task-list - Sonnet 5.md` | `docs/reference/05-expanded-synthesis/` |

Keep these documents as read-only source material. New decisions belong in `docs/adr/`; discovery results and operating instructions belong in `docs/runbooks/`.
