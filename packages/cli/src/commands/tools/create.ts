import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_LOCAL_MANIFEST_FILE, resolveProjectPaths } from '@opensip-cli/core';

import type { ToolsCreateResult } from '@opensip-cli/contracts';

const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ToolsCreateInput {
  readonly toolId: string;
  readonly projectRoot: string;
  readonly force?: boolean;
}

function manifestJson(toolId: string, commandName: string): string {
  return `${JSON.stringify(
    {
      kind: 'tool',
      id: toolId,
      name: toolId,
      version: '0.1.0',
      apiVersion: 1,
      main: './index.mjs',
      commands: [{ name: commandName, description: `Run ${toolId}` }],
    },
    null,
    2,
  )}\n`;
}

function runtimeMjs(toolId: string, commandName: string): string {
  // Dependency-free plain object: authored tools load via file URL and must not
  // require @opensip-cli/* packages in the consumer project node_modules.
  return `export const tool = {
  metadata: {
    id: '${toolId}',
    name: '${toolId}',
    version: '0.1.0',
    description: 'Project-local tool scaffolded by opensip tools create',
  },
  commandSpecs: [
    {
      name: '${commandName}',
      description: 'Run ${toolId}',
      commonFlags: ['json'],
      scope: 'none',
      output: 'command-result',
      handler: async () => ({
        type: 'text-lines',
        title: '${toolId}',
        lines: ['Your project-local tool is ready — allowlist it, then run opensip ${commandName}.'],
      }),
    },
  ],
};
`;
}

/**
 * Scaffold a minimal project-local Tool under `<project>/opensip-cli/tools/<id>/`.
 */
export function toolsCreate(input: ToolsCreateInput): ToolsCreateResult {
  const toolId = input.toolId.trim();
  if (!TOOL_ID_PATTERN.test(toolId)) {
    return {
      type: 'tools-create',
      toolId,
      dir: '',
      files: [],
      success: false,
      error: "tool id must be kebab-case (e.g. 'hello-tools')",
    };
  }

  const commandName = toolId;
  const toolDir = join(resolveProjectPaths(input.projectRoot).authoredToolsDir, toolId);
  const manifestPath = join(toolDir, PROJECT_LOCAL_MANIFEST_FILE);
  const entryPath = join(toolDir, 'index.mjs');

  if (existsSync(toolDir) && !input.force) {
    return {
      type: 'tools-create',
      toolId,
      dir: toolDir,
      files: [],
      success: false,
      error: `directory already exists: ${toolDir} (pass --force to overwrite scaffold files)`,
    };
  }

  mkdirSync(toolDir, { recursive: true });
  writeFileSync(manifestPath, manifestJson(toolId, commandName), 'utf8');
  writeFileSync(entryPath, runtimeMjs(toolId, commandName), 'utf8');

  return {
    type: 'tools-create',
    toolId,
    dir: toolDir,
    files: [manifestPath, entryPath],
    success: true,
    hint: `export OPENSIP_CLI_ALLOW_PROJECT_TOOLS='${toolId}'`,
  };
}
