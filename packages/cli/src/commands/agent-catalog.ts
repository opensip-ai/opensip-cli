/**
 * `agent-catalog` command adapter.
 *
 * The catalog projection (`buildAgentCatalog` + its `AgentCatalog` / `CommandTier`
 * types) was re-homed into `@opensip-cli/contracts` (ADR-0084) so
 * `@opensip-cli/mcp` can serve the same surface without importing the
 * composition root. This module re-exports it for existing call sites/tests and
 * keeps the host rendering wrapper (`executeAgentCatalog`).
 */

import { buildAgentCatalog, summarizeTargetConventions } from '@opensip-cli/contracts';
import { currentScope, type ToolRegistry } from '@opensip-cli/core';

export { buildAgentCatalog } from '@opensip-cli/contracts';
export type { AgentCatalog, CommandTier } from '@opensip-cli/contracts';

export function executeAgentCatalog(
  opts: {
    readonly json?: boolean;
    readonly tools?: ToolRegistry;
    readonly internalCommands?: ReadonlySet<string>;
  } = {},
) {
  const targetConventions = summarizeTargetConventions(currentScope()?.targets);
  const catalog = buildAgentCatalog({
    tools: opts.tools,
    internalCommands: opts.internalCommands,
    ...(targetConventions.length === 0 ? {} : { projectContext: { targetConventions } }),
  });

  if (opts.json === true) {
    // Return a result shape that the host can emit cleanly.
    // Using a plain object here; a proper AgentCatalogResult union member
    // can be added in Phase 6 wiring for full type safety / parity.
    return {
      type: 'agent-catalog',
      catalog,
    };
  }

  // Human summary (simple, not the full catalog dump).
  const lines: string[] = [
    'Agent Catalog (use --json for the full machine-readable version)',
    '',
    'Primary patterns for agents:',
    ...catalog.commonPatterns.map((p) => `  • ${p.name}: ${p.example}`),
    '',
    'Key entry points: ' + catalog.entryPoints.map((e) => e.command).join(', '),
    '',
    'See --json output or the docs for complete shapes and more examples.',
  ];

  return {
    type: 'text-lines',
    title: 'Agent Catalog',
    lines,
  };
}
