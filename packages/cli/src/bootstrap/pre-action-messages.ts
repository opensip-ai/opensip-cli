/**
 * pre-action-messages — pure message formatters for the bootstrap
 * `preAction` hook.
 *
 * Extracted from `pre-action-hook.ts` to keep that file focused on the
 * hook's control flow. Everything here is a pure string builder: no
 * logging, no process exit, no IO — given the same input it returns the
 * same text. The hook owns the side effects (writing these to stderr and
 * exiting); these functions only render.
 */

/** Inputs for {@link formatCliTooOldMessage}. */
export interface CliTooOldInput {
  readonly root: string;
  readonly configVersion: number;
  readonly cliVersion: number;
}

/**
 * Render the "your CLI is too old" message. Direction-correct: when the
 * config schema is newer than the CLI knows about, the USER UPGRADES
 * THE CLI — not "run migrate" (migrate goes the OTHER direction, taking
 * an old config UP to the current CLI's version).
 */
export function formatCliTooOldMessage(input: CliTooOldInput): string {
  return [
    `✗ This project's opensip-cli.config.yml uses a newer schema than your CLI supports.`,
    ``,
    `  Project:        ${input.root}`,
    `  Config schema:  v${input.configVersion}`,
    `  CLI supports:   v${input.cliVersion}`,
    ``,
    `  Update your CLI to continue:`,
    `    curl -fsSL https://opensip.ai/cli/install.sh | bash`,
    ``,
    `  (Or, if installed locally to the project: pnpm up opensip-cli@latest)`,
  ].join('\n');
}

/**
 * Render the human "no opensip-cli project found" explainer — the actionable
 * walked-up-to-root message with the `init` hint. The `--json` shape is no longer
 * rendered here: a no-project failure is a `BootstrapError` the top-level boundary
 * turns into a structured `bootstrap.error` `CommandOutcome` (release 2.12.0,
 * §4.7), so this formatter is the human path only.
 */
export function formatNoProjectFoundMessage(cwd: string): string {
  return [
    '✗ No OpenSIP CLI project found.',
    '',
    '  Searched from: ' + cwd,
    '  Walked up to: /',
    '',
    '  To get started:',
    '    opensip init',
  ].join('\n');
}
