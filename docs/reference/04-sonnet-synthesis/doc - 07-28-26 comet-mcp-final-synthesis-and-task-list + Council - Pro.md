<img src="https://r2cdn.perplexity.ai/pplx-full-logo-primary-dark%402x.png" style="height:64px;margin-right:32px"/>

# @GitHub study the doc...md deeply Turn-02 Comet-mcp 07-27-26 Query:

reflect, comment, critique, improve the attached doc...md and synthesize an outline to realize the Goal: Evolve comet-mcp from a single-provider (Perplexity), single-tab MCP server into a backbone that lets an MCP client (Claude) orchestrate conversations across several AI providers simultaneously (Grok, Gemini, ChatGPT, Claude.ai, Perplexity), each living in its own Comet tab, and optionally relay messages between those providers — not just between Claude and one provider at a time. Reports of Sonnet and Grok 4.5 are based on your findings in this thread. Be creative.

Turn-2 07-28-26
Concept Tags: critique, synthesis, multi-agent, MCP, relay, provider-registry, test-matrix, CDP, resilience, architecture

The new attached document is materially better than the first one. It has crossed from “good architectural essay” into “credible implementation brief” by adding falsifiable gates, repo layout, a test matrix, schema versioning, observability, and loop-safety bounds.[^1]

## Reflection

The strongest thing about this pass is that it correctly treats the agreement between Sonnet/Grok/GPT as signal, not decoration: all three converged on the same missing pillars — a concrete `ChatDriver`/`ProviderEntry` contract, explicit relay design, and a real multi-tab/session model — which makes the core direction unusually stable for this kind of browser-automation architecture. It also preserves the best idea from the earlier work: use chrome-agent for discovery and validation, but keep it out of the runtime hot path so comet-mcp remains the fast, high-level bridge rather than turning into a low-level browser robot loop.[^2][^3][^1]

## What improved

This version fixes most of what was previously underspecified. The addition of a repo tree, P0 concurrency spike, `schemaVersion`, `health-log.jsonl`, explicit `maxTurns`/`costGuard`, and a real test matrix turns vague “we should” language into something contributors can actually build and verify. The phase structure is also now disciplined: P1 proves the abstraction on Perplexity first, P2 validates discovery on Grok, P3 introduces concurrent tabs, and only then does P4 add relay/backbone semantics, which is the correct dependency order.[^1]

## Critique

The main weakness now is not architecture but product semantics: the doc is still much stronger on “how to drive tabs” than on “how to orchestrate a meaningful multi-agent conversation.” It defines `relay_message`, `broadcast`, `critique`, and `round_robin`, but it does not yet define conversation policies such as when Claude should summarize instead of relaying raw text, how to preserve attribution inside relayed markdown, or how to prevent conversational drift when five providers keep reinterpreting each other’s outputs.[^2][^1]

A second gap is that `ProviderEntry` remains mostly a hook-and-status schema, not yet a **behavioral capability** schema; for example, the document does not model whether a provider supports attachments, long-context pastes, deep-research mode, regeneration, edit-last-message, or model switching, even though these differences will affect orchestration quality as much as selector stability [^1]. A third gap is that the accepted-risk note on UI automation and possible provider terms conflicts is good, but still too passive; for an actual backbone, that should become a provider-level policy flag such as `automationRisk: low|medium|high` and `relayEnabled: boolean`, so orchestration logic can degrade gracefully rather than treating policy as just documentation [^1].

## Improvements to add

I would add four concrete extensions to the doc:

- **Capability layer**: extend `ProviderEntry` with fields like `supportsAttachments`, `supportsEditLastMessage`, `supportsRegenerate`, `supportsModes`, `supportsStreamingStop`, `maxRelayChars`, and `preferredRelayMode`, so the orchestrator can choose behavior per provider instead of assuming all tabs are equivalent.[^1]
- **Conversation policy layer**: define a `RelayPolicy` with rules like “relay raw only under X chars,” “wrap always when crossing providers,” “summarize before relay if markdown tables/code fences exceed threshold,” and “force attribution header on all cross-provider hops,” because classifier avoidance and context hygiene are as important as DOM control.[^2][^1]
- **Scheduler layer**: add a small server-side orchestrator primitive such as `run_plan(planId)` or `step_plan(planState)` so Claude is not forced to micromanage every tab event; this naturally complements `wait_any` and will reduce MCP round-trips and context churn during multi-provider conversations.[^3][^1]
- **State fidelity layer**: persist not only `session.json`, but also per-tab `lastKnownMessageId`, `lastExtractHash`, and `lastCompletedAt`, so after a restart the system can distinguish “new assistant output” from “old page content re-read after reconnect”.[^1]


## Synthesized outline

### 1. Backbone model

Refactor comet-mcp from a Perplexity-specific tool server into a provider-agnostic runtime with three layers: **driver layer** (DOM interaction), **session layer** (multi-tab CDP management), and **orchestration layer** (relay, critique, broadcast, bounded loops). Keep Comet as the shared Chromium host because comet-mcp’s high-level MCP pattern is still much faster and cleaner than chrome-agent for day-to-day prompt submission and polling, while chrome-agent remains the right offline discovery instrument.[^3][^2][^1]

### 2. Provider contract

Adopt the existing `ProviderEntry`/`ChatDriver` direction, but expand it into three groups: hooks, runtime status, and capabilities. The provider file should answer not only “where is the composer/send/stop/output DOM?” but also “what can this provider reliably do, how should relay be formatted for it, and what are its safety/risk defaults?”.[^1]

Suggested additions:

- `schemaVersion`
- `hooks`
- `typing`
- `statusSignals`
- `capabilities`
- `riskPolicy`
- `relayPolicy`
- `markdownStrategy`


### 3. Session fabric

Replace the current single active CDP session with a bounded session pool keyed by `tabId`, constrained by the empirical P0 concurrency ceiling rather than by assumption. Each `TabSession` should track provider, targetId, health state, login state, last extraction hash, last complete timestamp, and override source, with `provider_health` surfacing this state before failures become silent timeouts.[^3][^2][^1]

### 4. Discovery and resilience

Keep chrome-agent in the discovery lane: selector mining, idle→typing→streaming→done capture, PONG probe, and registry emission, then commit the resulting provider config into the runtime registry. At runtime, BrowserSmith’s lessons should stay load-bearing: known→heuristic→override resolution, stop-button as ground truth, hard reset scoped per tab, explicit degradation reports, and human override persistence to disk.[^2][^3][^1]

### 5. Orchestration layer

Make the backbone a first-class subsystem, not just a set of helper tools. Define:

- `relay_message`
- `broadcast`
- `critique`
- `round_robin`
- `wait_any`
- optional `run_plan` / `step_plan`

All of them should require bounded execution via `maxTurns`, `costGuard`, and provider-aware relay formatting, with wrapped relay as the default cross-provider mode to reduce classifier false positives and preserve provenance. The shared conversation log should be treated as the canonical truth of the multi-agent exchange, since no individual provider tab contains the whole conversation.[^2][^1]

## Creative extension

The most valuable creative addition would be to stop thinking of this only as “Claude talks to many tabs” and define it as a **conversation bus**. In that model, each provider tab is an endpoint with a driver, health state, and capability profile; Claude is the planner; and the backbone owns routing, provenance, retry policy, summarization, and loop bounds. That shift matters because it suggests new primitives beyond relay, such as:[^1]

- `fanout_and_rank(prompt, providers[])` — ask several providers the same question, then have Claude rank or merge outputs.
- `debate(providerA, providerB, judge=Claude, turns=3)` — bounded adversarial exchange with explicit judging.
- `specialist_route(task)` — choose provider by capability/risk/health profile instead of fixed provider name.
- `repair_provider(tabId)` — auto-attempt reset, override fallback, and revalidation probe when health degrades.

That is the real evolution from a single-provider MCP server into a backbone: not just more tabs, but a routing and coordination fabric over heterogeneous AI endpoints.[^1]

## Recommendation

I would treat the attached doc as the current best planning document, but upgrade it one more time before coding with three additions: a capability schema, a conversation-policy schema, and a planner/scheduler section. Once those are in, the document becomes not just a sharp task list, but a full systems spec for a multi-provider conversation bus built on Comet.[^1]

<div align="center">⁂</div>

[^1]: doc-07-27-26-comet-mcp-final-synthesis-and-task-list-Sonnet-5.md

[^2]: doc-07-27-26-comet-mcp-multi-agent-backbone-outline-Sonnet-5.md

[^3]: thread-07-27-26-Comet-mcp-Chrome-Agent-BrowserSmith-grok.txt

