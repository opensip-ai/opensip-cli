/**
 * decorate-tool-primary — the host-owned decorator the mount layer applies to
 * EVERY tool's PRIMARY command (the flat, no-`parent` spec whose name matches
 * `tool.metadata.name`: `fit`, `graph`, `sim`, and any third-party tool's run
 * verb).
 *
 * The decorator is the single place the host GUARANTEES a uniform primary-command
 * surface, so a tool need not opt in per spec:
 *
 *  1. `--version` — prints the TOOL's own version (`<name> <version>`, plus a
 *     `(tool contract v<n>)` marker when the Tool declares `contractVersion`).
 *     This is distinct from `opensip --version` (the CLI version, owned at the
 *     composition root). Implemented via Commander's `.version()` on the primary
 *     command — the root no longer registers a Commander version option (it is
 *     handled by a host argv pre-scan), so the subcommand-local `--version` no
 *     longer collides with an inherited global one.
 *  2. The baseline common flags `--cwd` / `--json` / `--config` are present on
 *     every primary regardless of what the tool declared in `commonFlags`.
 *  3. `--quiet` / `--verbose` are present on every primary.
 *
 * The decorator is IDEMPOTENT: a flag the tool already declared (via its
 * `commonFlags` or a hand-rolled `OptionSpec` — e.g. fit already ships `--config`,
 * and all three primaries already opt into `--cwd`/`--json`/`--quiet`/`--verbose`)
 * is left untouched, so Commander never sees a duplicate-option registration. The
 * decorator only ADDS what is missing (in practice `--config` for graph/sim).
 *
 * This lives in the mount path (called from `mountOneTool`) rather than being
 * re-declared per tool — there is no per-tool special case here; the same
 * decoration runs for bundled and discovered tools alike.
 */

import {
  applyCommonFlags,
  commonFlags,
  type CliProgram,
  type CommonFlagKey,
} from '@opensip-cli/contracts';
import { type Tool } from '@opensip-cli/core';

import { CONFIG_FLAG } from '../commands/host-config-flag.js';

/**
 * The host-guaranteed baseline COMMON flags on every tool primary (ADR-0021
 * registry keys). `cwd` / `json` are the always-on machine-output + targeting
 * pair; `quiet` / `verbose` are the uniform verbosity pair. `--config` is added
 * separately (it is a host flag, not an ADR-0021 registry entry).
 */
const GUARANTEED_COMMON_FLAG_KEYS = ['cwd', 'json', 'quiet', 'verbose'] as const;

/**
 * Each guaranteed common flag paired with its registry `--long` form, resolved
 * ONCE at module load. Precomputing keeps the per-decoration filter a plain
 * `.long` read (no `commonFlags[key]` index access in the hot path).
 */
const GUARANTEED_COMMON_FLAGS: readonly { readonly key: CommonFlagKey; readonly long: string }[] =
  GUARANTEED_COMMON_FLAG_KEYS.map((key) => {
    // Destructure the registry value into a local before reading `.flags` — the
    // key is a static `CommonFlagKey`, so the registry entry is always present.
    const { flags } = commonFlags[key];
    return { key, long: longFlagOf(flags) };
  });

/**
 * Read the set of long-flag strings (`--foo`) a Commander command already has, so
 * the decorator can add only what is missing and never double-register a flag.
 */
function existingLongFlags(cmd: CliProgram): ReadonlySet<string> {
  const longs = new Set<string>();
  for (const option of cmd.options) {
    if (option.long !== undefined && option.long !== null) longs.add(option.long);
  }
  return longs;
}

/**
 * Build the tool's `--version` payload: `<name> <version>`, with a
 * `(tool contract v<n>)` suffix only when the Tool declares `contractVersion`
 * (none of the bundled tools do today — they version their tool-specific surface
 * via `extensionPoints` — so the suffix is reserved for tools that opt in).
 */
export function toolVersionString(tool: Tool): string {
  const base = `${tool.metadata.name} ${tool.metadata.version}`;
  return tool.contractVersion === undefined
    ? base
    : `${base} (tool contract v${tool.contractVersion})`;
}

/**
 * Decorate a tool's PRIMARY command with the host-guaranteed uniform surface
 * (see the module header). Idempotent w.r.t. flags the tool already declared.
 *
 * @param primaryCmd The mounted Commander command for the tool's primary spec
 *   (the flat spec whose name === `tool.metadata.name`).
 * @param tool       The tool being mounted — read for `metadata.version` /
 *   `metadata.name` / `contractVersion`.
 */
export function decorateToolPrimary(primaryCmd: CliProgram, tool: Tool): void {
  const present = existingLongFlags(primaryCmd);

  // (1) Per-tool --version. The root no longer owns a Commander version option,
  // so this subcommand-local --version is the one Commander resolves for
  // `opensip <tool> --version`. Skip if the tool already declared a `--version`
  // (defense in depth — no first-party tool does).
  if (!present.has('--version')) {
    primaryCmd.version(toolVersionString(tool), '--version', "Print this tool's version");
  }

  // (2) Guaranteed baseline common flags (--cwd/--json/--quiet/--verbose), added
  // only when missing. `cwd` seeds process.cwd() to match the mounter's default.
  const missingCommon = GUARANTEED_COMMON_FLAGS.filter((f) => !present.has(f.long)).map(
    (f) => f.key,
  );
  if (missingCommon.length > 0) {
    const seedsCwd = missingCommon.includes('cwd');
    applyCommonFlags(primaryCmd, missingCommon, seedsCwd ? { cwd: process.cwd() } : undefined);
  }

  // (3) Guaranteed --config (host flag read by the pre-action hook as
  // `opts.config`), added only when missing — fit already declares it.
  if (!present.has('--config')) {
    primaryCmd.option(CONFIG_FLAG.flags, CONFIG_FLAG.description);
  }
}

/** Extract the `--long` form from a Commander flag string (`-q, --quiet` → `--quiet`). */
function longFlagOf(flags: string): string {
  const match = /--[a-z][a-z-]*/.exec(flags);
  return match ? match[0] : flags;
}
