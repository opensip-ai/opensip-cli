/**
 * shared — the registrar context type used by every CLI-owned (host) command.
 *
 * Release 2.11.0 Phase 6 moved the host commands onto the declarative
 * `CommandSpec` plane (`host-command-specs.ts` / `host-subcommand-groups.ts`),
 * which sources `--cwd` / `--json` from the ADR-0021 common-flag registry
 * directly (via `commonFlags: ['cwd', 'json']`). The former
 * `CWD_OPTION_SPEC` / `JSON_DESC` re-export constants — used only by the
 * deleted `register-*.ts` registrars — are gone; this module now carries just
 * the shared context type.
 */

import type { SessionReplayRegistry } from '../session-replay-registry.js';
import type { CommandResult } from '@opensip-tools/contracts';
import type { PluginLayout } from '@opensip-tools/core';

/**
 * Context the orchestrator (`registerCliCommands`) hands to every
 * sub-registrar. The `setExitCode` write path mirrors `ToolCliContext`'s
 * — exit-code mutations route through here, never through direct
 * `process.exitCode` writes.
 */
export interface CliCommandsContext {
  readonly setExitCode: (code: number) => void;
  readonly render: (result: CommandResult) => Promise<void>;
  /**
   * Success machine-output seam — wraps the value in a `CommandOutcome` via the
   * single `renderOutcome` seam (2.12.0, §5.5). Always supplied by the host
   * (sourced from {@link ToolCliContext.emitJson}); required so raw-stream host
   * commands (`sessions show`) never fall back to a direct `process.stdout.write`.
   */
  readonly emitJson: (value: unknown) => void;
  /**
   * Structured-error machine-output seam (2.12.0, §5.5) — the host-command
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
  readonly sessionReplayRegistry?: SessionReplayRegistry;
  /**
   * v2 persistence accessor (thunk). Calling this returns the project-local
   * DataStore, opening it lazily on first access. Commands that don't read
   * the datastore (dry-runs, list-style commands, completion) never trigger
   * the SQLite open and therefore don't materialise `.runtime/`. Loosely
   * typed `unknown` to keep this module free of `@opensip-tools/datastore`
   * at the type level; consumers cast to `DataStore` at use time.
   *
   * Throws when called in a non-project context — CLI commands that need
   * the datastore should already have errored on `project.scope === 'none'`
   * before reaching this call.
   */
  readonly datastore: () => unknown;
}
