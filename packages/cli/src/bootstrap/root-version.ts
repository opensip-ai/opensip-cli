/**
 * root-version — host-owned detection of the bare `opensip --version` request.
 *
 * The root program deliberately carries NO Commander `.version()` option: a root
 * version option is GLOBAL and would intercept `--version` even after a known
 * subcommand, so `opensip fit --version` would print the CLI version instead of
 * the tool's. The per-tool `--version` is a subcommand-local Commander version
 * option (`decorateToolPrimary`); the bare CLI form is detected here, before
 * Commander parses, so the two never collide.
 *
 * Kept in its own module (rather than inline in the composition root) so it is
 * unit-testable without importing `index.ts` — whose top-level `await main()`
 * side-effect would run the whole CLI on import.
 */

/**
 * Is this argv a BARE `opensip --version` / `-V` (the CLI version), as opposed to
 * a tool primary's own `opensip <tool> --version`?
 *
 * The bare form has `--version` / `-V` with NO subcommand (positional) token
 * before it. A `--version` that follows a subcommand belongs to that subcommand
 * and is left for Commander (and `decorateToolPrimary`).
 *
 * @param argv `process.argv.slice(2)` — the user-supplied args after the binary.
 */
export function isRootVersionRequest(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--version' || token === '-V') return true;
    // The first non-flag token is the subcommand verb — any `--version` after it
    // is the subcommand's, not the root's.
    if (!token.startsWith('-')) return false;
  }
  return false;
}
