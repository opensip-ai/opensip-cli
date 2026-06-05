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
    `✗ This project's opensip-tools.config.yml uses a newer schema than your CLI supports.`,
    ``,
    `  Project:        ${input.root}`,
    `  Config schema:  v${input.configVersion}`,
    `  CLI supports:   v${input.cliVersion}`,
    ``,
    `  Update your CLI to continue:`,
    `    npm install -g opensip-tools@latest`,
    ``,
    `  (Or, if installed locally to the project: pnpm up opensip-tools@latest)`,
  ].join('\n');
}

/**
 * Render the "no opensip-tools project found" message. JSON output gets a
 * single-field error object; the human path gets the actionable
 * walked-up-to-root explainer with the `init` hint.
 */
export function formatNoProjectFoundMessage(cwd: string, jsonOutput: boolean): string {
  if (jsonOutput) {
    return JSON.stringify({
      error: 'No opensip-tools.config.yml found. Searched from ' + cwd + ' upward. To get started: opensip-tools init',
    });
  }
  return [
    '✗ No opensip-tools project found.',
    '',
    '  Searched from: ' + cwd,
    '  Walked up to: /',
    '',
    '  To get started:',
    '    opensip-tools init',
  ].join('\n');
}
