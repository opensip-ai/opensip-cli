/**
 * Format the "Project: <abs path>" header rendered before every
 * project-scoped, human-readable command. Pure string formatter — no
 * Ink/React, so the imperative pre-action-hook can write the result
 * directly to stdout without paying React's render cost.
 *
 * Suppression policy (enforced by the caller, not here): do not call
 * for `--json`, `completion`, `--help`, `--version`, user-scoped
 * commands, or commands that mount their own RunHeader inside an Ink
 * view (fit/sim/graph/dashboard — RunHeader renders the project line
 * in those flows, see run-header.tsx).
 */

export interface ProjectHeaderInput {
  /** Absolute path to the project root. */
  readonly root: string;
  /** Ancestor steps walked from cwd to root. 0 == cwd is the root. */
  readonly walkedUp: number;
}

/**
 * Render the header line. Includes a trailing newline so callers can
 * `process.stdout.write` without thinking about line termination.
 *
 *   walkedUp 0  → `ℹ Project: <root>`
 *   walkedUp 1  → `ℹ Project: <root>  (found 1 level up)`
 *   walkedUp N  → `ℹ Project: <root>  (found N levels up)`
 */
export function formatProjectHeader(input: ProjectHeaderInput): string {
  const base = `ℹ Project: ${input.root}`;
  if (input.walkedUp === 0) return `${base}\n`;
  const noun = input.walkedUp === 1 ? 'level' : 'levels';
  return `${base}  (found ${input.walkedUp} ${noun} up)\n`;
}
