/**
 * tools — the customer-facing whole-tool management group (ADR-0041).
 *
 * Leaf {@link CommandSpec} builders for the `tools` subcommand group, mounted
 * by `host-subcommand-groups.ts` exactly as the `sessions`/`plugin` groups
 * are. Subcommands ONLY — no flag aliases, no `tool` singular (the parity
 * snapshot pins this). Later phases append leaves here
 * (validate/install/uninstall/data purge).
 */

import { EXIT_CODES } from '@opensip-tools/contracts';
import { defineCommand, type CommandSpec } from '@opensip-tools/core';

import { toolsList } from './list.js';
import { runToolValidation } from './validate.js';

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

function buildToolsValidateSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'validate',
    description:
      'Validate a tool package against the Tool contract (runs the package module — see docs)',
    commonFlags: ['json'],
    args: [{ name: 'spec', description: 'npm spec, tarball, or local directory path' }],
    options: [
      {
        flag: '--install-deps',
        description: 'For a local path: stage via npm install so the runtime sections can load',
        default: false,
      },
    ],
    scope: 'none',
    output: 'command-result',
    handler: async (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts & { _args: string[]; installDeps?: boolean };
      const spec = opts._args[0] ?? '';
      const { result } = await runToolValidation({
        spec,
        cwd: effectiveCwd(opts),
        installDeps: opts.installDeps,
      });
      if (result.verdict !== 'passed') ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      return result;
    },
  });
}

/** Build the `tools` group's leaf specs (consumed by the group mounter). */
export function buildToolsGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [buildToolsListSpec(), buildToolsValidateSpec(ctx)];
}
