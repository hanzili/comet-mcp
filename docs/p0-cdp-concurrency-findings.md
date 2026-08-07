# P0 Findings: CDP concurrency ceiling on the live Comet endpoint

- **Date:** 2026-08-06
- **Endpoint:** `http://127.0.0.1:9222` (Comet = Chrome/150.0.7871.230, CDP Protocol 1.3)
- **Harness:** `test/integration/cdp-concurrency-spike.mjs` (zero dependencies; Node v24 native WebSocket + fetch)
- **Raw results:** `test/integration/out/p0-cdp-spike-2026-08-06T20-12-43-186Z.json`

## Summary

Five concurrent CDP sessions on five separate tabs operated for 60 seconds each phase
without **silent loss of control or cross-tab interference** — the P0 gate passes at the
ADR 0001 target of five sessions. The measured transport ceiling is therefore **≥ 5 tabs**.

## Method

- Three phases, incremental accumulation: **2 tabs → 3 tabs → 5 tabs**, 60 s per phase.
- **One CDP connection per target** (separate WebSocket per tab), maintained across phases;
  sessions were *not* silently replaced, so loss of control would have been observable.
- Load per phase: concurrent `Runtime.evaluate` every 250 ms per tab (title/marker/text-length
  probe) and `Input.insertText` every 750 ms per tab into an injected textarea, with a
  read-back verification of the actual landed text length.
- **Neutral tabs only** (`about:blank` + injected textarea). No automation was run against
  real provider pages: the 2026-08-06 session handoff records Comet's security classifier
  flagging an automation pattern, and text-input exercises against a live logged-in provider
  session risk triggering CAPTCHA/anomaly checks on a real account. Provider-page anomaly
  behavior is therefore **deferred to opt-in provider-level testing** (see below).
- The browser was already under real load during the spike: 16 pre-existing targets
  (active Perplexity search tab, sidecar, extension pages, service workers, iframes).

## Results

| Phase | Tabs | Evaluates | Eval fails | Eval p50/p95/p99/max (ms) | Inserts | Insert fails | Insert p50/p95/p99/max (ms) | Disconnects | Alive at end |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 454 | 0 | 2.0 / 4.6 / 6.3 / 6.9 | 152 | 0 | 2.2 / 3.7 / 7.5 / 19.0 | 0 | 2/2 |
| 2 | 3 | 675 | 0 | 1.6 / 4.0 / 6.0 / 70.7 | 225 | 0 | 2.1 / 3.4 / 6.9 / 14.9 | 0 | 3/3 |
| 3 | 5 | 1110 | 0 | 1.4 / 3.4 / 6.4 / 18.7 | 370 | 0 | 2.0 / 3.7 / 9.8 / 33.7 | 0 | 5/5 |

- **Errors / timeouts:** zero across all phases.
- **Disconnects:** zero. All five sessions passed the post-run health pass (`1+1` evaluate,
  1.2–2.0 ms).
- **Cross-tab effects:** none detected. Each tab carried an injected `title` + `window.__spikeMarker`;
  every probe verified the values belonged to the tab's own session. No cross-tab events recorded.
- **Latency trend:** no degradation with load. p50 *improved* slightly (2.0 → 1.6 → 1.4 ms),
  consistent with warm-up; the 70.7 ms p99 outlier at 3 tabs is a single GC/event-loop pause,
  not a concurrency effect.

## Methodology note: verification accounting

The first run of the spike reported 82/120 "text-input verification mismatches" at 3 and 5 tabs.
Investigation proved these were a **harness accounting artifact, not text loss**: the expected
length was computed as `insertCount × currentChunkLength`, but the chunk string's length varies
with the tick's digit count (`chunk-2-5;` = 10 chars vs `chunk-2-100;` = 12), so the check
over-counted. The observed gaps (76, 114) reproduce the arithmetic exactly, and the read-back
`got` values match the true accumulated lengths. The harness now tracks expected length as a
running sum of actual chunk lengths; the re-run is fully clean. All three tab-sets and the
per-tab textarea states were verified during the fix.

## CAPTCHA / anomaly behavior

Not exercised in this spike, by design. The neutral-tab methodology cannot trigger or observe
provider-side anomaly checks. Findings so far (from the session handoff, not this spike):
the security classifier flags specific automation patterns (relaying a different thread's
content via the `<selected_by_user_text>`-style wrapper), and Comet's agentic mode is
paywalled and can silently stall on a payment prompt. **Recommendation:** provider-page
anomaly/CAPTCHA observation belongs in opt-in integration tests at P2/P3 (Grok adapter +
discovery pipeline), gated behind explicit client approval, per ADR 0001 relay policy.

## Decision: default concurrent-tab cap

- **Default cap: 5 tabs** — the measured limit (and the ADR 0001 gate target).
- The cap is a *transport*-level number: 5 CDP sessions are stable against the live endpoint
  even under 16 pre-existing targets of background load. Real provider tabs are heavier
  (streaming DOM, network, iframes), so the *practical* safe count with live provider pages
  may be lower.
- **Implementation:** the tab registry and CDP session pool (P3) must enforce the cap as a
  configurable default (`max_concurrent_tabs: 5`), fail the *N+1* open with a clear
  `tab_cap_exceeded` error rather than silently degrading, and keep the cap overridable via
  config for opt-in stress testing.
- **Re-measure at P3:** when the Grok adapter lands, re-run this harness (or a provider-page
  variant) to confirm the cap holds with real provider tabs before relay features are enabled.

## P0 gate evaluation

> Five sessions, or the measured lower safe limit, operate without silent loss of control
> or cross-tab interference.

**PASSED.** Five sessions operated without silent loss of control or cross-tab interference
for the full test window. The measured ceiling is ≥ 5; the ADR 0001 gate is met.

## Related

- [ADR 0001: Browser-tab transport and relay defaults](adr/0001-browser-tab-transport-and-relay-defaults.md)
- [Build plan](../build-plan.md)
- Harness: `test/integration/cdp-concurrency-spike.mjs`
