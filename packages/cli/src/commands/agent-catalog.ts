/**
 * Structured catalog for AI agents.
 * Provides stable entry points, recommended patterns (including the new
 * agent ergonomics like --filter, --raw, --summary-only), and example shapes.
 * This is intentionally a small, self-contained surface so agents can
 * bootstrap their usage without parsing --help text or source.
 *
 * Future: can be made more dynamic by introspecting live CommandSpecs
 * (see completion.ts for precedent).
 *
 * Command taxonomy (tool-command-surface-taxonomy):
 * - Entry points are keyed by the PUBLIC command path. A `parent`-nested tool
 *   verb (the `<tool> <verb>` grammar enabled by `CommandSpec.parent` — e.g.
 *   `graph export`, `fit list`) is catalogued UNDER its tool's entry point
 *   (the `<tool> <verb>` form), NOT as a separate root entry point.
 * - Tier-3 `visibility: 'internal'` commands (`*-run-worker`, `*-shard-worker`,
 *   `*-equivalence-check`) are NEVER catalogued here — the agent-catalog
 *   primary surface excludes internal workers (the host-owned tiering pass
 *   formalized in Phase 1 filters them when this surface becomes spec-derived).
 * In Phase 0 no tool declares `parent`/`visibility`, so the static catalog below
 * already satisfies both rules (no nested verb, no internal worker is listed).
 */
/**
 * The command-taxonomy tier an entry point belongs to
 * (tool-command-surface-taxonomy). `'platform'` = host-owned Tier-1 commands
 * (`init`, `sessions`, `agent-catalog`, …); `'tool'` = a Tier-2 tool verb
 * (`fit`, `graph`, `sim`, and their `<tool> <verb>` sub-verbs). `'internal'`
 * (Tier-3 workers) is part of the union for completeness ONLY — the agent-catalog
 * NEVER emits an `internal` entry point (its primary surface excludes Tier-3).
 */
export type CommandTier = 'platform' | 'tool' | 'internal';

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
    readonly sessionReplay: string;
    readonly history: string;
  };
  readonly notes: readonly string[];
}

/**
 * Internal (Tier-3) command-name shapes the agent-catalog must NEVER surface:
 * the IPC/CI workers and the equivalence gate. The guard checks both the name
 * shape AND an explicit `tier: 'internal'` so a future edit can't slip one in by
 * either route. This is the by-construction complement to the Phase 4 test.
 */
const INTERNAL_COMMAND_NAME_RE = /(?:-run-worker|-shard-worker|-equivalence-check)\b/;

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
  entryPoints: readonly { readonly command: string; readonly tier?: CommandTier }[],
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

export function buildAgentCatalog(): AgentCatalog {
  // tool-command-surface-taxonomy Task 1.4: every entry point is annotated with
  // its taxonomy `tier` so an agent sees the predictable Tier-1/Tier-2 shape, and
  // NO Tier-3 internal worker is catalogued. The static list below is the
  // primary surface; `assertNoInternalEntryPoints` guards (by construction)
  // against a future edit pasting an internal command in (the Phase 4 test
  // also asserts this).
  const entryPoints = [
    {
      command: 'fit',
      description: 'Run fitness checks. Use --json for machine output (SignalEnvelope).',
      examples: ['opensip fit --recipe default --json', 'opensip fit --check some-check --json'],
      tier: 'tool' as const,
    },
    {
      command: 'graph',
      description: 'Build static call graph + rules. --json yields SignalEnvelope.',
      examples: ['opensip graph --json', 'opensip graph --sarif out.sarif'],
      tier: 'tool' as const,
    },
    {
      command: 'yagni',
      description:
        'Run YAGNI reduction audit detectors. Advisory findings; --json yields SignalEnvelope.',
      examples: ['opensip yagni --json', 'opensip yagni --json --graph off'],
      tier: 'tool' as const,
    },
    {
      command: 'sessions list',
      description: 'List stored sessions. --summary-only is agent-friendly (omits heavy payloads).',
      examples: [
        'opensip sessions list --json --summary-only',
        'opensip sessions list --json --tool fit --limit 5',
      ],
      tier: 'platform' as const,
    },
    {
      command: 'sessions show',
      description:
        'Retrieve a prior run as SessionReplayResult (includes projected SignalEnvelope). ' +
        'Supports latest + --tool and rich filtering.',
      examples: [
        'opensip sessions show latest --tool fit --json',
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
      sessionReplay:
        'For sessions show: { session: {id,tool,startedAt,completedAt,score,passed,...}, fidelity: "projection", envelope: SignalEnvelope, filtersApplied?, ...counts }',
      history:
        'For sessions list: { type: "history", sessions: HistorySession[] } where each has showCommand + optional summary.',
    },
    notes: [
      'All machine output is under --json. Use --raw on show for the smallest possible payload.',
      'filtersApplied, originalSignalCount, returnedSignalCount appear when --filter is used.',
      'The fidelity field on replays is always "projection" (rebuilt from persisted data).',
      'Human-readable output (no --json) uses the same tables/banners as before — unchanged.',
      // Uniform tool-primary surface (host-guaranteed; decorateToolPrimary).
      'Every tool primary (fit/graph/sim and any third-party tool) accepts `<tool> --version` ' +
        '(prints the TOOL version, e.g. `fit 0.1.6`; distinct from `opensip --version`, the CLI), ' +
        'plus the guaranteed baseline flags --cwd, --json, --config, --quiet, --verbose.',
      'Dogfood gate requires 0 errors + 0 warnings on fit:ci and graph:ci after any change.',
      // Hygiene invariant (host-planes-scope-seams-hygiene Phases 2-4): everything runs inside an
      // entered RunScope; the only sanctioned seams for output, delivery, baselines, toolState,
      // and hostPlanes (governance/audit/entitlements) are the documented methods on ToolCliContext
      // (render, emitJson, emitEnvelope, deliverSignals, writeSarif, + the baseline/toolState/hostPlanes
      // accessors). Direct stdout, the old pre-scope holder, or raw datastore from handlers is
      // forbidden and caught by ESLint + fitness check + runtime guards. Bootstrap root is exempted.
      'Only the methods on the ToolCliContext you receive are allowed for emission/state/planes.',
    ],
  };
}

export function executeAgentCatalog(opts: { json?: boolean } = {}) {
  const catalog = buildAgentCatalog();

  if (opts.json) {
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
