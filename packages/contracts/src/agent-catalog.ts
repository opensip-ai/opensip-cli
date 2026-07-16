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

import { ValidationError } from '@opensip-cli/core';

import {
  INTERNAL_COMMAND_NAME_RE,
  agentCatalogPlatformEntryPoints,
  assertAgentCatalogOverlayKeys,
  compareCodePoint,
  overlayForTool,
  publicPrimaryCommand,
} from './agent-catalog-entries.js';

import type { AgentHostSupport } from './host-support.js';
import type { AgentProjectContext } from './target-conventions.js';
import type { Tool, ToolRegistry } from '@opensip-cli/core';

export {
  agentCatalogOverlayKeys,
  agentCatalogPlatformEntryPoints,
  assertAgentCatalogOverlayKeys,
} from './agent-catalog-entries.js';

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
    readonly taskContext: string;
    readonly repairApplyVerify: string;
    readonly sessionReplay: string;
    readonly history: string;
  };
  readonly projectContext?: AgentProjectContext;
  /**
   * Names no Tool or configured suite may claim (ADR-0159). Additive
   * (optional): the composition root injects the live lists (it owns them —
   * this contracts layer cannot import the cli or config packages), so
   * catalogs built without them (e.g. over MCP) simply omit the field.
   * `rootCommands` = host-owned root commands a Tool cannot mount;
   * `suiteNames` = built-in suite names a configured suite cannot use.
   */
  readonly reservedNames?: {
    readonly rootCommands: readonly string[];
    readonly suiteNames: readonly string[];
  };
  /**
   * Honest, process-only host-support projection (Plan 02, macOS GA). Additive
   * (optional): the composition root observes the live process, asks core to
   * classify it, and injects the serializable projection here. Catalogs built
   * without it (e.g. a bare contracts builder) simply omit the field. The
   * value is NEVER an exact match — npm/filesystem/install-channel are
   * unobserved at runtime — so agents must distinguish the row's published
   * status from the local `match`.
   */
  readonly hostSupport?: AgentHostSupport;
  readonly notes: readonly string[];
}

type EntryPoint = AgentCatalog['entryPoints'][number];

/**
 * Throw if any entry point is a Tier-3 internal command (by name shape or by an
 * explicit `tier: 'internal'`). Called at catalog-build time so a regression that
 * pastes an internal command into `entryPoints` fails loudly the first time the
 * catalog is built, not silently at the agent boundary.
 *
 * @throws {ValidationError} When an entry point is a Tier-3 internal command —
 *   by an explicit `tier: 'internal'` or by an internal command-name shape
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
    throw new ValidationError(
      `agent-catalog: Tier-3 internal command '${leaked.command}' must not appear in the ` +
        'agent-catalog primary surface (tool-command-surface-taxonomy). Remove it from entryPoints.',
      { code: 'AGENT_CATALOG.INTERNAL_ENTRY_POINT' },
    );
  }
}

function entryPointForTool(
  tool: Tool,
  internalCommands: ReadonlySet<string>,
): EntryPoint | undefined {
  const primary = publicPrimaryCommand(tool, internalCommands);
  if (primary === undefined) return undefined;
  const overlay = overlayForTool(tool, primary);
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
 * Named input for the sole catalog content builder {@link buildAgentCatalog}.
 * Readonly and self-contained: it carries the admitted `tools`, the internal
 * command denylist, an already-bounded project context, the caller-controlled
 * `validateOverlays` flag, the injected reserved-name lists (ADR-0159), and
 * Plan 02's process-only host-support projection. Extracted (was anonymous) so
 * both transports name the same input and a new common field cannot silently
 * reach only one adapter.
 */
export interface AgentCatalogBuildInput {
  readonly tools?: ToolRegistry;
  readonly internalCommands?: ReadonlySet<string>;
  readonly projectContext?: AgentProjectContext;
  readonly validateOverlays?: boolean;
  readonly reservedNames?: AgentCatalog['reservedNames'];
  readonly hostSupport?: AgentHostSupport;
}

/**
 * Build the {@link AgentCatalog} for this invocation: derive a Tier-2 entry
 * point per registered tool, append the static Tier-1 platform commands, assert
 * no Tier-3 (`internal`) command leaks into the surface, and return the assembled
 * catalog. With no `tools` registry the result carries only the platform entries.
 */
export function buildAgentCatalog(input: AgentCatalogBuildInput = {}): AgentCatalog {
  if (input.validateOverlays === true && input.tools !== undefined) {
    assertAgentCatalogOverlayKeys(input.tools, input.internalCommands ?? new Set());
  }
  const entryPoints = [
    ...deriveToolEntryPoints(input.tools, input.internalCommands ?? new Set()),
    ...agentCatalogPlatformEntryPoints(),
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
        name: 'Prepare before-edit task context',
        description:
          'Call MCP get_context_status with files: ["src/server.ts"] first. Trust it only when status is available, fileScope.status is matched, manifest.readiness is ready, and every required plane is current, complete, uncapped, and backed by an available durable pointer; otherwise recapture bounded inventory, graph, and static test-selection evidence.',
        example: 'opensip suite run agent-context --files src/server.ts --json',
      },
      {
        name: 'Agent edit loop',
        description:
          'Fast check → impact analysis → changed/impacted fit with trust metadata → final gate.',
        example:
          'opensip fit --recipe agent-fast --json && opensip graph impact --changed --json && opensip fit --changed --include-impacted --json',
      },
      {
        name: 'Read audit review brief',
        description:
          'For PR review workflows, use MCP review_change when available; use the canonical host-owned audit review brief when fresh execution is needed.',
        example: 'opensip audit --json',
      },
      {
        name: 'Apply and verify a structured repair',
        description:
          'Preview first, then apply a structured signal.repair action with --verify. Claim the fix is verified only when verification.status is "verified".',
        example:
          'opensip repair preview latest --tool fit --signal index:0 --json && opensip repair apply latest --tool fit --signal index:0 --action replace-ts-ignore --verify --json',
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
      {
        name: 'Explain a trust-policy denial',
        description:
          'When a Tool, capability pack, disabled check, or baseline save is denied, inspect the same local policy decision without re-running the mutating command.',
        example: 'opensip policy explain installed-tool:audit-sec --action load --json',
      },
    ],
    outputShapes: {
      signalEnvelope:
        'The canonical cross-tool currency (schemaVersion, tool, runId, verdict, units, signals). ' +
        'Every fit/graph/sim result (live or replayed) carries one. See contracts for full type.',
      reviewBrief:
        'For MCP review_change: { data: { reviewBrief: { version: 1, verdict, changedFiles, topRisks, correlatedRisks?, newFindings, baselineDelta, degraded, recommendedActions }, source, freshness } }. For audit or suite run: { type: "suite-run", suite, suiteRunId, runId?, scope?: { mode, source, ref?, changedFiles?, notice? }, aggregate, steps: [{ verification?: { coverage, fallback, fullyVerified, uncertainties } }], reviewBrief: { version: 1, correlatedRisks?, ... } }',
      taskContext:
        'For suite run agent-context: { type: "suite-run", runId, contextManifest: { schemaVersion, createdAt, projectIdentity, readiness, sourceStart, sourceEnd, fileScope: {mode,fileCount,filesIdentity}, graphIdentity?, inventoryIdentity?, planes: [{kind,status,required,producer:{toolId,command,version},pointer?,step,freshness,coverage,caps,reasonCodes,followUpReads}], reasonCodes, nextActions } }. get_context_status accepts the same explicit files and returns status, fileScope.status, the manifest, and exact pointer replay statuses. Trust requires available + matched + ready and every required plane current, complete, uncapped, and pointer-available. Context evidence is not a finding or ReviewBrief; raw paths are never stored in fileScope, and project roots are never stored in projectIdentity.',
      repairApplyVerify:
        'For repair apply --verify: { type: "repair-apply-verify", status, session, signal, action, changes, force, verification: { status: "verified" | "partial" | "unverified" | "skipped", coverage, scope: { tool, ruleId, files, checkRan, fallback }, commands, remainingFindings, trust? } }',
      sessionReplay:
        'For sessions show: { session: {id,tool,startedAt,completedAt,score,passed,...}, fidelity: "projection", envelope: SignalEnvelope, filtersApplied?, ...counts }',
      history:
        'For sessions list: { type: "history", sessions: HistorySession[] } where each has showCommand + optional summary.',
    },
    ...(input.projectContext && input.projectContext.targetConventions.length > 0
      ? { projectContext: input.projectContext }
      : {}),
    ...(input.reservedNames === undefined ? {} : { reservedNames: input.reservedNames }),
    ...(input.hostSupport === undefined ? {} : { hostSupport: input.hostSupport }),
    notes: [
      'Agent recipes (when present): fit agent-fast / agent-risk / agent-final; graph agent-risk / agent-final.',
      'Live runs support --filter/--top/--raw on fit/graph/sim --json (same engine as sessions show).',
      'graph impact answers changed→impacted without a separate git diff dance.',
      'Before editing, call MCP get_context_status with the same explicit project-relative files. Trust it only when status is available, fileScope.status is matched, manifest.readiness is ready, and every required plane is current, complete, uncapped, and has an available durable pointer; run opensip suite run agent-context with the same --files set and --json when any condition fails.',
      'impact_files and select_tests accept explicit project-relative files; ordinary MCP reads never build a graph, invoke Git, or execute tests.',
      'Use opensip audit --json for a fresh canonical review. --open is human-only and is suppressed by JSON/non-TTY/CI execution.',
      'Configured multi-tool workflows remain under opensip suite run <name>; they do not replace the canonical top-level audit.',
      'graph impact JSON includes trust.coverage/trust.fullyVerified/trust.uncertainties; do not claim targeted verification when fullyVerified is false.',
      'fit --changed --include-impacted falls back to the full target set when graph/git impact trust is partial or unknown.',
      'repair apply --verify and MCP repair_apply_verify are mutating. MCP repair_apply_verify is absent unless the server starts with --allow-mutations or OPENSIP_MCP_ALLOW_MUTATIONS=1.',
      'For repair results, partial/unverified/skipped verification means the agent must not claim the finding was fixed.',
      'Commands that expose machine-readable command results use --json. Raw-stream transports such as mcp document their own stdout protocol.',
      'filtersApplied, originalSignalCount, returnedSignalCount appear when --filter is used.',
      'The fidelity field on replays is always "projection" (rebuilt from persisted data).',
      'Trust-policy decisions are local and deterministic. Use policy status/explain/audit before changing policy exceptions.',
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
