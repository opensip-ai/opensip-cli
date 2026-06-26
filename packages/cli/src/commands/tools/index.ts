/**
 * tools — the customer-facing whole-tool management group (ADR-0041).
 *
 * Leaf {@link CommandSpec} builders for the `tools` subcommand group, mounted
 * by `host-subcommand-groups.ts` exactly as the `sessions`/`plugin` groups
 * are. Subcommands ONLY — no flag aliases, no `tool` singular (the parity
 * snapshot pins this). Later phases append leaves here
 * (validate/install/uninstall/data purge).
 */

import { EXIT_CODES, type CommandResult } from '@opensip-cli/contracts';
import {
  currentScope,
  defineCommand,
  type CommandSpec,
  type ProjectContext,
} from '@opensip-cli/core';

import { toolsCreate } from './create.js';
import { toolsDataPurge } from './data-purge.js';
import { toolsDoctor } from './doctor.js';
import { toolsInstall } from './install.js';
import { toolsList } from './list.js';
import { toolsUninstall } from './uninstall.js';
import { runToolValidation } from './validate.js';

import type { CliCommandsContext } from '../shared.js';
import type { DataStore } from '@opensip-cli/datastore';

type HostSpec = CommandSpec<unknown, CliCommandsContext>;
const COMMAND_RESULT_OUTPUT = 'command-result';

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

function buildToolsDoctorSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'doctor',
    description: 'Show every buffered bootstrap diagnostic for this run',
    commonFlags: ['json'],
    scope: 'none',
    output: COMMAND_RESULT_OUTPUT,
    handler: () => {
      const scope = currentScope();
      return Promise.resolve(toolsDoctor(scope?.bootstrapDiagnostics.list() ?? []));
    },
  });
}

function buildToolsListSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: 'List the effective tool set (bundled, global, and project-local)',
    commonFlags: ['json'],
    options: [
      {
        flag: '--global',
        description: 'Only user-global installed tools',
        default: false,
      },
      {
        flag: '--project',
        description: 'Only project-local installed tools',
        default: false,
      },
    ],
    // Listing must work outside a project too (global tools are still
    // visible); the project host dir simply scans empty there.
    scope: 'none',
    output: COMMAND_RESULT_OUTPUT,
    handler: (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts;
      // The admitted-tool set is per-run state on the entered RunScope (stamped
      // by the bootstrap), read here and passed into the pure `toolsList`.
      const scope = currentScope();
      return Promise.resolve(
        toolsList({
          cwd: effectiveCwd(opts),
          global: opts.global,
          project: opts.project,
          provenance: scope?.toolProvenance ?? [],
          manifests: scope?.toolManifests ?? [],
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
    args: [
      {
        name: 'spec',
        description: 'npm spec, tarball, or local directory path',
      },
    ],
    options: [
      {
        flag: '--install-deps',
        description: 'For a local path: stage via npm install so the runtime sections can load',
        default: false,
      },
    ],
    scope: 'none',
    output: COMMAND_RESULT_OUTPUT,
    handler: async (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts & {
        _args: string[];
        installDeps?: boolean;
      };
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

function buildToolsInstallSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'install',
    description: 'Validate, then install a tool package (global by default; see tools validate)',
    commonFlags: ['json'],
    args: [
      {
        name: 'spec',
        description: 'npm spec, tarball, or local directory path',
      },
    ],
    options: [
      {
        flag: '--global',
        description: 'Install user-global (the default)',
        default: false,
      },
      {
        flag: '--project',
        description: 'Install into this project’s runtime tool host instead',
        default: false,
      },
    ],
    scope: 'none',
    output: COMMAND_RESULT_OUTPUT,
    handler: async (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts & { _args: string[] };
      if (opts.global === true && opts.project === true) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return {
          type: 'tools-uninstall',
          target: opts._args[0] ?? '',
          success: false,
          error: '--global and --project are mutually exclusive',
        } satisfies CommandResult;
      }
      const result = await toolsInstall({
        spec: opts._args[0] ?? '',
        cwd: effectiveCwd(opts),
        project: opts.project,
      });
      if (!result.success) ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      return result;
    },
  });
}

function buildToolsUninstallSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'uninstall',
    description: 'Uninstall a tool by id or package name (never deletes project SQLite data)',
    commonFlags: ['json'],
    args: [{ name: 'name-or-id', description: 'Tool id or npm package name' }],
    options: [
      {
        flag: '--global',
        description: 'Target the user-global install',
        default: false,
      },
      {
        flag: '--project',
        description: 'Target the project-local install',
        default: false,
      },
      {
        flag: '--purge-data',
        description: 'Also purge the tool’s project SQLite rows (project scope only)',
        default: false,
      },
    ],
    scope: 'none',
    output: COMMAND_RESULT_OUTPUT,
    // eslint-disable-next-line @typescript-eslint/require-await -- async keeps the CommandSpec handler signature; the bodies are synchronous SQLite + fs
    handler: async (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts & {
        _args: string[];
        purgeData?: boolean;
      };
      // --purge-data is project-local only: runtime data lives per project
      // (the spec's explicit rejection for --global).
      if (opts.purgeData === true && opts.global === true) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return {
          type: 'tools-uninstall',
          target: opts._args[0] ?? '',
          success: false,
          error:
            '--purge-data is project-local only (runtime data lives per project); it cannot combine with --global',
        } satisfies CommandResult;
      }
      const result = toolsUninstall({
        target: opts._args[0] ?? '',
        cwd: effectiveCwd(opts),
        global: opts.global,
        project: opts.project,
        // Per-run admitted-tool provenance (bundled-id guard) from the scope.
        provenance: currentScope()?.toolProvenance ?? [],
      });
      if (!result.success) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return result;
      }
      if (opts.purgeData === true && result.removed?.scope === 'project') {
        const datastore = ctx.datastore() as DataStore | undefined;
        if (datastore !== undefined) {
          // Purge AFTER a successful project uninstall; counts ride stderr so
          // the uninstall result stays the command's one payload.
          const purge = toolsDataPurge(result.removed.id, datastore);
          process.stderr.write(
            `opensip: purged ${purge.sessions} session(s), ${purge.baselineEntries} baseline entr(ies), ` +
              `${purge.stateRows} state row(s) for '${purge.toolId}'\n`,
          );
        }
      }
      return result;
    },
  });
}

function buildToolsCreateSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'create',
    description: 'Scaffold a minimal project-local Tool under opensip-cli/tools/<id>/',
    commonFlags: ['json'],
    args: [
      {
        name: 'tool-id',
        description: 'Kebab-case tool id (also the subcommand name)',
      },
    ],
    options: [
      {
        flag: '--template',
        value: '<name>',
        description: 'Scaffold template (minimal-js or ts-local)',
        choices: ['minimal-js', 'ts-local'],
        default: 'minimal-js',
      },
      {
        flag: '--force',
        description: 'Overwrite scaffold files when the tool directory already exists',
        default: false,
      },
    ],
    scope: 'project',
    output: COMMAND_RESULT_OUTPUT,
    handler: (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts & {
        _args: string[];
        force?: boolean;
        template?: 'minimal-js' | 'ts-local';
      };
      const toolId = opts._args[0] ?? '';
      const result = toolsCreate({
        toolId,
        projectRoot: effectiveCwd(opts),
        force: opts.force,
        template: opts.template,
      });
      if (!result.success) ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      return Promise.resolve(result);
    },
  });
}

function buildToolsDataPurgeSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'data-purge',
    description:
      'Delete one tool’s project SQLite rows (sessions, baselines, state) — never tables',
    commonFlags: ['json'],
    args: [{ name: 'tool-id', description: 'The tool id whose rows to delete' }],
    scope: 'project',
    output: COMMAND_RESULT_OUTPUT,
    handler: (rawOpts) => {
      const opts = rawOpts as ScopeFilterOpts & { _args: string[] };
      const datastore = ctx.datastore() as DataStore | undefined;
      if (datastore === undefined) {
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return Promise.resolve({
          type: 'tools-uninstall',
          target: opts._args[0] ?? '',
          success: false,
          error: 'tools data-purge requires the project datastore (run inside a project)',
        } satisfies CommandResult);
      }
      return Promise.resolve(toolsDataPurge(opts._args[0] ?? '', datastore));
    },
  });
}

/** Build the `tools` group's leaf specs (consumed by the group mounter). */
export function buildToolsGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [
    buildToolsListSpec(),
    buildToolsDoctorSpec(),
    buildToolsCreateSpec(ctx),
    buildToolsValidateSpec(ctx),
    buildToolsInstallSpec(ctx),
    buildToolsUninstallSpec(ctx),
    buildToolsDataPurgeSpec(ctx),
  ];
}
