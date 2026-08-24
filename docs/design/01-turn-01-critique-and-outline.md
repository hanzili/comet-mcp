# Turn-01 Critique and Initial Outline

## Initial conclusion

The earlier synthesis documents were strong on implementation mechanics: CDP concurrency testing, provider discovery, selector health, capability probing, relay policy, state-fidelity fields, and bounded plans. The critical improvement was to prevent browser-UI mechanics from becoming the architecture itself.

## Strengths retained

- Empirical P0 concurrency test before committing to multi-session design.
- A `ProviderEntry`/`ChatDriver` contract and a tab registry.
- Provider health states: idle, working, completed, login-required, and degraded.
- Persistent selector overrides and fixture-driven extraction tests.
- `wait_any`, bounded plans, relay policies, and explicit P7 separation for advanced conversation patterns.
- Markdown fidelity and idempotent response detection as implementation gates.

## Corrections adopted

1. A response hash alone is not reliable recovery state; use message identity, extraction version/cursor, content hash, timestamps, and delivery correlation.
2. Boolean capabilities are too weak; record evidence, confidence, discovery method, and verification time for each provider operation.
3. Do not probe practical input limits by repeatedly testing live provider UIs; use conservative configuration and local chunking.
4. A wrapping prefix provides provenance but does not make relayed text safe. Treat provider output as untrusted and require policy/approval.
5. Do not make the MCP server depend on Claude for ranking or summarization. Return bundles to the client or invoke an explicitly selected evaluator.
6. Repair restores adapter health only. It never resends user or relay content automatically.

## Recommended project shape

```text
src/core/       conversation fabric, delivery manager, tab registry, CDP pool, relay policy, scheduler
src/providers/  provider registry entries and narrow adapter overrides
src/tools/      MCP tools
src/types/      driver and conversation contracts
test/           fixtures, unit tests, integration tests
docs/design/    current architecture
docs/reference/ source synthesis documents
docs/adr/       accepted architecture decisions
docs/runbooks/  discovery, repair, and release procedures
```

This initial critique is superseded in detail by `00-multi-provider-backbone-executive-synthesis.md` and `../build-plan.md`, but is preserved as the rationale behind their core decisions.

