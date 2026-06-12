/**
 * tools — the customer-facing whole-tool management group (ADR-0041).
 *
 * Leaf {@link CommandSpec} builders for the `tools` subcommand group, mounted
 * by `host-subcommand-groups.ts` exactly as the `sessions`/`plugin` groups
 * are. Subcommands ONLY — no flag aliases, no `tool` singular (the parity
 * snapshot pins this). Later phases append leaves here
 * (validate/install/uninstall/data purge).
 */

import { defineCommand, type CommandSpec } from '@opensip-tools/core';

import { toolsList } from './list.js';

import type { CliCommandsContext } from '../shared.js';
import type { ProjectContext } from '@opensip-tools/core';

type HostSpec = CommandSpec<unknown, CliCommandsContext>;

interface ScopeFilterOpts {
  cwd?: string;
  projectContext?: ProjectContext;
  global?: boolean;
  project?: boolean;
}

/**
 * Prefer the discovered project root; fall back to literal cwd; finally
 * process.cwd(). (Local copy of the group module's `effectiveCwd` — importing
 * it from `host-subcommand-groups.ts` would close a module cycle, since that
 * module imports this group's leaves.)
 */
function effectiveCwd(opts: ScopeFilterOpts): string {
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
}

function buildToolsListSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: 'List the effective tool set (bundled, global, and project-local)',
    commonFlags: ['json'],
    options: [
      { flag: '--global', description: 'Only user-global installed tools', default: false },
      { flag: '--project', description: 'Only project-local installed tools', default: false },
    ],
    // Listing must work outside a project too (global tools are still
    // visible); the project host dir simply scans empty there.
    scope: 'none',
    output: 'command-result',
    handler: (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts;
      return Promise.resolve(
        toolsList({
          cwd: effectiveCwd(opts),
          global: opts.global,
          project: opts.project,
        }),
      );
    },
  });
}

/** Build the `tools` group's leaf specs (consumed by the group mounter). */
export function buildToolsGroupLeaves(_ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildToolsListSpec()];
}
