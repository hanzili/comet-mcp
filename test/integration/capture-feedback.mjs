// Capture full responses from live tabs via the drivers (bypasses MCP gateway truncation/timeouts).
// 1. Grok: the critique is already rendered — just poll and capture.
// 2. Perplexity: send the prompt directly (the MCP ask timed out before delivery), poll to completion.
// Run: node test/integration/capture-feedback.mjs
import { writeFileSync } from 'node:fs';
import { grokDriver } from '../../dist/drivers/grok.js';
import { perplexityDriver } from '../../dist/drivers/perplexity.js';
import { normalizePrompt } from '../../dist/drivers/index.js';

const PROMPT = `You have an uploaded document: 02-turn-02-complete-synthesis-phases-and-task-list.md (the comet-mcp multi-provider backbone plan, P0-P8 phases). Critique it against the CURRENT implementation state below, then give best next steps.

CURRENT STATE (what is actually built, as of 2026-08-07):
- P0 DONE: ADR 0001 (browser-tab transport, relay approval-required default), CDP concurrency spike (cap=5 tabs measured).
- P1 PARTIAL: conversation fabric types done (ADR 0002: ConversationEnvelope, DeliveryReceipt with unknown status, event log types, provider-neutral ChatDriver contract); Perplexity driver refactored onto the registry with unit-tested extraction (join+dedupe, keep-newest slice, whitespace preserved); conservative relay defaults. PENDING: the runtime event store (idempotency/replay persistence) - deliberately deferred since nothing consumes it until P4 relay.
- P2 DONE: Grok adapter live-validated (no stop button on Fast model - streaming uses 'Working for Xs' timing line); markdown extraction via innerHTML+turndown works across providers (ADR 0004); provider dispatcher (provider_ask/poll/stop MCP tools, comet_* aliases); 28 unit tests; all 5 providers discovered HIGH-confidence (entries as JSON data).
- Discovery is a SHIPPED TOOL (not test artifact): CLI + MCP tools, self-healing controls (ADR 0003: confidence-scored selectors + structural fingerprint rebind - re-renders survive without re-discovery).
- P3-P8 NOT STARTED: tab registry/CDP pool (P3), approval relay (P4), wait_any/scheduler (P5), Gemini/ChatGPT/Claude adapters (P6), fanout/debate (P7), observability (P8).

QUESTIONS (be specific, reference phase numbers):
1. Critique the phase plan: is the sequencing right? Any phase that should be split, reordered, or have its scope changed given what is now built?
2. What are the biggest risks/gaps in the plan, especially around P3 (multi-tab), P4 (relay + replay safety), and the deferred event store?
3. What would you change in the architecture or the type contracts (ConversationEnvelope, DeliveryReceipt, event log)?
4. Best next steps: given P0-P2 done, should we do P3 (tab registry) or finish P1 (event store) first, and why? What is the minimal path to the 'minimum useful release' (P0-P5 with Perplexity and Grok)?
5. Any operational/security concerns the plan under-weights (relay provenance, prompt injection, selector drift)?

Give a structured critique with concrete recommendations, ~400-600 words.`;

async function waitCompleted(driver, session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let poll, saw = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    poll = await driver.poll(session);
    if (poll.response.length > 0) saw = true;
    if (poll.state === 'completed' && saw) break;
  }
  return poll;
}

// 1. Grok — capture the already-rendered critique
const gs = await grokDriver.open();
const gp = await grokDriver.poll(gs);
console.log('GROK: state=' + gp.state + ' len=' + gp.response.length);
if (gp.response.length) {
  writeFileSync('C:/Dev/comet-mcp-feedback-grok.md', '# Grok critique (2026-08-07)\n\n' + gp.response + '\n\n---\n\n## Markdown\n\n' + (gp.markdown || '(none)') + '\n');
  console.log('  saved C:/Dev/comet-mcp-feedback-grok.md');
}

// 2. Perplexity — send prompt directly, wait, capture
const ps = await perplexityDriver.open();
const { receipt } = await perplexityDriver.ask(ps, normalizePrompt(PROMPT));
console.log('PERPLEXITY: receipt=' + receipt.status);
const pp = await waitCompleted(perplexityDriver, ps, 240000);
console.log('PERPLEXITY: state=' + pp.state + ' len=' + pp.response.length);
if (pp.response.length) {
  writeFileSync('C:/Dev/comet-mcp-feedback-perplexity.md', '# Perplexity critique (2026-08-07)\n\n' + pp.response + '\n\n---\n\n## Markdown\n\n' + (pp.markdown || '(none)') + '\n');
  console.log('  saved C:/Dev/comet-mcp-feedback-perplexity.md');
}
process.exit(0);
