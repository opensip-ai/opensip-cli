/**
 * no-init-eligibility — narrow command allowlist for ephemeral first-run mode.
 */

import type { ProjectContext } from '@opensip-cli/core';

const NO_INIT_COMMAND_PATHS = new Set(['fitness', 'fit', 'graph', 'graph impact', 'suite run']);

export function isNoInitEligibleCommand(commandPath: string): boolean {
  return NO_INIT_COMMAND_PATHS.has(commandPath);
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
