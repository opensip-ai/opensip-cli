/**
 * @fileoverview Welcome message printed when `opensip` is invoked
 * with no subcommand and no flags.
 *
 * Design goal: a new user typing `opensip` sees the two primary
 * subcommands (fit / sim), a minimal quickstart, and a pointer at
 * `--help` for everything else. Progressive disclosure: the tool
 * decides what to show first rather than dumping the full help dump
 * produced by commander.
 *
 * Called only when `process.argv.length <= 2`. When the user passes
 * `--help` or `--version`, commander owns the output and this is
 * never invoked.
 *
 * Theme bypass — load-bearing
 * ---------------------------
 * This module emits raw ANSI escape sequences directly to
 * `process.stdout` rather than routing through Ink and `theme.ts`. The
 * bypass is INTENTIONAL and is the F6 promise's documented exception:
 *
 *   - The welcome screen is the very first thing a zero-arg invocation
 *     does. Loading Ink/React (~50 ms cold-start on a typical machine)
 *     to print twelve lines of static help would be a regression on
 *     `opensip` (no args) → welcome.
 *   - The render is fully static — no progress, no live updates, no
 *     theme-driven palette decisions. The only colour roles in use are
 *     bold, dim, and a single accent — all NO_COLOR / FORCE_COLOR
 *     aware via `colorsEnabled()`.
 *   - Theme drift risk is bounded: if a user customises `theme.ts`,
 *     they will see their accent everywhere EXCEPT the welcome
 *     screen. Acceptable — they typed nothing, so the screen is a
 *     handshake, not user-facing output. Audit 2026-05-23 G4 picked
 *     this option (b: tolerate the bypass, document it).
 *
 * If welcome ever grows dynamic content (recipe suggestions, recent-run
 * peek, etc.) it should move to an Ink renderer + a `WelcomeResult`;
 * delete this header at the same time.
 */

export interface WelcomeOptions {
  readonly version: string;
  readonly write?: (s: string) => void;
}

const ANSI_BOLD = '\u001B[1m';
const ANSI_DIM = '\u001B[2m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_RESET = '\u001B[0m';

/** True when stdout is a terminal and colors are safe to emit. */
function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function color(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${ANSI_RESET}` : text;
}

/**
 * Render the welcome message as a single string. Exported for testing.
 */
export function buildWelcome(opts: WelcomeOptions): string {
  const c = colorsEnabled();
  const bold = (s: string): string => color(c, ANSI_BOLD, s);
  const dim = (s: string): string => color(c, ANSI_DIM, s);
  const accent = (s: string): string => color(c, ANSI_CYAN, s);

  return [
    '',
    `${bold('OpenSIP CLI')} ${dim(opts.version)} — codebase analysis toolkit`,
    '',
    `${bold('Primary commands:')}`,
    `  ${accent('opensip fit')}        Run fitness checks against your codebase`,
    `  ${accent('opensip sim')}        Run simulation scenarios ${dim('(experimental)')}`,
    '',
    `${bold('Getting started:')}`,
    `  $ cd your-project`,
    `  $ opensip init       ${dim('# create a targets config')}`,
    `  $ opensip fit        ${dim('# run every registered check')}`,
    '',
    `${dim('Full reference: opensip --help')}`,
    `${dim('Docs:           https://github.com/opensip-ai/opensip-cli')}`,
    '',
  ].join('\n');
}

/**
 * Write the welcome message to stdout. Separate from `buildWelcome`
 * so tests can assert on the rendered string without capturing
 * process.stdout.
 */
export function printWelcome(opts: WelcomeOptions): void {
  const write = opts.write ?? ((s: string) => process.stdout.write(s));
  write(buildWelcome(opts));
}
