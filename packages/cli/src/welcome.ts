/**
 * @fileoverview Welcome message printed when `opensip-tools` is invoked
 * with no subcommand and no flags.
 *
 * Design goal: a new user typing `opensip-tools` sees the two primary
 * subcommands (fit / sim), a minimal quickstart, and a pointer at
 * `--help` for everything else. Progressive disclosure: the tool
 * decides what to show first rather than dumping the full help dump
 * produced by commander.
 *
 * Called only when `process.argv.length <= 2`. When the user passes
 * `--help` or `--version`, commander owns the output and this is
 * never invoked.
 */

export interface WelcomeOptions {
  readonly version: string
  readonly write?: (s: string) => void
}

const ANSI_BOLD = '\u001B[1m'
const ANSI_DIM = '\u001B[2m'
const ANSI_CYAN = '\u001B[36m'
const ANSI_RESET = '\u001B[0m'

/** True when stdout is a terminal and colors are safe to emit. */
function colorsEnabled(): boolean {
  if (process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

function color(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${ANSI_RESET}` : text
}

/**
 * Render the welcome message as a single string. Exported for testing.
 */
export function buildWelcome(opts: WelcomeOptions): string {
  const c = colorsEnabled()
  const bold = (s: string): string => color(c, ANSI_BOLD, s)
  const dim = (s: string): string => color(c, ANSI_DIM, s)
  const accent = (s: string): string => color(c, ANSI_CYAN, s)

  return [
    '',
    `${bold('opensip-tools')} ${dim(opts.version)} — codebase analysis toolkit`,
    '',
    `${bold('Primary commands:')}`,
    `  ${accent('opensip-tools fit')}        Run fitness checks against your codebase`,
    `  ${accent('opensip-tools sim')}        Run simulation scenarios ${dim('(experimental)')}`,
    '',
    `${bold('Getting started:')}`,
    `  $ cd your-project`,
    `  $ opensip-tools init       ${dim('# create a targets config')}`,
    `  $ opensip-tools fit        ${dim('# run every registered check')}`,
    '',
    `${bold('Type it a lot?')} Drop this in your ${accent('~/.zshrc')} or ${accent('~/.bashrc')}:`,
    `  ${dim('alias')} ${accent('ost')}${dim('=')}${accent("'opensip-tools'")}`,
    '',
    `${dim('Full reference: opensip-tools --help')}`,
    `${dim('Docs:           https://github.com/opensip-ai/opensip-tools')}`,
    '',
  ].join('\n')
}

/**
 * Write the welcome message to stdout. Separate from `buildWelcome`
 * so tests can assert on the rendered string without capturing
 * process.stdout.
 */
export function printWelcome(opts: WelcomeOptions): void {
  const write = opts.write ?? ((s: string) => process.stdout.write(s))
  write(buildWelcome(opts))
}
