# Perplexity diagnosis review — FULL (2026-08-07)

Diagnosis

The diagnosis is strongly supported, but not fully characterized. The key evidence is that the server returned complete content directly, while the same result was truncated only after passing through pi; both text and markdown stopped at approximately the same small byte boundary. The 5 KB hypothesis was correctly rejected after a larger response passed through the gateway intact.

However, the experiments do not yet distinguish among:

a total serialized-result cap;

a cap on the MCP content[] item;

a UTF-8 byte cap rather than a JavaScript-character cap;

a token-budget cap;

special handling of text content versus other MCP content types.

I would add a probe matrix with ASCII, multibyte Unicode, multiple content[] items, and equivalent payloads split across items. That would identify whether the limit is per item or total and whether the boundary is bytes, characters, or tokens. The stale bridge process is also an important confounder; process identity/build SHA should be emitted in every diagnostic response.

File-backed fix

As an immediate operational workaround, commit 4b5dd56 is sensible: persistResponse() writes the full response and compactResult()/compactAskResult() return only a bounded preview and location. It directly avoids dependence on the gateway’s unknown result limit.
02-turn-02-complete-synthesis-phases-and-task-list.md

It is not a complete protocol fix, though. The returned Windows path is coupled to the server’s filesystem and may be unusable by a remote MCP client, sandboxed pi process, another machine, or a future multi-client deployment. It also exposes local path information and potentially sensitive response material. writeFileSync() is blocking, writes are not atomic, filenames are timestamp-only, and renderPoll() can create a new artifact every time a completed response is polled.
02-turn-02-complete-synthesis-phases-and-task-list.md

I would retain file persistence as a backend, but expose a server-owned opaque responseId, byte count, content hash, media formats, and expiration time. Add a provider_response(responseId, offset, limit, format) tool with bounded chunk retrieval. The path should be diagnostic-only, or returned only when explicitly requested. Use exclusive/atomic creation, restrictive permissions, collision-resistant IDs, and a retention job.

Completion fix

The pre-send snapshot is correct and fixes the important follow-up-turn bug: checking merely for “any response text” incorrectly treats the previous answer as the new answer. Comparing the pre-send hash and length is a reasonable baseline.
02-turn-02-complete-synthesis-phases-and-task-list.md

The two-identical-hash rule is useful but not sufficient. A provider can pause while streaming and produce the same hash twice, then append more content later. Conversely, a legitimate short response may be unchanged immediately, and hash-only comparison can miss metadata/state changes. The code also accepts completion only when the current state is completed, which is good, but should require a provider-specific completed signal plus a quiet-period or monotonic completion observation.

I would track (contentHash, responseLength, state, completionSignal) and require two consecutive completed observations separated by the normal polling interval, while allowing a configurable settling window. Add tests for paused streams, late appends after a false completed state, unchanged prior-turn content, empty answers, and timeout during stabilization.

Preview and regression coverage

A 200-character plain-text preview is reasonable for fitting a constrained gateway, but the result should be structured rather than a human-formatted string: status, responseId, preview, previewChars, fullChars, markdownChars, contentHash, and expiresAt. Include a short markdown preview only if it adds information; otherwise clients should retrieve the full representation by ID.

The highest-value regression tests are an end-to-end gateway-cap test, artifact round-trip/chunk retrieval, repeated-poll idempotence, concurrent asks, Unicode byte accounting, cleanup/expiry, and stale-process/build identification. The current commit proves the workaround for the observed case, but not yet a durable multi-client response-delivery contract.
02-turn-02-complete-synthesis-phases-and-task-list.md

a total serialized-result cap;

a cap on the MCP content[] item;

a UTF-8 byte cap rather than a JavaScript-character cap;

a token-budget cap;

special handling of text content versus other MCP content types.
