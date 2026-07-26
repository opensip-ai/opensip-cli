/**
 * Independent top-level host command leaves.
 *
 * `host-command-specs.ts` remains the composition inventory and keeps the
 * statically declared bridge functions named in each descriptor. This module
 * owns the leaf-specific option parsing and handlers so that composition stays
 * readable and bounded.
 */

import { ConfigurationError, type ProjectContext } from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';
import { composeAndWriteReport } from '../report-compose.js';

import { executeAgentCatalog } from './agent-catalog.js';
import { executeConfigure } from './configure.js';
import { defineHostCommand as defineCommand } from './host-runtime-access.js';
import { executeRuntimeStatus } from './runtime-status.js';
import { executeUninstall } from './uninstall.js';

import type { HostRuntimeCommandSpec } from './host-runtime-access.js';
import type { CliCommandsContext } from './shared.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const OPTION_INVALID = hostErrorCatalog.require('CLI.HOST.OPTION_INVALID');

type HostSpec = HostRuntimeCommandSpec<unknown, CliCommandsContext>;

const COMMAND_RESULT = 'command-result' as const;
const HOST_COMMAND_PACKAGE = 'opensip-cli';
const HOST_COMMAND_SPECS_PATH = 'packages/cli/src/commands/host-command-specs.ts';

interface StatusOpts {
  readonly cwd?: string;
  readonly cwdExplicit?: boolean;
  readonly config?: string;
  readonly projectContext?: ProjectContext;
}

interface UninstallOpts {
  readonly yes?: boolean;
  readonly dryRun?: boolean;
  readonly user?: boolean;
  readonly project?: string | boolean;
  readonly purge?: boolean;
  readonly discardRecovery?: boolean;
  readonly json?: boolean;
  readonly projectContext?: ProjectContext;
}

/** Build the user-level Cloud configuration command. */
export function createConfigureCommandSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>(
    {
      staticHandler: {
        package: HOST_COMMAND_PACKAGE,
        path: HOST_COMMAND_SPECS_PATH,
        declaration: 'buildConfigureSpec',
      },
      name: 'configure',
      description: 'Set up OpenSIP Cloud API key',
      commonFlags: ['json', 'debug'],
      scope: 'none',
      output: COMMAND_RESULT,
      handler: () => executeConfigure(),
    },
    // Writes under the user root (~/.opensip-cli); acquire user-state for the
    // full prompt/read/write/verification lifetime so global uninstall cannot
    // interleave.
    { runtimeAccess: 'user-state' },
  );
}

/** Build the no-init runtime-status inspection command. */
export function createStatusCommandSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>(
    {
      staticHandler: {
        package: HOST_COMMAND_PACKAGE,
        path: HOST_COMMAND_SPECS_PATH,
        declaration: 'buildStatusSpec',
      },
      name: 'status',
      description: "Show where this project's OpenSIP evidence is stored",
      commonFlags: ['cwd', 'json', 'debug'],
      scope: 'none',
      noInit: true,
      output: COMMAND_RESULT,
      handler: (rawOpts) => {
        const opts = rawOpts as StatusOpts;
        return executeRuntimeStatus({
          cwd: opts.cwd ?? process.cwd(),
          cwdExplicit: opts.cwdExplicit === true,
          ...(opts.config === undefined ? {} : { explicitConfigPath: opts.config }),
          projectContext: opts.projectContext,
        });
      },
    },
    { bootstrapMode: 'inspection-only' },
  );
}

/**
 * Convert the optional report catalog budget from megabytes to bytes.
 *
 * @throws {ConfigurationError} When the value is not a positive number.
 */
function parseMaxCatalogMb(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new ConfigurationError(
      `report: --max-catalog-mb must be a positive number of megabytes (got '${raw}').`,
      {
        code: OPTION_INVALID.code,
        definition: OPTION_INVALID,
        metadata: { condition: 'catalog-budget' },
      },
    );
  }
  const bytes = Math.floor(mb * 1024 * 1024);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new ConfigurationError(
      `report: --max-catalog-mb must be a positive number of megabytes (got '${raw}').`,
      {
        code: OPTION_INVALID.code,
        definition: OPTION_INVALID,
        metadata: { condition: 'catalog-budget' },
      },
    );
  }
  return bytes;
}

/** Build the CLI-owned cross-tool report command. */
export function createReportCommandSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: HOST_COMMAND_PACKAGE,
      path: HOST_COMMAND_SPECS_PATH,
      declaration: 'buildReportSpec',
    },
    name: 'report',
    description: 'Generate the cross-tool HTML report and open it in your browser',
    // First-run capable: `audit --open` and `report` must work on a pre-init
    // run. The HTML lands in the ephemeral runtime's reports dir, not the repo.
    noInit: true,
    // `--cwd` is required by platform-acceptance continuity journeys (and by
    // any agent that generates a report for a project other than process.cwd).
    commonFlags: ['json', 'cwd'],
    options: [
      {
        flag: '--no-open',
        description: 'Write the report but do not launch a browser',
        negatable: true,
      },
      {
        flag: '--run',
        value: '<run-id>',
        description:
          'Select an exact retained parent Run for the Change Impact view (works outside recent history)',
      },
      {
        flag: '--max-catalog-mb',
        value: '<mb>',
        description:
          'Raise the inlined graph-catalog budget (default 8 MB). Use when exploring a large repo locally; a bigger report is slower to open and may be too large to share.',
      },
    ],
    scope: 'project',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as {
        open: boolean;
        json: boolean;
        run?: string;
        maxCatalogMb?: string;
      };
      // Commander stores `--no-open` as `opts.open === false`; default true.
      // In `--json` mode we never launch a browser (machine-output contract).
      // ADR-0054 M4-F: composeAndWriteReport runs an EXTERNAL tool's
      // collectReportData in a forked hook worker (its runtime never runs in-host).
      const maxGraphCatalogBytes = parseMaxCatalogMb(opts.maxCatalogMb);
      const selection =
        opts.run === undefined ? undefined : ({ view: 'change-impact', runId: opts.run } as const);
      return composeAndWriteReport({
        open: opts.open === true && opts.json !== true,
        ...(selection === undefined ? {} : { selection }),
        ...(maxGraphCatalogBytes === undefined ? {} : { maxGraphCatalogBytes }),
      });
    },
  });
}

function uninstallChunkLines(chunk: string): readonly string[] {
  const lines = chunk.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function createUninstallPresentation(ctx: CliCommandsContext, json: boolean) {
  let renderQueue = Promise.resolve();
  const write = (chunk: string): void => {
    if (json) return;
    const lines = uninstallChunkLines(chunk);
    if (lines.length === 0) return;
    renderQueue = renderQueue.then(() => ctx.render({ type: 'text-lines', lines }));
  };
  const flush = (): Promise<void> => renderQueue;
  const prompt = async (question: string): Promise<string> => {
    const [{ createInterface }] = await Promise.all([import('node:readline/promises'), flush()]);
    // eslint-disable-next-line no-restricted-properties -- readline owns this interactive prompt transport after host-rendered output has flushed.
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await readline.question(question);
    } finally {
      readline.close();
    }
  };
  return { write, flush, prompt };
}

/** Build the user/project state removal command. */
export function createUninstallCommandSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: HOST_COMMAND_PACKAGE,
      path: HOST_COMMAND_SPECS_PATH,
      declaration: 'buildUninstallSpec',
    },
    name: 'uninstall',
    description:
      'Remove user-level OpenSIP state at ~/.opensip-cli/ (config, cache, plugins). Use --project for project-local state.',
    commonFlags: [],
    options: [
      {
        flag: '-y, --yes',
        description: 'Skip confirmation prompt',
        default: false,
      },
      {
        flag: '--dry-run',
        description: 'Print what would be removed; take no action',
        default: false,
      },
      {
        flag: '--user',
        description: 'Remove user-level state at ~/.opensip-cli/ (default mode; crash-recoverable)',
        default: false,
      },
      {
        flag: '--project',
        value: '[path]',
        description:
          'Remove project-local runtime state at [path] (defaults to cwd). User content + config preserved unless --purge.',
      },
      {
        flag: '--purge',
        description:
          'With --project, also remove user-authored content and opensip-cli.config.yml (DESTRUCTIVE)',
        default: false,
      },
      {
        flag: '--discard-recovery',
        description:
          'Break-glass: with --project --purge discard a stuck promotion journal; with --user unlink only a malformed fixed user-uninstall receipt',
        default: false,
      },
      { flag: '--json', description: 'Output structured JSON', default: false },
    ],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: async (rawOpts) => {
      const opts = rawOpts as UninstallOpts;
      if (opts.user === true && opts.project !== undefined) {
        throw new ConfigurationError('uninstall: --user and --project are mutually exclusive.');
      }
      // Commander passes `true` when the flag is present without a value, a
      // string when given a value, or undefined when omitted.
      let project: string | true | undefined;
      if (opts.project === true) project = true;
      else if (typeof opts.project === 'string') project = opts.project;
      const presentation = createUninstallPresentation(ctx, opts.json === true);
      const result = await executeUninstall({
        yes: opts.yes,
        dryRun: opts.dryRun,
        project,
        purge: opts.purge,
        discardRecovery: opts.discardRecovery,
        projectContext: opts.projectContext,
        write: presentation.write,
        prompt: presentation.prompt,
      });
      await presentation.flush();
      return result;
    },
  });
}

/** Build the machine-oriented host command inventory. */
export function createAgentCatalogCommandSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: HOST_COMMAND_PACKAGE,
      path: HOST_COMMAND_SPECS_PATH,
      declaration: 'buildAgentCatalogSpec',
    },
    name: 'agent-catalog',
    description:
      'Structured catalog of agent-friendly commands, patterns, and output shapes (JSON preferred). ' +
      'Primary surface for AI agents to bootstrap usage of sessions, filtering, and historical results.',
    commonFlags: ['json'],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { json?: boolean };
      return executeAgentCatalog({
        json: opts.json === true,
        tools: ctx.tools,
        internalCommands: ctx.toolInternalCommands,
      });
    },
  });
}
