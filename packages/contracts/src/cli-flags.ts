/**
 * Cross-tool CLI flag currency (ADR-0021).
 *
 * The single source of truth for the common flags every tool's run command
 * shares (`--json`, `--cwd`, `--quiet`, `--verbose`, `--debug`,
 * `--report-to`/`--api-key`, `--open`). Each tool builds its command with
 * `applyCommonFlags(...)` for the shared flags and adds only its
 * genuinely tool-specific options by hand — so a flag's text/short-alias/default
 * is declared once and cannot drift (it already had: `--report-to` read three
 * different ways across the three tools before this registry).
 *
 * `commander` is referenced ONLY as a type (`import type`), matching the rest of
 * contracts: `applyCommonFlags` calls `.option(...)` on a `Command` instance the
 * caller passes in, so no runtime `commander` require lands in `dist`. The
 * package keeps `commander` as an optional peer dependency (see index.ts).
 */

import type { Command } from 'commander';

/** The common flags shared across tool run commands. */
export type CommonFlagKey =
  | 'json'
  | 'cwd'
  | 'quiet'
  | 'verbose'
  | 'debug'
  | 'reportTo'
  | 'apiKey'
  | 'open';

/** Canonical declaration of one common flag. */
export interface CommonFlagSpec {
  /** Commander flag string, including the short alias where canonical (`-v, --verbose`). */
  readonly flags: string;
  /** Canonical description — the one source of truth for this flag's help text. */
  readonly description: string;
  /**
   * Literal default applied via `.option(flags, description, default)`. Omitted
   * for value flags whose default is computed per-invocation (e.g. `cwd`'s
   * `process.cwd()`), which callers supply through `applyCommonFlags`'s
   * `overrides` argument.
   */
  readonly defaultValue?: string | boolean;
}

/**
 * The canonical common-flag registry. Adding a tool means calling
 * {@link applyCommonFlags} with the relevant keys — never re-declaring a flag.
 */
export const commonFlags: Readonly<Record<CommonFlagKey, CommonFlagSpec>> = {
  json: { flags: '--json', description: 'Output structured JSON', defaultValue: false },
  cwd: { flags: '--cwd <path>', description: 'Target directory' },
  quiet: {
    flags: '-q, --quiet',
    description: 'Suppress banner / boxes; print only the pass-fail summary',
    defaultValue: false,
  },
  verbose: {
    flags: '-v, --verbose',
    description: 'Show the detailed report body inline',
    defaultValue: false,
  },
  debug: {
    flags: '--debug',
    description: 'Enable debug mode for structured log output',
    defaultValue: false,
  },
  reportTo: {
    flags: '--report-to <url>',
    description: 'POST findings to OpenSIP Cloud or a compatible endpoint',
  },
  apiKey: { flags: '--api-key <key>', description: 'API key for --report-to authentication' },
  open: {
    flags: '--open',
    description: 'Launch the HTML dashboard in your browser after the run completes',
    defaultValue: false,
  },
} as const;

/**
 * Apply the given common flags to a Commander command in registry order.
 *
 * `overrides` supplies per-invocation defaults for flags whose default is not a
 * literal — notably `cwd`, where callers pass `{ cwd: process.cwd() }`. An
 * override also wins over a spec's `defaultValue` when both are present.
 *
 * Returns the same `command` for chaining. No runtime `commander` dependency is
 * introduced — only methods on the passed-in instance are called.
 */
export function applyCommonFlags(
  command: Command,
  keys: readonly CommonFlagKey[],
  overrides?: Partial<Record<CommonFlagKey, string | boolean>>,
): Command {
  for (const key of keys) {
    const spec = commonFlags[key];
    const def = overrides?.[key] ?? spec.defaultValue;
    if (def === undefined) command.option(spec.flags, spec.description);
    else command.option(spec.flags, spec.description, def);
  }
  return command;
}

/**
 * The flags every tool's run command MUST declare (the parity set enforced by
 * the `cross-tool-flag-parity` fitness check, ADR-0021). `open` is intentionally
 * NOT mandatory — only dashboard-producing tools expose it.
 */
export const MANDATORY_COMMON_FLAGS: readonly CommonFlagKey[] = [
  'json',
  'cwd',
  'quiet',
  'verbose',
  'debug',
  'reportTo',
  'apiKey',
] as const;
