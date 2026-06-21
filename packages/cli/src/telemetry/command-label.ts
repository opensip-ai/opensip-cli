/**
 * Resolved top-level command name for the command-duration metric label (M12).
 *
 * Set by the pre-action hook once Commander has MATCHED the command, read by the
 * duration histogram at process end. This bounds metric cardinality to the
 * registered command set + `'unknown'` — vs the raw `process.argv[2]`, where a
 * typo, a flag (`--help`), or a file path would each become a distinct label
 * value and blow the time-series cardinality up.
 */

let resolvedCommand: string | undefined;

/** Record the matched command name (called from the pre-action hook). */
export function setResolvedCommandLabel(name: string): void {
  resolvedCommand = name;
}

/**
 * The matched command name, or `'unknown'` when no command resolved — a bare
 * invocation, `--help`/`--version`, or an error before Commander matched.
 */
export function resolvedCommandLabel(): string {
  return resolvedCommand ?? 'unknown';
}

/** Test-only reset of the module-level label. */
export function resetResolvedCommandLabel(): void {
  resolvedCommand = undefined;
}
