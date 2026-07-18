/**
 * shared — the registrar context type used by every CLI-owned (host) command.
 *
 * Launch Phase 6 moved the host commands onto the declarative
 * `CommandSpec` plane (`host-command-specs.ts` / `host-subcommand-groups.ts`),
 * which sources `--cwd` / `--json` from the ADR-0021 common-flag registry
 * directly (via `commonFlags: ['cwd', 'json']`). The former
 * `CWD_OPTION_SPEC` / `JSON_DESC` re-export constants — used only by the
 * deleted `register-*.ts` registrars — are gone; this module now carries just
 * the shared context type.
 */

import type { SpecLike } from './completion.js';
import type { RunActionHooks } from '../bootstrap/run-plane.js';
import type { SessionReplayRegistry } from '../session-replay-registry.js';
import type { CommandResult } from '@opensip-cli/contracts';
import type {
  PluginLayout,
  ScaffoldContext,
  ScaffoldFile,
  ToolPluginManifest,
  ToolProvenance,
  ToolRegistry,
  ToolCliContext,
} from '@opensip-cli/core';

/**
 * One registered tool's `init`-scaffold contribution (ADR-0038): its structural
 * `pluginLayout` (domain + userSubdirs the host `mkdir`s) plus the optional
 * tool-owned example/config hooks. Derived from the tool registry by the host; the
 * init command iterates these instead of hardcoding fit/sim.
 */
export interface ToolScaffold {
  /**
   * Durable identity captured from the admitted Tool descriptor. Init plans
   * record this triple so replay can prove which renderer set produced the
   * authored bytes without loading a newer Tool implementation.
   */
  readonly identity: ToolScaffoldIdentity;
  readonly layout: PluginLayout;
  readonly scaffoldExamples?: (ctx: ScaffoldContext) => readonly ScaffoldFile[];
  readonly stableExampleIds?: () => readonly string[];
  readonly scaffoldConfigBlock?: () => string;
}

/** Stable Tool identity recorded in an Init authored plan. */
export interface ToolScaffoldIdentity {
  readonly stableId: string;
  readonly name: string;
  readonly version: string;
}

/**
 * Immutable snapshot of one Tool's scaffold hooks for a single context.
 *
 * This is deliberately callback-free: callers may render a plan, classify
 * files, and serialize replay metadata from the same values without invoking a
 * Tool hook more than once.
 */
export interface RenderedToolScaffold {
  readonly identity: ToolScaffoldIdentity;
  readonly layout: PluginLayout;
  readonly examples: readonly ScaffoldFile[];
  readonly stableExampleIds: readonly string[];
  readonly configBlock?: string;
}

/**
 * Evaluate each Tool scaffold hook exactly once, retaining the supplied
 * registry order. Tool order is plan input: changing it intentionally changes
 * a fresh authored plan, so this function does not sort contributions.
 *
 * Duplicate stable ids or current names would make durable replay attribution
 * ambiguous. Reject them before invoking any Tool-owned callback.
 */
export function enumerateToolScaffolds(
  toolScaffolds: readonly ToolScaffold[],
  ctx: ScaffoldContext,
): readonly RenderedToolScaffold[] {
  assertUniqueToolScaffoldIdentities(toolScaffolds);

  return toolScaffolds.map((toolScaffold) => {
    const hookContext: ScaffoldContext = {
      languages: [...ctx.languages],
      ...(ctx.slugs === undefined ? {} : { slugs: [...ctx.slugs] }),
    };
    const examples = toolScaffold.scaffoldExamples?.(hookContext) ?? [];
    const stableExampleIds = toolScaffold.stableExampleIds?.() ?? [];
    const configBlock = toolScaffold.scaffoldConfigBlock?.();

    return {
      identity: { ...toolScaffold.identity },
      layout: {
        domain: toolScaffold.layout.domain,
        userSubdirs: [...toolScaffold.layout.userSubdirs],
      },
      examples: examples.map((example) => ({ ...example })),
      stableExampleIds: [...stableExampleIds],
      ...(configBlock === undefined ? {} : { configBlock }),
    };
  });
}

function assertUniqueToolScaffoldIdentities(toolScaffolds: readonly ToolScaffold[]): void {
  const stableIds = new Set<string>();
  const names = new Set<string>();
  for (const { identity } of toolScaffolds) {
    if (stableIds.has(identity.stableId)) {
      throw new Error(`Duplicate Tool scaffold stable id: ${identity.stableId}`);
    }
    if (names.has(identity.name)) {
      throw new Error(`Duplicate Tool scaffold name: ${identity.name}`);
    }
    stableIds.add(identity.stableId);
    names.add(identity.name);
  }
}

/**
 * Context the orchestrator (`registerCliCommands`) hands to every
 * sub-registrar. The `setExitCode` write path mirrors `ToolCliContext`'s
 * — exit-code mutations route through here, never through direct
 * `process.exitCode` writes.
 */
export interface CliCommandsContext {
  readonly setExitCode: (code: number) => void;
  readonly getExitCode?: () => number | undefined;
  readonly render: (result: CommandResult) => Promise<void>;
  /**
   * Typed-failure presentation seam — the host-command mirror of
   * {@link ToolCliContext.reportFailure}, sourced from the same context closure
   * in the composition root. A host command handler that throws a `ToolError`
   * is presented through here by the shared mount action (human render or
   * structured `--json` outcome), identically to a tool command. Optional only
   * for lean test contexts; the mount action falls back to `emitError`/`render`
   * so a typed failure is never silent.
   */
  readonly reportFailure?: ToolCliContext['reportFailure'];
  /**
   * Success machine-output seam — wraps the value in a `CommandOutcome` via the
   * single `renderOutcome` seam (launch, §5.5). Always supplied by the host
   * (sourced from {@link ToolCliContext.emitJson}); required so raw-stream host
   * commands (`sessions show`) never fall back to a direct `process.stdout.write`.
   */
  readonly emitJson: (value: unknown) => void;
  /**
   * RAW_STREAM machine-output seam — the host-command mirror of
   * {@link ToolCliContext.emitRaw}. Emits the bare, unwrapped payload for a host
   * command that declares `output:'raw-stream'` (`sessions show --raw`), so it
   * never falls back to a direct `process.stdout.write`; the actual write lives
   * in the single `renderRaw` seam.
   */
  readonly emitRaw: (value: unknown) => void;
  /**
   * Structured-error machine-output seam (launch, §5.5) — the host-command
   * mirror of {@link ToolCliContext.emitError}. A failed `--json` host command
   * (e.g. `sessions show`) emits its diagnosed failure through here so it rides
   * the single `renderOutcome` seam as a `status:'error'` `CommandOutcome`,
   * never a bare `emitJson({ error })`. Sourced from the same context closure as
   * the tool seam, so exit code and reported outcome stay in agreement.
   */
  readonly emitError: (detail: {
    readonly message: string;
    readonly exitCode: number;
    readonly suggestion?: string;
    readonly code?: string;
  }) => void;
  /**
   * Project-local plugin layouts contributed by the registered tools
   * (each tool's `Tool.pluginLayout`). The `plugin` command reads these
   * to know which domains support project-local plugins instead of
   * hardcoding `['fit', 'sim']` — the kernel stays tool-agnostic and the
   * tools remain the single source of truth (ADR-0009 corollary 1).
   */
  readonly pluginLayouts: readonly PluginLayout[];
  /**
   * Per-tool `init`-scaffold contributions (ADR-0038), derived from the tool
   * registry. The `init` command iterates these — each tool's `pluginLayout` +
   * `scaffoldExamples` — instead of hardcoding the fit/sim directories + example
   * content. A tool with no `pluginLayout` contributes nothing (e.g. `graph`).
   */
  readonly toolScaffolds: readonly ToolScaffold[];
  readonly sessionReplayRegistry?: SessionReplayRegistry;
  /**
   * The live tool command specs (each registered tool's `commandSpecs`),
   * supplied by the composition root. The `completion` command derives its
   * shell-completion subcommands + flags from these — the same source of truth
   * the runtime mounts — so the emitted script can never drift from the real
   * tool command surface. Typed structurally ({@link SpecLike}) to keep this
   * module free of the full `CommandSpec` generic. Optional so test harnesses
   * that don't exercise completion can omit it (completion then offers the host
   * surface only).
   */
  readonly toolCommandSpecs?: readonly SpecLike[];
  /**
   * Descriptor-driven names of the tools' `visibility: 'internal'` (Tier-3)
   * commands (tool-command-surface-taxonomy Task 1.3). The `completion` command
   * filters these from its inventory — the SAME source the `--help` hide pass
   * keys on — so completion and help never drift. Optional so test harnesses that
   * don't exercise completion can omit it (completion then falls back to the
   * static {@link INTERNAL_COMMANDS} set inside `assembleCompletionInventory`).
   */
  readonly toolInternalCommands?: ReadonlySet<string>;
  /** Live tool registry for identity-aware host commands (optional in tests). */
  readonly tools?: ToolRegistry;
  /** Full tool context for host commands that re-dispatch tool specs (suite run). */
  readonly toolContext?: ToolCliContext;
  /** Host run-lifecycle hooks paired with {@link toolContext} (suite run). */
  readonly toolRunActionHooks?: RunActionHooks;
  /** Admitted tool manifests for config declaration composition (optional in tests). */
  readonly manifests?: readonly ToolPluginManifest[];
  /** Per-run tool provenance for config declaration composition (optional in tests). */
  readonly provenance?: readonly ToolProvenance[];
  /**
   * Persistence accessor (thunk). Calling this returns the project-local
   * DataStore, opening it lazily on first access. Commands that don't read
   * the datastore (dry-runs, list-style commands, completion) never trigger
   * the SQLite open and therefore don't materialise `.runtime/`. Loosely
   * typed `unknown` to keep this module free of `@opensip-cli/datastore`
   * at the type level; consumers cast to `DataStore` at use time.
   *
   * Throws when called in a non-project context — CLI commands that need
   * the datastore should already have errored on `project.scope === 'none'`
   * before reaching this call.
   */
  readonly datastore: () => unknown;
}
