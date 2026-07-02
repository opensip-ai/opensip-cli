/**
 * Structured catalog for AI agents.
 * Provides stable entry points, recommended patterns (including the agent
 * ergonomics like --filter, --raw, --summary-only), and example shapes. This is
 * intentionally a small, self-contained surface so agents can bootstrap their
 * usage without parsing --help text or source.
 *
 * Re-homed from `packages/cli/src/commands/agent-catalog.ts` (ADR-0084) so
 * `@opensip-cli/mcp` can serve the same catalog (its `get_agent_catalog` tool)
 * without importing the composition root (`cli` is layer 6; a tool→cli edge
 * would cycle). The CLI command file keeps the rendering wrapper
 * (`executeAgentCatalog`) and re-exports `buildAgentCatalog` from here, so the
 * `agent-catalog` command + its tests are unchanged.
 *
 * Command taxonomy (tool-command-surface-taxonomy):
 * - Entry points are keyed by the PUBLIC command path. A `parent`-nested tool
 *   verb (the `<tool> <verb>` grammar enabled by `CommandSpec.parent` — e.g.
 *   `graph export`, `fit list`) is catalogued UNDER its tool's entry point
 *   (the `<tool> <verb>` form), NOT as a separate root entry point.
 * - Tier-3 `visibility: 'internal'` commands (`*-run-worker`, `*-shard-worker`,
 *   `*-equivalence-check`) are NEVER catalogued here — the agent-catalog
 *   primary surface excludes internal workers.
 */

import type { CommandSpec, Tool, ToolRegistry } from '@opensip-cli/core';

/**
 * The command-taxonomy tier an entry point belongs to
 * (tool-command-surface-taxonomy). `'platform'` = host-owned Tier-1 commands
 * (`init`, `sessions`, `agent-catalog`, …); `'tool'` = a Tier-2 tool verb
 * (`fit`, `graph`, `sim`, and their `<tool> <verb>` sub-verbs). `'internal'`
 * (Tier-3 workers) is part of the union for completeness ONLY — the agent-catalog
 * NEVER emits an `internal` entry point (its primary surface excludes Tier-3).
 */
export type CommandTier = 'platform' | 'tool' | 'internal';

/**
 * The machine-readable description of opensip-cli's command surface emitted by
 * `opensip agent-catalog` and consumed over MCP. It advertises the public entry
 * points (Tier-1 platform commands + Tier-2 tool verbs), common usage patterns,
 * the shapes a caller gets back, and free-form usage notes — everything an agent
 * needs to drive the CLI without reading its source.
 */
export interface AgentCatalog {
  readonly version: string;
  readonly description: string;
  readonly entryPoints: readonly {
    readonly command: string;
    readonly description: string;
    readonly examples: readonly string[];
    /**
     * Taxonomy tier of this entry point (tool-command-surface-taxonomy). Additive
     * (optional) so existing consumers of the `entryPoints` shape are unaffected;
     * present on every entry the catalog ships so an agent sees the predictable
     * Tier-1/Tier-2 structure. NEVER `'internal'` — Tier-3 is excluded from this
     * surface by construction (see {@link assertNoInternalEntryPoints}).
     */
    readonly tier?: CommandTier;
  }[];
  readonly commonPatterns: readonly {
    readonly name: string;
    readonly description: string;
    readonly example: string;
  }[];
  readonly outputShapes: {
    readonly signalEnvelope: string; // high-level note + reference
    readonly reviewBrief: string;
    readonly sessionReplay: string;
    readonly history: string;
  };
  readonly notes: readonly string[];
}

type EntryPoint = AgentCatalog['entryPoints'][number];

/**
 * Internal (Tier-3) command-name shapes the agent-catalog must NEVER surface:
 * the IPC/CI workers and the equivalence gate. The guard checks both the name
 * shape AND an explicit `tier: 'internal'` so a future edit can't slip one in by
 * either route. This is the by-construction complement to the Phase 4 test.
 */
const INTERNAL_COMMAND_NAME_RE = /(?:-run-worker|-shard-worker|-equivalence-check)\b/;

function compareCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Throw if any entry point is a Tier-3 internal command (by name shape or by an
 * explicit `tier: 'internal'`). Called at catalog-build time so a regression that
 * pastes an internal command into `entryPoints` fails loudly the first time the
 * catalog is built, not silently at the agent boundary.
 *
 * @throws {Error} When an entry point is a Tier-3 internal command — by an
 *   explicit `tier: 'internal'` or by an internal command-name shape
 *   (`*-run-worker` / `*-shard-worker` / `*-equivalence-check`).
 */
function assertNoInternalEntryPoints(
  entryPoints: readonly {
    readonly command: string;
    readonly tier?: CommandTier;
  }[],
): void {
  const leaked = entryPoints.find(
    (e) => e.tier === 'internal' || INTERNAL_COMMAND_NAME_RE.test(e.command),
  );
  if (leaked !== undefined) {
    throw new Error(
      `agent-catalog: Tier-3 internal command '${leaked.command}' must not appear in the ` +
        'agent-catalog primary surface (tool-command-surface-taxonomy). Remove it from entryPoints.',
    );
  }
}

const TOOL_ENTRY_OVERLAYS: Readonly<Record<string, Partial<EntryPoint>>> = {
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
    examples: ['opensip sim --json', 'opensip sim --scenario default --json'],
  },
  yagni: {
    description:
      'Run YAGNI reduction audit detectors. Advisory findings; --json yields SignalEnvelope.',
    examples: ['opensip yagni --json', 'opensip yagni --json packages/yagni/engine'],
  },
};

const PLATFORM_ENTRY_POINTS: readonly EntryPoint[] = [
  {
    command: 'suite run',
    description:
      'Run a configured multi-tool suite. --json yields a command result with reviewBrief when the suite steps emit SignalEnvelopes.',
    examples: ['opensip suite run security --json'],
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
];

function publicPrimaryCommand(
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

function entryPointForTool(
  tool: Tool,
  internalCommands: ReadonlySet<string>,
): EntryPoint | undefined {
  const primary = publicPrimaryCommand(tool, internalCommands);
  if (primary === undefined) return undefined;
  const overlay = TOOL_ENTRY_OVERLAYS[primary.name] ?? TOOL_ENTRY_OVERLAYS[tool.metadata.name];
  const supportsJson = primary.commonFlags?.includes('json') === true;
  let defaultDescription: string;
  if (supportsJson) {
    defaultDescription = `${primary.description} Use --json when available for machine output.`;
  } else if (primary.output === 'raw-stream') {
    defaultDescription = `${primary.description} Raw-stream transport; use the command protocol directly, not --json.`;
  } else {
    defaultDescription = `${primary.description} This command does not declare --json; use its documented output.`;
  }
  const defaultExamples = supportsJson
    ? [`opensip ${primary.name} --json`]
    : [`opensip ${primary.name}`];
  return {
    command: primary.name,
    description: overlay?.description ?? defaultDescription,
    examples: overlay?.examples ?? defaultExamples,
    tier: 'tool',
  };
}

function deriveToolEntryPoints(
  tools: ToolRegistry | undefined,
  internalCommands: ReadonlySet<string>,
): readonly EntryPoint[] {
  return (tools?.list() ?? [])
    .map((tool) => entryPointForTool(tool, internalCommands))
    .filter((entry): entry is EntryPoint => entry !== undefined)
    .sort((a, b) => compareCodePoint(a.command, b.command));
}

/**
 * Build the {@link AgentCatalog} for this invocation: derive a Tier-2 entry
 * point per registered tool, append the static Tier-1 platform commands, assert
 * no Tier-3 (`internal`) command leaks into the surface, and return the assembled
 * catalog. With no `tools` registry the result carries only the platform entries.
 */
export function buildAgentCatalog(
  input: {
    readonly tools?: ToolRegistry;
    readonly internalCommands?: ReadonlySet<string>;
  } = {},
): AgentCatalog {
  const entryPoints = [
    ...deriveToolEntryPoints(input.tools, input.internalCommands ?? new Set()),
    ...PLATFORM_ENTRY_POINTS,
  ];
  assertNoInternalEntryPoints(entryPoints);
  return {
    version: '1.0.0',
    description:
      'Stable, machine-oriented surface for AI agents using OpenSIP CLI. ' +
      'Focus on --json paths, sessions for historical results, and composable filters. ' +
      'Human UX (tables, banners) is preserved unchanged.',
    entryPoints,
    commonPatterns: [
      {
        name: 'Read latest result first (read-latest-result)',
        description:
          'When the user says a tool already reported findings, inspect the latest stored result before re-running.',
        example:
          'opensip sessions show latest --tool fit --json --filter errors-only --filter top:20',
      },
      {
        name: 'Agent edit loop',
        description: 'Fast check → impact analysis → changed-only fit → final gate.',
        example:
          'opensip fit --recipe agent-fast --json && opensip graph impact --changed --json && opensip fit --changed --include-impacted --json',
      },
      {
        name: 'Read suite review brief',
        description:
          'For configured custom suites, read the host-owned review brief before inspecting individual tool payloads.',
        example: 'opensip suite run security --json',
      },
      {
        name: 'Inspect latest fit with focus on errors',
        description:
          'After a fit run, pull only actionable errors (high severity) and limit count.',
        example:
          'opensip sessions show latest --tool fit --json --filter errors-only --filter top:10',
      },
      {
        name: 'Lean session menu for agents',
        description:
          'Get pointers to interesting sessions without downloading full historical payloads.',
        example: 'opensip sessions list --json --summary-only --tool fit',
      },
      {
        name: 'Minimal raw envelope for token-sensitive agents',
        description: 'Bypass the standard CommandResult wrapper when you only need the core data.',
        example: 'opensip sessions show latest --tool graph --json --raw',
      },
      {
        name: 'Relative navigation',
        description: 'Walk backwards through recent runs of a specific tool without tracking IDs.',
        example: 'opensip sessions show previous --tool fit --json --filter warnings-only',
      },
    ],
    outputShapes: {
      signalEnvelope:
        'The canonical cross-tool currency (schemaVersion, tool, runId, verdict, units, signals). ' +
        'Every fit/graph/sim result (live or replayed) carries one. See contracts for full type.',
      reviewBrief:
        'For suite run: { type: "suite-run", suite, suiteRunId, aggregate, steps, reviewBrief: { version: 1, verdict, changedFiles, topRisks, newFindings, baselineDelta, degraded, recommendedActions } }',
      sessionReplay:
        'For sessions show: { session: {id,tool,startedAt,completedAt,score,passed,...}, fidelity: "projection", envelope: SignalEnvelope, filtersApplied?, ...counts }',
      history:
        'For sessions list: { type: "history", sessions: HistorySession[] } where each has showCommand + optional summary.',
    },
    notes: [
      'Agent recipes (when present): fit agent-fast / agent-risk / agent-final; graph agent-risk / agent-final.',
      'Live runs support --filter/--top/--raw on fit/graph/sim --json (same engine as sessions show).',
      'graph impact answers changed→impacted without a separate git diff dance.',
      'Commands that expose machine-readable command results use --json. Raw-stream transports such as mcp document their own stdout protocol.',
      'filtersApplied, originalSignalCount, returnedSignalCount appear when --filter is used.',
      'The fidelity field on replays is always "projection" (rebuilt from persisted data).',
      'Human-readable output (no --json) uses the same tables/banners as before — unchanged.',
      // Uniform tool-primary surface (host-guaranteed; decorateToolPrimary).
      'Every tool primary (fit/graph/sim/yagni and any third-party tool) accepts `<tool> --version` ' +
        '(prints the TOOL version, e.g. `fit 0.1.6`; distinct from `opensip --version`, the CLI), ' +
        'plus its declared common flags. Do not assume raw-stream primaries accept --json.',
      'Dogfood gate requires 0 errors + 0 warnings on fit:ci and graph:ci after any change.',
      // Hygiene invariant (host-planes-scope-seams-hygiene Phases 2-4): everything runs inside an
      // entered RunScope; the only sanctioned seams for output, delivery, baselines, toolState,
      // and hostPlanes (governance/audit/entitlements) are the documented methods on ToolCliContext
      // (render, emitJson, emitEnvelope, deliverSignals, writeArtifact, writeSarif, + the
      // baseline/toolState/hostPlanes accessors). Direct stdout, the old pre-scope holder, or
      // raw datastore from handlers is forbidden and caught by ESLint + fitness check + runtime
      // guards. Bootstrap root is exempted.
      'Only the methods on the ToolCliContext you receive are allowed for emission/state/planes.',
    ],
  };
}
