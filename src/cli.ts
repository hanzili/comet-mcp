/**
 * comet-mcp CLI — on-demand provider discovery and verification.
 *
 * Usage:
 *   comet-mcp discover --provider grok [--diff] [--no-write]
 *   comet-mcp verify --provider grok
 *   comet-mcp list
 *
 * This is the primary on-demand trigger for the discovery workflow (ADR 0001:
 * live UI discovery/repair is an opt-in operational workflow, not a hot-path
 * dependency). The bin entry (dist/index.js) dispatches: a `discover`/`verify`/`list`
 * subcommand runs this CLI; otherwise the MCP server starts.
 */

import { runDiscovery, verifyProvider, diffEntry, listProviders } from './core/discovery.js';
import { loadAllEntries } from './core/registry.js';
import type { ProviderId } from './types/conversation.js';

function asProvider(s: string): ProviderId | null {
  return listProviders().includes(s as ProviderId) ? (s as ProviderId) : null;
}

export async function runCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case 'discover': {
      const providerArg = argValue(rest, '--provider');
      const provider = providerArg ? asProvider(providerArg) : null;
      if (!provider) { console.error('usage: comet-mcp discover --provider <name> [--diff] [--no-write]'); return 2; }
      if (!listProviders().includes(provider)) {
        console.error(`unknown provider: ${provider} (have: ${listProviders().join(', ')})`);
        return 2;
      }
      const diff = rest.includes('--diff');
      const write = !rest.includes('--no-write');
      console.log(`discovering ${provider}…`);
      const result = await runDiscovery(provider, { write });
      console.log(`  state: ${result.endedState}  confidence: ${result.confidence}`);
      console.log(`  prompt: "${result.validationPrompt}" (expect "${result.expectedToken}")`);
      console.log(`  submit: ${result.submitMethod?.method ?? '?'}${result.submitMethod?.selector ? ' via ' + result.submitMethod.selector : ''}`);
      console.log(`  entry ${result.wroteEntry ? `written: ${result.entryPath}` : '(not written)'}`);
      if (result.guarded?.existingBetter) console.log(`  ⚠ NOT overwritten (downgrade guard): ${result.guarded.reason}`);
      const fixtures = Object.keys(result.fixtures);
      if (fixtures.length) console.log(`  fixtures: ${fixtures.join(', ')}`);
      if (diff) {
        const d = diffEntry(provider, result.entry);
        console.log(`\n== diff vs ${d.against ?? 'none'} ==`);
        if (d.changes.length) console.log(d.changes.join('\n'));
        else console.log('provider entry unchanged');
      }
      return 0;
    }

    case 'verify': {
      const providerArg = argValue(rest, '--provider');
      const provider = providerArg ? asProvider(providerArg) : null;
      if (!provider) { console.error('usage: comet-mcp verify --provider <name>'); return 2; }
      const result = await verifyProvider(provider);
      if (!result.tabFound) {
        console.log(`no ${provider} tab found — open the provider tab in Comet first`);
        return 1;
      }
      console.log(`${provider} verify (no prompt sent):`);
      for (const c of result.checks) {
        const conf = c.confidence !== undefined ? ` conf=${c.confidence.toFixed(2)}` : '';
        console.log(`  [${c.ok ? 'OK' : 'MISS'}] ${c.name}: ${c.selector}${c.conditional ? ' (conditional)' : ''}${conf}`);
      }
      if (result.rebound?.length) console.log(`  ↺ rebind: ${result.rebound.join(', ')} (re-render survived)`);
      console.log(result.healthy ? 'HEALTHY' : 'UNHEALTHY — re-run: comet-mcp discover --provider ' + provider + ' --diff');
      return result.healthy ? 0 : 1;
    }

    case 'list': {
      const entries = loadAllEntries();
      if (entries.size === 0) { console.log('no provider entries yet — run comet-mcp discover --provider <name>'); return 0; }
      console.log('provider entries:');
      for (const [provider, entry] of entries) {
        const controls = Object.keys(entry.controls || {}).join(',');
        console.log(`  ${provider.padEnd(10)} ${entry.confidence.padEnd(6)} discovered ${entry.discoveredAt}  controls: ${controls}`);
      }
      return 0;
    }

    default:
      console.error(`unknown subcommand: ${sub}`);
      console.error('usage: comet-mcp discover|verify|list [--provider <name>] [--diff] [--no-write]');
      return 2;
  }
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
