# Reference material

Copy the source synthesis documents here according to `docs/build-plan.md`. Preserve original filenames so provenance remains clear.

The documents are background material, not implementation specifications. When they conflict, the current architecture decision records and build plan take precedence.

## Index (2026-08-07)

- `01-sonnet/` — original Sonnet outline (2026-07-27)
- `02-gpt-5p6/` — GPT-5.6 outline (2026-07-27)
- `04-sonnet-synthesis/` — Sonnet final synthesis + task list (2026-07-28)
- `05-expanded-synthesis/` — Sonnet expanded task list (2026-07-28)
- `06-provider-critiques/` — Perplexity + Grok critiques of the plan (2026-08-07); their sequencing/type-contract recommendations drove the executed order (event store → P3, P5 split, P6 rescope)
- `07-diagnosis-review/` — Perplexity + Grok reviews of the truncation fix (2026-08-07)
- `08-p3-dispatcher-tab-audit.md` — first-party audit of the P2 dispatcher's tab-addressing singleton (mandated by the Perplexity critique); confirmed one-global-CDP-connection, drove `src/cdp-pool.ts` + `src/tab-registry.ts`
