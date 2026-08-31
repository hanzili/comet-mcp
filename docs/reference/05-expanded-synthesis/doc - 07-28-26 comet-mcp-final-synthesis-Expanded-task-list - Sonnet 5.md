# comet-mcp Multi-Agent Backbone — Turn-3 Synthesis
**Chain:** Sonnet outline → Grok 4.5 + GPT-5.6 critiques → Sonnet final synthesis (test matrix, repo layout, loop-safety) → Council-Pro critique (capability/policy/scheduler layers, "conversation bus" reframe) → **this pass**.

---

## 1. What Council-Pro got right

The critique correctly separates two things the earlier passes conflated: **driving tabs** (solved — registry, driver contract, resilience rules, test matrix) and **orchestrating a conversation** (still thin — `relay_message`/`broadcast`/`critique`/`round_robin` were mechanisms without policy). Its four additions are real gaps, not decoration:

- **Capability schema** — `ProviderEntry` described *where* things are in the DOM but never *what the provider can do* (attachments, regenerate, edit-last, modes, relay char limits). Orchestration quality depends on this as much as selector stability.
- **Relay policy** — "wrapped mode exists" isn't the same as "here's the rule for when to summarize vs. relay raw vs. force-wrap." This was genuinely missing.
- **Planner/scheduler** (`run_plan`/`step_plan`) — without this, Claude has to micromanage every `provider_ask`/`provider_poll` pair across N tabs, which is exactly the context-churn problem `wait_any` only partly addresses.
- **State fidelity** (`lastKnownMessageId`, `lastExtractHash`, `lastCompletedAt`) — closes a real bug class: after a reconnect, how do you know a re-read of the page is *new* content vs. the same old answer re-extracted?

## 2. Where Council-Pro's own pass is still thin

Naming four new layers plus four new "conversation bus" primitives (`fanout_and_rank`, `debate`, `specialist_route`, `repair_provider`) without specifying any of them just moves the underspecification up a level. Specifically:

1. **No schema for `RelayPolicy`** — only prose rules ("wrap always," "summarize if over threshold"). Needs actual fields.
2. **`debate(judge=Claude)`** doesn't say *how* the judge sees both sides — full conversation log? A constructed prompt? Without this it's not implementable.
3. **`fanout_and_rank`**'s ranking step is unspecified — ranked by what criteria, and who/what does the ranking (Claude inline, or a fourth provider as judge)?
4. **No phase placement** — these primitives aren't slotted into the P0–P6 build order or gated by new tests. A feature with no phase and no test is a wish, not a plan.
5. **Capability/risk fields aren't wired into discovery** — §4 of the prior synthesis (chrome-agent pipeline) still only emits hooks + a PONG probe; it needs to also probe for attachments/regenerate/edit-last support during discovery, or these fields become hand-authored guesses that drift from reality.
6. **Scope creep risk** — the original outline explicitly set a **non-goal boundary** for v1 (no multi-process Comet, no full picker UI, etc.). `debate`/`fanout_and_rank`/`specialist_route` are legitimate but are *scope expansions*; they need to be clearly marked additive/optional (a new phase, not folded into P4) so the core backbone doesn't get gated on features not required to satisfy the original ask.

This pass closes those six gaps: concrete schemas below, explicit phase placement (a new **P7: Conversation Bus Extensions**, kept separate from the core P0–P6 backbone), and matching test-matrix entries.

---

## 3. Concrete schema additions

### 3.1 `ProviderEntry` — capability + policy fields

```typescript
interface ProviderCapabilities {
  supportsAttachments: boolean;
  supportsEditLastMessage: boolean;
  supportsRegenerate: boolean;
  supportsModes: string[];        // e.g. ["fast", "deep-research", "reasoning"]
  supportsStreamingStop: boolean;
  maxRelayChars: number;          // provider-observed practical input ceiling
}

interface RiskPolicy {
  automationRisk: "low" | "medium" | "high";  // ToS/anomaly-detection posture, set per provider
  relayEnabled: boolean;                       // hard off-switch if a provider's classifier is known-hostile to relay
}

interface RelayPolicy {
  defaultMode: "verbatim" | "wrapped" | "summarize";
  rawRelayMaxChars: number;        // above this, force summarize regardless of requested mode
  wrapThresholdChars: number;      // below this, verbatim is acceptable even cross-provider
  forceAttributionHeader: boolean; // always prepend "[Relayed from X]" on cross-provider hops
  summarizeOnStructureOverflow: {  // if content has more than N tables/code fences, summarize first
    maxTables: number;
    maxCodeFences: number;
  };
}

interface ProviderEntry {
  key: string;
  name: string;
  home: string;
  freshChatByNavigation: boolean;
  authCookieNames: string[];
  schemaVersion: number;
  hooks: { /* unchanged from prior synthesis */ };
  status: { /* unchanged */ };
  typing: "execCommand" | "dispatchKeyEvent";
  markdownStrategy: "innerText" | "turndown";
  capabilities: ProviderCapabilities;
  riskPolicy: RiskPolicy;
  relayPolicy: RelayPolicy;
}
```

### 3.2 `TabSession` — state fidelity fields

```typescript
interface TabSession {
  tabId: string;
  targetId: string;
  providerKey: string;
  cdpSession: CDP.Client;
  state: "idle" | "working" | "completed" | "login_required" | "degraded";
  lastKnownMessageId?: string;   // provider-native id if extractable, else derived
  lastExtractHash: string;       // hash of last extracted response text
  lastCompletedAt?: string;      // ISO timestamp of last confirmed new content
}
```
Rule: a poll only reports a "new" response if `hash(extractedText) !== lastExtractHash`. This closes the reconnect-reread ambiguity directly.

### 3.3 Scheduler primitives

```typescript
interface PlanStep {
  action: "ask" | "relay" | "broadcast" | "critique" | "wait_any";
  args: Record<string, unknown>;
}

interface Plan {
  planId: string;
  steps: PlanStep[];
  maxTurns: number;
  costGuard?: { maxTokensEstimate?: number; maxWallClockMs?: number };
  currentStep: number;
  state: "pending" | "running" | "halted" | "completed";
}

// run_plan(steps, maxTurns, costGuard?) -> planId   — registers and begins executing
// step_plan(planId) -> { step, result, planState }  — advances one step, returns for Claude to inspect
```
`step_plan` (not full auto-run) is the default — Claude still approves progression, but each call advances a whole pre-defined step instead of Claude re-deriving what to do next from raw tab state every round-trip. This is the concrete fix for the context-churn problem Council-Pro flagged.

### 3.4 Conversation-bus primitives (P7, additive/optional)

```typescript
// fanout_and_rank(prompt, providerKeys[], rankBy: "claude" | providerKey) -> { responses[], ranked[] }
//   ranking is always performed by an explicit party: either the orchestrator (Claude, inline)
//   or a named provider acting as judge — never implicit.

// debate(providerA, providerB, judge: "claude" | providerKey, turns: number, maxTurns: number) -> ConversationEntry[]
//   judge sees the full exchange via the shared conversation log (not a hand-built prompt) —
//   judge is invoked once at the end (or after each round, if turns > 1) with the log slice for that debate only.

// specialist_route(task: { description, requiredCapabilities: Partial<ProviderCapabilities> }) -> providerKey
//   selects a provider by matching requiredCapabilities + riskPolicy against the registry;
//   falls back to null (unrouted) if no provider matches — never silently guesses.

// repair_provider(tabId) -> HealthReport
//   attempts: re-resolve hooks -> hard reset (fresh chat, same tab) -> re-run PONG-style revalidation probe.
//   Returns updated HealthReport; does not retry indefinitely (single attempt per call, caller decides to retry).
```

---

## 4. Expanded phase table (P0–P7)

| Phase | Deliverable | Done when |
|-------|-------------|-----------|
| **P0** | CDP concurrency spike | 5 simultaneous sessions stable ≥60s (unchanged) |
| **P1** | Perplexity → `ChatDriver`, `schemaVersion`, base `ProviderEntry` (hooks/status/typing/markdownStrategy only — capabilities/policy fields default to conservative placeholders) | T2/T3 pass |
| **P2** | Grok via discovery pipeline; discovery **extended** to probe capabilities (attachment button present? regenerate control present? mode switcher present?) and populate `ProviderCapabilities` from observed DOM, not guesswork | T4 passes; `capabilities` fields non-placeholder for Grok |
| **P3** | Tab registry, N CDP sessions, `provider_*` tools, **state-fidelity fields** (`lastExtractHash` etc.) wired into poll logic | T5 passes; reconnect-reread ambiguity test (new, see §5) passes |
| **P4** | `relay_message` + log + **`RelayPolicy` schema enforced** (not just wrapped-mode-exists) + `run_plan`/`step_plan` scheduler | T6/T7 pass; new policy-enforcement test (§5) passes |
| **P5** | Gemini, ChatGPT, Claude.ai via same pipeline, each with capability probing from P2 baked in | T8 passes for all three |
| **P6** | `wait_any`, `session.json` + state-fidelity persistence, override persistence | T9/T10 pass |
| **P7 (new, additive)** | `fanout_and_rank`, `debate`, `specialist_route`, `repair_provider` | New tests (§5); explicitly optional — core backbone (P0–P6) is feature-complete for the original ask without P7 |

P7 is deliberately separated from P0–P6: it is a genuine capability upgrade (conversation bus) but not required to satisfy "orchestrate + relay across providers in tabs," and keeping it a distinct, later phase preserves the non-goals boundary set at the start of this design chain.

---

## 5. Test matrix additions

| # | Test | Phase gate | Pass criteria |
|---|------|-----------|----------------|
| T12 | Reconnect mid-session, re-poll a tab with unchanged on-page content | P3 | `lastExtractHash` match suppresses false "new response"; no duplicate log entry |
| T13 | `RelayPolicy` enforcement: content over `rawRelayMaxChars` requested as verbatim | P4 | System forces `summarize` regardless of requested mode; log entry reflects override with reason |
| T14 | `run_plan`/`step_plan` on a 3-step plan with a `costGuard.maxWallClockMs` set low enough to trigger | P4 | Plan halts at the guard, `state: "halted"`, resumable steps left intact |
| T15 | `specialist_route` given `requiredCapabilities: { supportsModes: ["deep-research"] }` when only one provider qualifies | P7 | Returns that provider; returns `null` when none qualify (not a wrong guess) |
| T16 | `debate` with `judge: "claude"`, 2 providers, `turns: 2`, forced `maxTurns: 2` | P7 | Halts exactly at bound; judge invocation receives only that debate's log slice, not the full cross-session log |
| T17 | `repair_provider` on a tab with one deliberately broken hook (known selector removed from fixture DOM) | P7 | Falls back to heuristic; `HealthReport` reflects `foundVia: "heuristic"`; single attempt, no infinite retry |

---

## 6. Full task list — additions/changes to prior phases + new P7

### P1 (amend)
- [ ] Add `capabilities`, `riskPolicy`, `relayPolicy` fields to `ProviderEntry` type with conservative defaults (`automationRisk: "medium"`, `relayEnabled: true`, `defaultMode: "wrapped"`) so P1 compiles against the fuller schema even though Perplexity's real values aren't probed until discovery matures.

### P2 (amend)
- [ ] Extend chrome-agent discovery script to check for attachment upload control, regenerate button, edit-last-message affordance, and any visible mode/model switcher; populate `ProviderCapabilities` from what's actually observed.
- [ ] Set `maxRelayChars` empirically (paste increasingly long test content until truncation/rejection observed, or use documented provider limits if visible in UI).
- [ ] Set `riskPolicy.automationRisk` and `relayPolicy` defaults per provider based on P0/T6-style probing results as they become available (may start conservative and tighten later).

### P3 (amend)
- [ ] Add `lastKnownMessageId`, `lastExtractHash`, `lastCompletedAt` to `TabSession`; compute hash on every `extractResponse` call.
- [ ] Update poll logic: only surface a response as "new" if hash changed since last poll for that tab.
- [ ] Run T12.

### P4 (amend)
- [ ] Implement `RelayPolicy` enforcement in `relay_message`: check `rawRelayMaxChars`, `wrapThresholdChars`, and structure-overflow thresholds before honoring a requested mode; downgrade mode automatically when policy requires, and log the override with a reason string.
- [ ] Implement `run_plan(steps, maxTurns, costGuard?)` and `step_plan(planId)`; wire `PlanStep` actions to existing tools (`ask` → `provider_ask`, `relay` → `relay_message`, etc.).
- [ ] Run T13, T14.

### P5 (amend)
- [ ] Apply the same capability-probing discovery extension from P2 to Gemini, ChatGPT, and Claude.ai.
- [ ] Confirm `relayPolicy` defaults are set (not left as P1 placeholders) for all providers before P7 work begins, since debate/fanout depend on real policy data.

### P7 (new)
- [ ] Implement `fanout_and_rank(prompt, providerKeys[], rankBy)`; support both `rankBy: "claude"` (orchestrator ranks inline, no extra tool call) and `rankBy: providerKey` (a named provider tab is asked to rank, via a constructed prompt referencing the collected responses).
- [ ] Implement `debate(providerA, providerB, judge, turns, maxTurns)`; wire judge invocation to pull only the relevant conversation-log slice (filter by a `debateId` tag on log entries).
- [ ] Implement `specialist_route(task)`; match `requiredCapabilities`/risk constraints against the registry; return `null` on no match rather than a nearest-guess.
- [ ] Implement `repair_provider(tabId)`: single-attempt hook re-resolution → scoped hard reset → revalidation probe (reuse the PONG-style probe from P2's discovery pipeline as the revalidation check).
- [ ] Run T15, T16, T17.
- [ ] Document P7 explicitly as optional/additive in `docs/accepted-risks.md`: the core backbone (P0–P6) is a complete answer to the original ask without it.

---

## 7. Net effect of this pass

The backbone (P0–P6) is unchanged in shape — this pass doesn't reopen settled architecture. What it adds is exactly the three things Council-Pro correctly flagged as missing (capability schema, relay policy, scheduler), specified concretely enough to build and test, plus the state-fidelity fix, and a firm boundary (P7) around the more ambitious "conversation bus" primitives so they extend the plan without becoming a precondition for shipping it.
