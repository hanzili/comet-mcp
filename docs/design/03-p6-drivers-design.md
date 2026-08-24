# P6 — Gemini / ChatGPT / Claude.ai Driver Design

**Status:** reviewed by Grok 2026-08-08 — approved (D1 separate-file, D2, D3); review in `responses/grok-p6-design-review-2026-08-08.md`
**Base:** fork/main `ac653f2` (70/70 unit tests, clean tree)
**Sequence:** P6 bumped ahead of P4/P5 (452e4bd); no fabric dependency (adapter layer vs fabric layer).
**Sources:** [Turn-02 P6 section](02-turn-02-complete-synthesis-phases-and-task-list.md) (lines 328-351),
[Grok P6 consultation](../../responses/grok-p6-consultation-2026-08-07.md), `open-items.md` handoff,
session wrap 2026-08-07.

---

## 1. Scope

Ship ChatDriver implementations for **gemini**, **chatgpt**, **claude** so all five
providers are askable through the same adapter process. Per the re-scoped plan:

- **In scope:** driver implementation + per-provider typing/markdown quirks +
  login-expiry handling + structured health as a first-class deliverable + full
  state-machine exercise per driver (fixtures + live PONG under the 8s stability
  window).
- **Out of scope:** re-running the discovery workflow (all 5 entries HIGH), relay
  policy validation (deferred to post-P4), the typed-adapter *migration* of the
  existing Perplexity/Grok drivers (deferred — see D2).

## 2. Baseline facts (verified 2026-08-08)

| Item | Where | Note |
| --- | --- | --- |
| ChatDriver contract | `src/types/provider.ts` (`ChatDriver`, `PollResult`, `HealthReport`, `ProviderEntry`, `ProviderControl`) | Contract already names P6: "Gemini/ChatGPT/Claude.ai (P6)" |
| Reference drivers | `src/drivers/perplexity.ts` (370 ln), `src/drivers/grok.ts` (280 ln) | Near-copies: same `handleFor`/`evalValue`/`resolveControl`/`findComposer`/health loop |
| Shared ask machinery | `src/drivers/index.ts` (`dispatchAsk`, `advanceAsk`, `completionStability` 8s, `updateSessionAnchors`, `simpleHash`, poll backoff + circuit breaker) | Provider-neutral over the contract — **no changes needed for new drivers** |
| Registry | `src/core/registry.ts` + `src/providers/entries/*.json` | Entries are discovery-written data; `resolveWithConfidence` + ADR 0003 fingerprint rebind |
| Extraction | `src/providers/extraction.ts` (Perplexity + Grok paths) | Pure Node-side; per-provider functions already the pattern |
| Markdown | `src/providers/markdown.ts` (`htmlToMarkdown(provider, html)` + `preClean`) | Provider switch already the pattern; needs 3 new cases |
| MCP tools | registered in `src/index.ts`; ask/poll/stop/health dispatch via `getDriver(provider)` in `src/drivers/index.ts` | Registering 3 drivers in the `DRIVERS` map is the wiring hook |
| Fixtures | `test/fixtures/{gemini,chatgpt,claude}/{idle,typing,completed}.html` | **Missing: streaming/login/blocked** for all three (grok/perplexity have streaming) |
| Tests | `test/unit/*.test.ts` (node:test, imports from `dist/`) | No state-machine harness yet — only extraction/markdown integrity on fixtures |

## 3. Key design finding: the ProviderEntry schema gap

The current `ProviderEntry` carries DOM inventory (`controls`, `heuristics`,
`responseSelectors`). It does **not** carry driver behavior. The three entries
(e.g. `src/providers/entries/claude.json`) all repeat the same boilerplate
`heuristics.stateMachine` and `stopDetection: "varies by provider — see probe"`,
which is exactly the difference Grok's consultation says to push into the entry.

**Decision D1 (Grok-approved, separate-file variant): extend `ProviderEntry` with
an optional `driver` section** (typed in `src/types/provider.ts`, hand-authored +
validated, distinct from discovery's DOM inventory), stored as
`src/providers/entries/<provider>.driver.json` and **merged at load time in the
registry** — discovery owns `controls` and never touches the driver file (R1
closed by construction). Schema:

```ts
driver?: {
  typing: 'insertText' | 'value-input' | 'key-events';      // composer mechanism
  submit: {
    method: 'enter' | 'click' | 'click-after-type';          // claude: click-after-type (774e875)
    selector?: string;                                        // override of sendButton for submit
    verify: 'composer-emptied' | 'loading-indicator' | 'response-started';
    enterSends?: boolean;                                     // claude: false
  };
  signals: {
    working?: { kind: 'stop-control' | 'indicator' | 'growing-content'; selector?: string };
    completed?: { kind: 'stop-absent' | 'hash-stable' | 'response-present'; selector?: string };
    login?: string[];                                         // body-text / URL patterns
    blocked?: string[];                                       // CAPTCHA / rate-limit phrases
  };
  messageId?: { attr: string };                               // chatgpt: data-message-id
  markdown?: string;                                          // preClean variant name (maps to markdown.ts switch)
  freshChatByNavigation?: boolean;                            // claude: /recents has no composer → /new
  reset?: { method: 'url' | 'control' | 'navigate'; url?: string };  // Grok review: data-driven reset (claude → /new)
  extraction?: { preferLast?: boolean };                      // Grok review: LAST-container pattern
};
```

Grok-review additions folded in: `reset.method`, `extraction.preferLast`, and
`markdown` as a direct `preClean` switch name; `signals.completed` default path =
`stop-control` + `hash-stable`; `submit.verify` mandatory before returning `sent`;
`typing.key-events` documented as the execCommand-interception escape hatch.

Discovery keeps owning `controls`; `driver` is authored by the driver work and
must survive `discover` regeneration (see Risks R1).

## 4. Architecture: BaseChatDriver (composition, per Grok consultation)

New file `src/drivers/base.ts` — one implementation shared by the three new
drivers (and the future typed-adapter core), replacing the 
perplexity/grok copy-paste of `handleFor`/`evalValue`/`resolveControl`/health loop:

- **Entry-driven poll script generator**: parameterized POLL_SCRIPT that collects
  response-container texts + HTML (per `driver.signals`/entry `responseContainer`),
  stop/working indicator presence, login/blocked body-text flags, and the
  `messageId` attribute — one script shape, provider config decides what to probe.
- **Typing**: `typeInto(handle, composerSel, driver.typing, prompt)` — `insertText`
  (execCommand, contenteditable/ProseMirror/Quill) | `value-input` (textarea,
  ChatGPT) | `key-events` (reserved for providers that reject execCommand).
- **Submit ladder**: driven by `driver.submit` — `click` (gemini/chatgpt),
  `click-after-type` (claude — button `[aria-label="Send message"]` appears after
  typing; Enter alone does NOT submit), `enter` (fallback where `enterSends`).
  Shared verification step (`composer-emptied` etc.) before returning `sent`.
- **State determination**: shared `determineState(signals)` mapping probe results
  to `idle|typing|streaming|completed|login_required|degraded|blocked` per
  `driver.signals`; **completed requires a non-empty extraction** — otherwise
  degrade, never silent-empty (P6 gate).
- **Health**: shared loop over `entry.controls` (+ `signals.working`) emitting
  `hookResolution` with source; surface `foundVia`/`confidence`/`workingSignal`/
  `lastVerifiedAt` from entry + live probe (section 6).
- **Anchors**: `simpleHash`/`updateSessionAnchors` already live in
  `src/drivers/index.ts` — base driver just returns `contentHash` (+ `messageId`
  when the provider exposes one) and the shared machinery keeps reconnect-dedup
  intact. Latent risk flagged by both critiques: Gemini/ChatGPT/Claude may emit
  different native message IDs — `messageId` stays optional, `contentHash` is the
  durable anchor.
- **Override hooks**: narrow named methods (`onSubmit`, `onPoll`, `onReset`,
  `detectLogin`) — only where the entry cannot express the behavior, documented
  as the future schema-extension signal (Grok consultation §4).

**Decision D2 (recommended): do NOT migrate perplexity/grok onto BaseChatDriver
in P6.** They are live-validated and green; migrating widens the blast radius
(their POLL_SCRIPTs embed Perplexity/Grok-specific prose semantics). The three new
drivers become the reference implementations; migration folds into the
typed-adapter phase. (Alternative — full migration now — costs a larger diff and
re-validation of the two providers that already pass the live gates.)

## 5. Per-provider driver matrix

| | Gemini | ChatGPT | Claude.ai |
| --- | --- | --- | --- |
| URL | `gemini.google.com/app` | `chatgpt.com/` | `claude.ai/` (fresh chat: `/new` — `/recents` has no composer) |
| Composer | `[aria-label="Enter a prompt for Gemini"]` — Quill `div.ql-editor`, contenteditable | `[aria-label="Chat with ChatGPT"]` — `textarea[name=prompt-textarea]` | `[data-testid="chat-input"]` — TipTap/ProseMirror contenteditable |
| Typing | `insertText` | `value-input` (textarea) | `insertText` |
| Send | `[aria-label="Send message"]` click; Enter fallback verified (entry heuristics) | `#composer-submit-button[data-testid="send-button"]` click; Enter works | **click-after-type** — `button[aria-label="Send message"]` appears after typing; Enter alone does not submit (774e875) |
| Working signal | stop control visible during generation (consultation §5); key completion on stop absence + content-hash stability | stop button usually reliable while generating — **re-resolve every poll, never cache the node** | stop/cancel control presence + progressive content; same two-identical-polls + pre-send hash baseline as Grok |
| Response container | `model-response` custom element (LAST) | `[data-message-author-role="assistant"]` (LAST; `data-testid="conversation-turn"` alias) | `div.font-claude-response` — conditional: empty-state idle absence is NOT drift |
| MessageId anchor | none visible in fixture — verify against `gemini/completed.html` (15KB) | `data-message-id` (present in completed fixture) | none in fixture (86B READY) — contentHash-only |
| Login | Google-account heavy: redirects, account chooser, "Sign in" banners → `login_required` | aggressive CAPTCHA / rate-limit surface → `blocked`/`degraded`, never timeout-into-unknown | soft wall or full redirect → `login_required` |
| Markdown quirks | strip Gemini disclaimer ("Gemini can make mistakes…") + citation cards if present in fixture HTML | strip citation/source blocks, "Sources" UI residue | verify turndown doesn't latch on intermediate partial lists; strip copy/feedback UI inside `font-claude-response` |
| reset | entry controls / URL | entry controls / URL | `freshChatByNavigation: true` (override: navigate `/new`, wait for composer) |

All three: **never cache dynamic nodes, re-resolve working state every poll,
treat `login_required`/`degraded`/`blocked` as first-class, feed every successful
extraction into the durable cursor/content-hash machinery** (Grok consultation §5,
runtime rules).

## 6. Structured health (P6 gate)

`HealthReport` (`src/types/provider.ts`) gets the consultation's fields:

- `hookResolution[].source` already exists (`known-selector|heuristic|override|missing`) — extend the shared loop to also report per-control `foundVia` + `confidence` (from entry + rebind result) and a `workingSignal` probe result (live check of `driver.signals.working`).
- `loginRequired` becomes a live probe (body-text/URL patterns from `driver.signals.login`), not a hardcoded `false`.
- `lastVerifiedAt` from `ProviderControl.last_validated` / live check timestamp.
- **The gate rule:** a missing responseContainer selector at completed-detection
  must produce `state: 'degraded'` (or `blocked`), never `completed` with an
  empty `response`. Current Perplexity/Grok `poll()` can return `state:
  'completed'` with `response: ''` when extraction is null — the base driver's
  `determineState` enforces the fix for the new three.

`provider_health` (MCP, via `getDriver(provider).health(session)`) then surfaces
the same fields for all five drivers.

## 7. Extraction & markdown additions

- `src/providers/extraction.ts`: add `extractGeminiResponse`, `extractChatGPTResponse`,
  `extractClaudeResponse` (+ per-provider `determine*Status`) following the
  existing pure-function pattern; ChatGPT path reads LAST
  `[data-message-author-role="assistant"]` and can surface `data-message-id`.
  Reuse `filterProseTexts`/`dedupeByContainment`/`cleanResponse` where the DOM
  shape matches; keep provider-specific selectors/UI-phrases as parameters.
- `src/providers/markdown.ts`: add `preClean` cases `gemini`, `chatgpt`, `claude`
  (strip provider UI residue per matrix above) — verify against the completed
  fixture HTML during implementation.

## 8. Fixtures & state-machine harness

- **New fixtures** for each of gemini/chatgpt/claude:
  `streaming.html` (working indicator / stop control + growing content),
  `login.html` (sign-in wall / redirect banner), `blocked.html` (CAPTCHA /
  rate-limit surface), and for claude a `typing.html` variant that includes the
  conditional send button (its submit contract). Capture from real tabs on the
  dedicated test tab (user rule: never pollute real provider threads).
- **Harness (Decision D3, recommended): add `jsdom` as a devDependency** and build
  `test/unit/state-machine-harness.ts` — a `MockCDPHandle` that loads a fixture
  into jsdom and executes the driver's POLL_SCRIPT/typing/submit expressions
  against it. This exercises the real in-page scripts, not string-matched fakes.
  (Alternative: hand-rolled mini-DOM — rejected: POLL_SCRIPTs are browser JS and
  string-matching them would test the test, not the driver.)

## 9. Test plan

Unit (`test/unit/`, node:test, run via build → `dist/`):
1. State machine ×3 drivers × fixtures: idle → typing → streaming → completed
   (under 8s window semantics), login → `login_required`, blocked → `blocked`,
   missing response container at completion → `degraded` + empty response
   forbidden (P6 gate assertion).
2. Extraction ×3: response text, markdown (fixture-driven like
   `fixture-driven.test.ts`), `messageId` (chatgpt), UI-residue stripping.
3. Submit ladders: mock handle asserts method order — gemini/chatgpt click,
   claude click-after-type (button appears only after typing; Enter not pressed),
   verification failure → receipt `unknown`, never `sent`.
4. Health: per-control `source`/`confidence`, `workingSignal` state,
   `loginRequired` probe, missing selector → `healthy:false` + `degraded:true`.
5. **Explicit assertion that a completed poll with empty extraction is rejected by
   determineState** (Grok review addition — the gate test, not just the behavior).
6. **Concurrent isolation:** open/ask/poll two new providers side-by-side with one
   existing driver (perplexity or grok) — verifies registry + pool isolation
   still holds (Grok review addition).
7. **Forced missing-selector fixture** that must produce `degraded` + structured
   health naming the missing hook (Grok review addition).

Integration (opt-in, `test/integration/`):
5. `p6-live-gate.mjs` (pattern: `p3-live-gate.mjs`): per new provider — open
   dedicated test tab → ask PONG → poll under the 8s stability window → assert
   completed + non-empty response + markdown + anchors + structured health.
6. MCP-only smoke through pi (user rule: MCP-only testing found the
   stability-clock bug — keep it as the gate before declaring P6 done).

## 10. Task checklist (dependency order)

- [x] **T1** Extend `src/types/provider.ts`: `ProviderEntry.driver` + `HealthReport` fields (foundVia/confidence/workingSignal/lastVerifiedAt live semantics).
- [x] **T2** Author `src/providers/entries/{gemini,chatgpt,claude}.driver.json` per matrix §5 (separate-file — R1 closed by construction); wire registry merge-at-load; validate against fixtures.
- [x] **T3** `src/drivers/base.ts`: shared handleFor/evalValue/resolveControl, entry-driven POLL_SCRIPT generator, typeInto, submit ladder, determineState (never silent-empty), health loop, named override hooks.
- [x] **T4** Drivers `gemini.ts`, `chatgpt.ts`, `claude.ts` (thin subclasses + override hooks: claude freshChat via `/new`).
- [x] **T5** Register the three in `DRIVERS` (`src/drivers/index.ts`).
- [x] **T6** Extraction additions + markdown `preClean` cases (§7), fixture-verified.
- [x] **T7** Fixtures: streaming/login/blocked (+ claude typing-with-send-button); jsdom devDep + `state-machine-harness.ts` (`test/unit/p6-harness.ts`).
- [x] **T8** Unit tests (§9.1-4). Full suite green — **94/94** (24 new P6).
- [x] **T9** `p6-live-gate.mjs` + MCP-only smoke through pi (dedicated test tabs; PONG prompts only). Live-validated all three (PONG + markdown under the 8s window); gate is opportunistic — environment variance (tab churn, hydration, rate limits) on the shared browser, fixtures remain the deterministic gate.
- [ ] **T10** Docs: `docs/build-plan.md` P6 row, Turn-02 checkboxes, ADR 0006 (driver-contract in entries), `open-items.md`; update wiki/Vestige at pack. — in progress

## 11. Decisions for review

- **D1** Extend `ProviderEntry` with a `driver` section — **Grok-approved, separate-file variant** (`entries/<p>.driver.json`, merged at load; discovery never overwrites it).
- **D2** Do not migrate perplexity/grok onto the base in P6; new drivers are the
  reference implementations. — **Grok-approved**
- **D3** jsdom devDep for the state-machine harness. — **Grok-approved**
- **D4** Submit contract data-driven `{enter|click|click-after-type}` per entry
  (Grok consultation §4). — agreed in consultation
- **D5** `messageId` optional; contentHash remains the durable reconnect-dedup
  anchor for all new drivers.

## 12. Risks

- **R1 — entry regeneration drops `driver`:** **CLOSED by decision** — driver
  section lives in `entries/<p>.driver.json`, merged at load in the registry;
  discovery regenerates only `entries/<p>.json` and never touches the driver file.
- **R2 — ProseMirror/Quill typing quirks:** execCommand may be intercepted;
  reserve `key-events` typing mode + document any provider that needs it.
- **R3 — CAPTCHA/rate-limit walls (ChatGPT/Gemini):** must map to
  `blocked`/`degraded` with structured state, never silent empty or
  timeout-into-unknown.
- **R4 — gateway cap:** long responses go through the existing ID-based
  structured-result + `provider_response` chunked retrieval (790fd90) — no new
  transport work, but the pi smoke must use it.
- **R5 — vendor copy drift:** `My Drive\setup\pi-transplant\vendor\comet-mcp`
  syncs at pack time; P6 changes are dev-trunk only until then.
- **R6 — live-gate environment:** Grok was rate-limited 2026-08-07; Gemini/
  ChatGPT/Claude live validation depends on session availability — run gates
  opportunistically, fixture coverage is the deterministic gate.

## 13. Success gate (Turn-02, Grok tightening)

All five providers report structured health and degrade independently; a missing
selector never becomes a silent empty response; each new driver exercised the
full state machine via fixtures + at least one live validation under the 8s
stability window.
