/**
 * `agent-catalog` command adapter.
 *
 * The catalog projection (`buildAgentCatalog` + its `AgentCatalog` / `CommandTier`
 * types) was re-homed into `@opensip-cli/contracts` (ADR-0084) so
 * `@opensip-cli/mcp` can serve the same surface without importing the
 * composition root. This module re-exports it for existing call sites/tests and
 * keeps the host rendering wrapper (`executeAgentCatalog`).
 */

import { RESERVED_SUITE_NAMES } from '@opensip-cli/config';
import {
  assembleAgentCatalog,
  hostSupportFromRuntimeProjection,
  summarizeTargetConventions,
  type AgentHostSupport,
} from '@opensip-cli/contracts';
import {
  currentScope,
  PLATFORM_SUPPORT_CONTRACT_VERSION,
  projectRuntimeHostSupport,
  type ToolRegistry,
} from '@opensip-cli/core';

import { HOST_RESERVED_ROOT_COMMANDS } from '../bootstrap/reserved-names.js';

export { buildAgentCatalog } from '@opensip-cli/contracts';
export type { AgentCatalog, CommandTier } from '@opensip-cli/contracts';

/**
 * Project the live host against the platform-support registry from
 * process-observable facts only (platform / arch / Node version / Node ABI).
 * Mapped through the shared contracts helper so the CLI and MCP catalogs emit a
 * byte-identical `hostSupport` for identical facts (Plan 02 / Plan 03 handoff).
 * npm, filesystem, case behavior, OS product version, and kernel name/version
 * stay unobserved, so the result is never an exact match.
 */
function liveHostSupport(): AgentHostSupport {
  return hostSupportFromRuntimeProjection(
    projectRuntimeHostSupport({
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules,
    }),
    PLATFORM_SUPPORT_CONTRACT_VERSION,
  );
}

/**
 * One concise, non-alarming host-support line for the human summary. It reports
 * the effective status, the local match level (never `exact` from process-only
 * facts), and the public matrix URL — it is informational only and never prints
 * a warning or changes the command's exit status.
 */
function hostSupportSummaryLine(hostSupport: AgentHostSupport | undefined): string {
  if (hostSupport === undefined)
    return 'Host support: unavailable (see the supported-platforms matrix).';
  const where = hostSupport.matrixUrl ?? 'the supported-platforms matrix';
  return `Host support: ${hostSupport.status} (local match: ${hostSupport.match}) — see ${where}`;
}

export function executeAgentCatalog(
  opts: {
    readonly json?: boolean;
    readonly tools?: ToolRegistry;
    readonly internalCommands?: ReadonlySet<string>;
  } = {},
) {
  // Scope access stays HERE, in the composition-root adapter — the shared
  // contracts assembler is pure and receives every fact explicitly (Plan 03).
  const targetConventions = summarizeTargetConventions(currentScope()?.targets);
  const catalog = assembleAgentCatalog({
    tools: opts.tools,
    internalCommands: opts.internalCommands,
    // ADR-0159: the CLI is the admission authority for host-reserved roots, so it
    // passes its static set directly (sorted, preserving the historical CLI
    // output) alongside config's reserved suite names. The assembler copies both
    // WITHOUT reordering and advertises them so Tool authors/agents learn the
    // constraint from discovery rather than an admission-time rejection.
    rootCommands: [...HOST_RESERVED_ROOT_COMMANDS].sort(),
    suiteNames: RESERVED_SUITE_NAMES,
    hostSupport: liveHostSupport(),
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
    hostSupportSummaryLine(catalog.hostSupport),
    '',
    'See --json output or the docs for complete shapes and more examples.',
  ];

  return {
    type: 'text-lines',
    title: 'Agent Catalog',
    lines,
  };
}
