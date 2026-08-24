# Debug Report — Perplexity ask stuck `WATCHING` forever despite a completed answer on screen

**Date:** 2026-08-10
**Repo:** MrJ55/comet-mcp fork, main
**Status:** OPEN (root cause narrowed but not conclusively fixed in the live bridge path)

## Symptom

A `provider_ask` (completionMarker) to Perplexity is accepted (`send.accepted`), the
model renders a full answer ending with the status line + sentinel
(e.g. `Turn 1, 08/10/26, 12:51 PM EDT, Perplexity, 8%, then the code vLAo2tnDHQ`),
but every `provider_poll` returns `WATCHING` indefinitely. The event log shows only
`envelope.created → send.queued → send.accepted → send.timed_out` (soft expiry) — no
`response.received`, no `reminder_sent`.

This recurred across multiple bridge restarts, rebuilds, and fixes. The model side is
correct — the answer (and its status line + sentinel) IS on the page.

## What was verified working in isolation (probe)

`test/integration/probe-perplexity-status.mjs` evaluates the **exact POLL_SCRIPT**
from `dist/drivers/perplexity.js` against a live Perplexity tab via a fresh CDP
session, then applies the driver's status-line detection + sentinel strip. It reports:

```
bodyText len: 19431 | prose: 95
statusLineMatch: "Turn 1, 08/10/26, 12:51 PM EDT, Perplexity, 8%, then the code vLAo2tnDHQ"
hasStatusLine => state would be: completed + authoritative
line tail: "...8%, then the code vLAo2tnDHQ"
stripSentinel found: true
```

So: the POLL_SCRIPT, the status-line regex, the append logic, and `stripSentinel`
all work when executed **directly against the live tab**. The gate math
(`completionStability`, window hold, fallback) was separately verified to complete on
poll 2. Each layer is correct in isolation.

## The difference between the probe and the driver

| | Probe (`probe-perplexity-status.mjs`) | Driver via bridge |
|---|---|---|
| CDP session | fresh `chrome-remote-interface` attach | pooled `TabCDPHandle.safeEvaluate` |
| Script evaluated | exact dist POLL_SCRIPT (3012 chars, CRLF) | **2945 chars, LF** — DIFFERENT string |
| Returned value | JSON string → parsed, `hasStatusLine: true` | `Runtime.evaluate` → `objectId`, **no value** |
| Driver result | — | `state: idle`, empty response |

The executed script (2945 chars) and the dist file on disk (3012 chars) are **not the
same string** (`same script: false`). The executed script has the current-turn scoping
and `JSON.stringify` return, but is 67 chars shorter and uses LF line endings, while
the file on disk is CRLF. A fresh `require()` of the dist file yields the 3012-char
version; the driver somehow executed the 2945-char version — i.e. the loaded module in
the bridge process does not match the file on disk.

## Root-cause hypothesis

The pi gateway's `comet-bridge` process (`node C:\Dev\comet-mcp\dist\index.js`,
mcp.json) is **serving a cached/stale module graph** across rebuilds. The gateway
reuses the spawned process (or a warm module cache) instead of reloading the rebuilt
`dist`. Evidence:

1. The bridge's driver executes a POLL_SCRIPT that differs from the current dist file
   (2945 vs 3012 chars), even though the process start time is AFTER the dist build.
2. `provider_list` after a restart showed **zero registered tabs** while the browser
   still had the orphaned tab from the prior bridge incarnation — the process was a
   fresh empty registry, but the ask/poll flow then targeted a tab the new process
   never registered, or the module state carried over inconsistently.
3. Direct CDP evaluation of the same script works; only the driver-in-bridge path
   returns `objectId` (no value) — consistent with a different (older) script being
   sent, whose object return trips CDP's `returnByValue` serialization
   (U+2028/U+2029 inside large `innerHTML` strings is the known failure mode).

A secondary contributing bug WAS found and fixed: the POLL_SCRIPT returned a raw
object, and large `innerHTML` strings can break CDP `returnByValue` object
serialization (returns `objectId`, no `value`). The driver now returns
`JSON.stringify({...})` and parses it (`43b13b6`) — immune to that failure mode. This
fix is correct regardless of the cache issue.

## Fixes landed this session (all committed + pushed)

| Commit | Fix |
|---|---|
| `852f96e` | native-marker authoritative requires prior poll (grok cold-start) |
| `2bebeea` | regression test for the above |
| `108b405` | tab reset clears session sentinel |
| `9033c5a` | status-line shape w/o token is compliant; `promptLandedIn` guard |
| `4c46698` | completionMarker: the CODE is the completion contract |
| `a39153b` | dispatch timestamp in every prompt + `sentAt` on outcome |
| `f55053f` | code-primary status detection in bodyText (determineStatus = fallback) |
| `d54cf7c` | status-line detection in BODY TEXT (renders outside `[class*=prose]`) |
| `895f07d` | status-line regex captures the whole line incl. sentinel |
| `5db40d4` | removed harmful deliveredHash guard (caused poll-2 sawNewResponse=false) |
| `43b13b6` | POLL_SCRIPT returns JSON.stringify (CDP object serialization fix) |

238/238 unit tests pass throughout.

## Open question / next step

Whether `43b13b6` fully resolves the live path depends on the gateway actually loading
the rebuilt dist. If the WATCHING bug still reproduces after a clean bridge restart,
the fix belongs in the **pi gateway's process management** (force a fresh spawn / clear
the comet-bridge process cache after rebuild), not in the driver.

## Amendment — the fallback-gate bug (user report, same session)

A SECOND, deeper bug was identified: even when the sentinel/state detection fails,
the **fallbacks never ran** because the entire completion gate (stability window,
hash-confirm, bounded reminder) was nested inside `if (poll.state === 'completed')`.
A state-detection failure (driver returns `idle` while the answer is rendered) made
ALL fallbacks unreachable → the ask hung forever regardless of content.

Fixed in `a770119`: the gate is now content-driven — `if (p.sawNewResponse)` only.
Completion is decided by CONTENT: status-line shape / sentinel present ⇒ complete
immediately (the status line IS the contract); otherwise the stability window and
bounded reminder still fire. The `poll.state` label no longer gates anything.

**DEBUG SWITCH:** `COMET_STRICT_COMPLETION_GATE=1` restores the original strict
`poll.state === 'completed'` gate so the underlying state-detection bug can be
reproduced in isolation (the fallback would otherwise mask it). Read once at module
load; the test spawns a child process with the env set to verify.

## Amendment 2 — the submission bug + phantom-module fix (live-verified through the real bridge)

A third bug, user-reported during the gate tests: **prompts weren't being submitted** —
`execCommand('insertText')` set the DOM but did NOT fire React's onChange, so Perplexity
never enabled the Submit button / registered the text; Enter no-op'd; and the submit
fallthrough returned `true` unconditionally → `send.accepted` recorded while nothing
was submitted (no response, prompt stuck in the composer). Fixed in `0cc93db`:

1. **InputEvent dispatch** after typing (`editable.dispatchEvent(new InputEvent('input',
   { inputType: 'insertText', data }))`) so React registers the value and enables Submit.
2. **Submit verification** — the click/Enter paths now verify the composer actually
   emptied before returning `true` (no blind success).
3. **currentPollScript()** — reads the POLL_SCRIPT from dist on disk at runtime instead
   of the module constant, eliminating the phantom-module staleness that made the
   driver evaluate an old script (2945 chars / object return) even in fresh processes.

**Live-verified through the REAL MCP bridge** (no gateway bypass): a CONFIRMED ask
completed in **4 seconds** (`send.accepted 19:28:09 → response.received 19:28:13`),
response `CONFIRMED` + `Turn 1, ... 1%, then the code` (sentinel stripped, line
preserved), no WATCHING / no phantom / no reminder. Both gate modes verified at the
driver level: `COMET_STRICT_COMPLETION_GATE=0` (default, content-driven) completes
immediately; `=1` (strict, old behavior) stays stuck — the switch reproduces the
original bug for diagnosis.

## Reproduction

```bash
npm run build
node --test test/unit/*.test.ts              # 240/240
node test/integration/probe-perplexity-status.mjs   # probes the live tab directly
# standalone driver-level gate test (fresh perplexity thread per run):
COMET_STRICT_COMPLETION_GATE=0 node test/integration/standalone-perplexity-test.mjs
COMET_STRICT_COMPLETION_GATE=1 node test/integration/standalone-perplexity-test.mjs
# to reproduce the ORIGINAL state-detection hang in isolation:
COMET_STRICT_COMPLETION_GATE=1 node dist/index.js
```
