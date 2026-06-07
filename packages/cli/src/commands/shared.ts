/**
 * shared — Commander option specs + the registrar context type used by
 * every CLI-owned command.
 *
 * Split out of `commands/index.ts` (audit 2026-05-23 M2) so each
 * register-*.ts file can import the constants without re-stating them.
 * Keeping these in a single module also means adding a new shared flag
 * (e.g. a `--quiet` shorthand) is a one-line change.
 */

import { commonFlags } from '@opensip-tools/contracts';

import type { CommandResult } from '@opensip-tools/contracts';
import type { PluginLayout } from '@opensip-tools/core';

/** Commander spec for the shared `--cwd <path>` option — sourced from the
 *  ADR-0021 common-flag registry so CLI-owned commands match the tools. */
export const CWD_OPTION_SPEC = commonFlags.cwd.flags;

/** Help text for the shared `--json` flag — the one registry string, used by
 *  every CLI-owned subcommand. */
export const JSON_DESC = commonFlags.json.description;

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
   * Project-local plugin layouts contributed by the registered tools
   * (each tool's `Tool.pluginLayout`). The `plugin` command reads these
   * to know which domains support project-local plugins instead of
   * hardcoding `['fit', 'sim']` — the kernel stays tool-agnostic and the
   * tools remain the single source of truth (ADR-0009 corollary 1).
   */
  readonly pluginLayouts: readonly PluginLayout[];
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
