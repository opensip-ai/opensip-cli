/**
 * no-init-eligibility — may this command run outside an initialized project?
 *
 * The answer is DERIVED from the mounted CommandSpecs (`CommandSpec.noInit`,
 * indexed by `buildCommandScopeIndex`), never from a list maintained here. The
 * previous implementation was a hardcoded `Set` of command paths that omitted
 * `audit` — the canonical first-run command — so `opensip audit` hard-failed
 * with "No OpenSIP CLI project found" on exactly the zero-config first run the
 * docs, the installer, and the quick start all promise. A parallel allowlist
 * cannot be kept in sync with the command surface by discipline; deriving it
 * from the specs makes that class of drift unrepresentable.
 */

import type { CommandScopeIndex } from '../commands/command-scope-index.js';
import type { ProjectContext } from '@opensip-cli/core';

export function isNoInitEligibleCommand(
  commandPath: string,
  commandScopes: CommandScopeIndex,
): boolean {
  return commandScopes.get(commandPath)?.noInit === true;
}

export function shouldRenderNoInitAdoptionHint(args: {
  readonly project: ProjectContext;
  readonly opts: Readonly<Record<string, unknown>>;
}): boolean {
  if (args.project.scope !== 'ephemeral') return false;
  if (args.opts.json === true) return false;
  if (args.opts.help === true) return false;
  const sarif = args.opts.sarif;
  if (typeof sarif === 'string' && sarif.length > 0) return false;
  return true;
}
