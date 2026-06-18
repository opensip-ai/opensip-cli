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
export interface AgentCatalog {
  readonly version: string;
  readonly description: string;
  readonly entryPoints: readonly {
    readonly command: string;
    readonly description: string;
    readonly examples: readonly string[];
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

export function buildAgentCatalog(): AgentCatalog {
  return {
    version: '1.0.0',
    description:
      'Stable, machine-oriented surface for AI agents using OpenSIP CLI. ' +
      'Focus on --json paths, sessions for historical results, and composable filters. ' +
      'Human UX (tables, banners) is preserved unchanged.',
    entryPoints: [
      {
        command: 'fit',
        description: 'Run fitness checks. Use --json for machine output (SignalEnvelope).',
        examples: ['opensip fit --recipe default --json', 'opensip fit --check some-check --json'],
      },
      {
        command: 'graph',
        description: 'Build static call graph + rules. --json yields SignalEnvelope.',
        examples: ['opensip graph --json', 'opensip graph --sarif out.sarif'],
      },
      {
        command: 'sessions list',
        description:
          'List stored sessions. --summary-only is agent-friendly (omits heavy payloads).',
        examples: [
          'opensip sessions list --json --summary-only',
          'opensip sessions list --json --tool fit --limit 5',
        ],
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
      },
      {
        command: 'agent-catalog',
        description: 'This command. Self-describing catalog for agents (JSON preferred).',
        examples: ['opensip agent-catalog --json'],
      },
    ],
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
