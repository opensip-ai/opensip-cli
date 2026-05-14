/**
 * fitnessTool — fitness as a Tool plugin.
 *
 * The CLI imports this directly (first-party tool, declared dep) and
 * registers it with the default tool registry. Third-party packages
 * mirror this shape via the package.json#opensipTools.kind === 'tool'
 * marker plus a default export of `{ tool: <Tool> }`.
 *
 * Phase 2 wraps the existing executeXxx() helpers as ToolCommand.run
 * adapters. The argv → CliArgs translation is handled by the CLI's
 * Commander setup today (Phase 4 will move it here when the CLI
 * becomes a generic dispatcher); for Phase 2 the run() functions are
 * simple bridges that defer to the existing CLI code path.
 */

import type { Tool, ToolCommand, ToolRunContext, ToolRunResult } from '@opensip-tools/core';
import type { CliArgs } from '@opensip-tools/cli-shared';
import { EXIT_CODES } from '@opensip-tools/cli-shared';

import { executeFit, ensureChecksLoaded } from './cli/fit.js';
import { openDashboard } from './cli/dashboard.js';
import { executeListChecks } from './cli/list-checks.js';
import { executeListRecipes } from './cli/list-recipes.js';

// Phase 2 keeps the legacy CliArgs shape — Phase 4 will replace this
// with proper argv parsing per command. For now the run() handlers are
// not actively invoked from the CLI (the CLI still uses Commander +
// the executeXxx helpers directly); they exist so third-party tools
// can be registered through the same contract.

function buildArgs(command: string, ctx: ToolRunContext, overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    command,
    json: false,
    cwd: ctx.cwd,
    help: false,
    list: false,
    listRecipes: false,
    verbose: false,
    exclude: [],
    findings: false,
    config: ctx.configPath,
    ...overrides,
  };
}

const fitCommand: ToolCommand = {
  name: 'fit',
  description: 'Run fitness checks',
  run: async (_argv, ctx): Promise<ToolRunResult> => {
    const args = buildArgs('fit', ctx);
    const result = await executeFit(args);
    if (result.result.type === 'error') {
      return { exitCode: result.result.exitCode };
    }
    return {
      exitCode: result.result.shouldFail ? EXIT_CODES.RUNTIME_ERROR : EXIT_CODES.SUCCESS,
      output: result.output,
    };
  },
};

const dashboardCommand: ToolCommand = {
  name: 'dashboard',
  description: 'Generate the HTML dashboard and open it in your browser',
  run: async (_argv, ctx): Promise<ToolRunResult> => {
    const result = await openDashboard(ctx.cwd);
    return { exitCode: EXIT_CODES.SUCCESS, output: result };
  },
};

const fitListCommand: ToolCommand = {
  name: 'fit-list',
  description: 'List available fitness checks',
  aliases: ['list-checks'],
  run: async (_argv, ctx): Promise<ToolRunResult> => {
    const result = await executeListChecks(ctx.cwd);
    return { exitCode: EXIT_CODES.SUCCESS, output: result };
  },
};

const fitRecipesCommand: ToolCommand = {
  name: 'fit-recipes',
  description: 'List available fitness recipes',
  aliases: ['list-recipes'],
  run: async (_argv, ctx): Promise<ToolRunResult> => {
    const result = await executeListRecipes(ctx.cwd);
    return { exitCode: EXIT_CODES.SUCCESS, output: result };
  },
};

export const fitnessTool: Tool = {
  metadata: {
    id: 'fitness',
    version: '2.0.0',
    description: 'Run fitness checks against a codebase',
  },
  commands: [fitCommand, dashboardCommand, fitListCommand, fitRecipesCommand],
  initialize: async (ctx): Promise<void> => {
    // Drive the existing lazy-init path so callers reach a consistent
    // post-init state regardless of which command they run first.
    await ensureChecksLoaded(ctx.cwd);
  },
};

// Re-export the pre-load hook setter for the CLI (project-plugin auto-sync
// is a CLI concern but the trigger lives inside ensureChecksLoaded).
export { setPreLoadHook } from './cli/fit.js';
