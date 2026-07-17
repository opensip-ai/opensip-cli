import { ValidationError } from '@opensip-cli/core';

import { compareCodePoint } from './code-point-order.js';

import type { CommandSpec, Tool, ToolRegistry } from '@opensip-cli/core';

export { compareCodePoint } from './code-point-order.js';

type CommandTier = 'platform' | 'tool' | 'internal';

interface EntryPoint {
  readonly command: string;
  readonly description: string;
  readonly examples: readonly string[];
  readonly tier?: CommandTier;
}

type ToolEntryOverlays = Readonly<Record<string, Partial<EntryPoint>>>;

/**
 * Internal Tier-3 command-name shapes that the public agent catalog must never
 * expose.
 */
export const INTERNAL_COMMAND_NAME_RE = /(?:-run-worker|-shard-worker|-equivalence-check)\b/;

const TOOL_ENTRY_OVERLAYS: ToolEntryOverlays = {
  fitness: {
    description:
      'Run fitness checks. Use --json for machine output (SignalEnvelope). Agent recipes: agent-fast, agent-risk, agent-final.',
    examples: [
      'opensip fit --recipe agent-fast --json --filter errors-only',
      'opensip fit --changed --include-impacted --json',
      'opensip fit --recipe agent-final --gate-compare',
    ],
  },
  graph: {
    description:
      'Build static call graph + rules. --json yields SignalEnvelope. Use graph impact for change-aware blast radius.',
    examples: [
      'opensip graph --json',
      'opensip graph impact --changed --json --top 20',
      'opensip graph --recipe agent-risk --json --filter high-impact',
    ],
  },
  sim: {
    description: 'Run simulation scenarios. Use --json for machine output (SignalEnvelope).',
    examples: ['opensip sim --json', 'opensip sim --recipe default --json'],
  },
  yagni: {
    description:
      'Run YAGNI reduction audit detectors. Advisory findings; --json yields SignalEnvelope.',
    examples: ['opensip yagni --json', 'opensip yagni --json packages/yagni/engine'],
  },
};

const PLATFORM_ENTRY_POINTS: readonly EntryPoint[] = [
  {
    command: 'audit',
    description:
      'Run the canonical changed-code review workflow. --json yields a suite result with scope, step verification, and reviewBrief; --open is human-only.',
    examples: ['opensip audit --json', 'opensip audit --files src/server.ts --json'],
    tier: 'platform' as const,
  },
  {
    command: 'suite run',
    description:
      'Run a configured or built-in suite. agent-context records privacy-safe, file-scope-bound non-finding evidence before editing; verdict suites produce reviewBrief when steps emit SignalEnvelopes.',
    examples: [
      'opensip suite run agent-context --files src/server.ts --json',
      'opensip suite run security --json',
    ],
    tier: 'platform' as const,
  },
  {
    command: 'status',
    description: "Show where this project's OpenSIP evidence is stored.",
    examples: ['opensip status --json'],
    tier: 'platform' as const,
  },
  {
    command: 'sessions list',
    description: 'List stored sessions. --summary-only is agent-friendly (omits heavy payloads).',
    examples: [
      'opensip sessions list --json --summary-only',
      'opensip sessions list --json --tool fitness --limit 5',
    ],
    tier: 'platform' as const,
  },
  {
    command: 'sessions show',
    description:
      'Retrieve a prior run as SessionReplayResult (includes projected SignalEnvelope). ' +
      'Supports latest + --tool and rich filtering.',
    examples: [
      'opensip sessions show latest --tool fitness --json',
      'opensip sessions show latest --tool fit --json --filter errors-only --filter top:20',
      'opensip sessions show GRAPH_01... --json --raw',
      'opensip sessions show previous --tool graph --json',
    ],
    tier: 'platform' as const,
  },
  {
    command: 'agent-catalog',
    description: 'This command. Self-describing catalog for agents (JSON preferred).',
    examples: ['opensip agent-catalog --json'],
    tier: 'platform' as const,
  },
  {
    command: 'policy status',
    description:
      'Inspect the effective local trust-policy mode, source tiers, org-cache state, and active exceptions.',
    examples: ['opensip policy status --json'],
    tier: 'platform' as const,
  },
  {
    command: 'policy explain',
    description:
      'Explain the policy decision for a local subject/action pair without running the target command.',
    examples: [
      'opensip policy explain installed-tool:audit-sec --action load --json',
      'opensip policy explain baseline:fit --action baseline-save --json',
    ],
    tier: 'platform' as const,
  },
  {
    command: 'policy audit',
    description: 'Read or export the durable local trust-policy audit event log.',
    examples: [
      'opensip policy audit --json --limit 50',
      'opensip policy audit --out opensip-policy-audit.json',
    ],
    tier: 'platform' as const,
  },
];

function overlayKeyCandidates(
  tool: Tool,
  primary: CommandSpec<unknown, unknown>,
): readonly string[] {
  const values = [
    primary.name,
    tool.metadata.name,
    tool.identity.name,
    ...(tool.identity.aliases ?? []),
    tool.identity.layoutKey,
  ];
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

/**
 * Return the public primary command for a tool, excluding internal worker names
 * and host-denied commands.
 */
export function publicPrimaryCommand(
  tool: Tool,
  internalCommands: ReadonlySet<string>,
): CommandSpec<unknown, unknown> | undefined {
  return (tool.commandSpecs ?? []).find(
    (spec) =>
      spec.parent === undefined &&
      spec.visibility !== 'internal' &&
      !internalCommands.has(spec.name) &&
      !INTERNAL_COMMAND_NAME_RE.test(spec.name),
  ) as CommandSpec<unknown, unknown> | undefined;
}

function allowedOverlayKeys(
  tools: ToolRegistry,
  internalCommands: ReadonlySet<string>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const tool of tools.list()) {
    const primary = publicPrimaryCommand(tool, internalCommands);
    if (primary === undefined) continue;
    for (const key of overlayKeyCandidates(tool, primary)) keys.add(key);
  }
  return keys;
}

/**
 * Resolve the curated catalog overlay for a registered tool primary, accepting
 * canonical names, metadata names, aliases, and layout keys.
 */
export function overlayForTool(
  tool: Tool,
  primary: CommandSpec<unknown, unknown>,
  overlays: ToolEntryOverlays = TOOL_ENTRY_OVERLAYS,
): Partial<EntryPoint> | undefined {
  for (const key of overlayKeyCandidates(tool, primary)) {
    const overlay = overlays[key];
    if (overlay !== undefined) return overlay;
  }
  return undefined;
}

/** Return the curated tool overlay keys in deterministic order. */
export function agentCatalogOverlayKeys(): readonly string[] {
  const keys = Object.keys(TOOL_ENTRY_OVERLAYS);
  keys.sort(compareCodePoint);
  return keys;
}

/** Return the static platform entry points exposed in the agent catalog. */
export function agentCatalogPlatformEntryPoints(): readonly EntryPoint[] {
  return PLATFORM_ENTRY_POINTS;
}

/**
 * Validate that every curated tool overlay maps to a registered public primary,
 * documented alias, or layout key.
 *
 * @throws {ValidationError} when one or more overlay keys do not map to a
 *   registered public tool command, alias, or layout key.
 */
export function assertAgentCatalogOverlayKeys(
  tools: ToolRegistry,
  internalCommands: ReadonlySet<string> = new Set(),
  overlays: ToolEntryOverlays = TOOL_ENTRY_OVERLAYS,
): void {
  const allowed = allowedOverlayKeys(tools, internalCommands);
  const staleKeys = Object.keys(overlays).filter((key) => !allowed.has(key));
  if (staleKeys.length > 0) {
    const sortedStaleKeys = [...staleKeys];
    sortedStaleKeys.sort(compareCodePoint);
    throw new ValidationError(
      `agent-catalog: tool overlay key(s) do not match a registered public primary, alias, or layout key: ${sortedStaleKeys.join(', ')}`,
      { code: 'AGENT_CATALOG.STALE_TOOL_OVERLAY' },
    );
  }
}
