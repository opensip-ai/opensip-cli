/**
 * shared — Commander option specs + the registrar context type used by
 * every CLI-owned command.
 *
 * Split out of `commands/index.ts` (audit 2026-05-23 M2) so each
 * register-*.ts file can import the constants without re-stating them.
 * Keeping these in a single module also means adding a new shared flag
 * (e.g. a `--quiet` shorthand) is a one-line change.
 */

import type { CommandResult } from '@opensip-tools/contracts';

/** Commander spec for the shared `--cwd <path>` option. */
export const CWD_OPTION_SPEC = '--cwd <path>';

/** Help text for the shared `--json` flag — every CLI-owned subcommand uses this string verbatim. */
export const JSON_DESC = 'Output structured JSON';

/**
 * Context the orchestrator (`registerCliCommands`) hands to every
 * sub-registrar. The `setExitCode` write path mirrors `ToolCliContext`'s
 * — exit-code mutations route through here, never through direct
 * `process.exitCode` writes.
 */
export interface CliCommandsContext {
  readonly setExitCode: (code: number) => void;
  readonly render: (result: CommandResult) => Promise<void>;
}
