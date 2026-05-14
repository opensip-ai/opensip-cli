/**
 * simulationTool — simulation as a Tool plugin.
 *
 * Companion to fitnessTool. The CLI imports this directly (first-party
 * dep) and registers it. Phase 2 wraps the existing executeSim helper;
 * Phase 4 will route argv through Tool.commands[].run instead.
 */

import type { Tool, ToolCommand, ToolRunContext, ToolRunResult } from '@opensip-tools/core';
import type { CliArgs } from '@opensip-tools/cli-shared';
import { EXIT_CODES } from '@opensip-tools/cli-shared';

import { executeSim } from './cli/sim.js';

function buildArgs(ctx: ToolRunContext): CliArgs {
  return {
    command: 'sim',
    json: false,
    cwd: ctx.cwd,
    help: false,
    list: false,
    listRecipes: false,
    verbose: false,
    exclude: [],
    findings: false,
    config: ctx.configPath,
  };
}

const simCommand: ToolCommand = {
  name: 'sim',
  description: 'Run simulation scenarios [experimental]',
  run: async (_argv, ctx): Promise<ToolRunResult> => {
    const result = executeSim(buildArgs(ctx));
    return { exitCode: EXIT_CODES.SUCCESS, output: result };
  },
};

export const simulationTool: Tool = {
  metadata: {
    id: 'simulation',
    version: '2.0.0',
    description: 'Run simulation scenarios against a codebase',
  },
  commands: [simCommand],
};
