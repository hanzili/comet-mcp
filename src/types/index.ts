/**
 * Type contracts for the conversation fabric and provider adapters (P1).
 *
 * - conversation.ts: ConversationEnvelope, event log, delivery receipts, correlation IDs,
 *   idempotency keys, provenance, budgets, conservative relay defaults.
 * - provider.ts: ChatDriver, ProviderEntry, TabSession, HealthReport, PollResult,
 *   ProviderState.
 *
 * These are provider-neutral: browser-tab automation is a transport, not the product
 * (ADR 0001 §Transport 3; executive synthesis §5).
 */

export * from './conversation.js';
export * from './provider.js';
