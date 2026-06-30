import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { resolveProjectPaths } from '@opensip-cli/core';

import { writeTemplateFiles } from './create-template-writer.js';
import {
  isToolsCreateTemplate,
  TOOLS_CREATE_TEMPLATE_RENDERERS,
  type ToolsCreateTemplate,
} from './create-templates.js';
import { addTrustedToolToConfig } from './trust-config.js';

import type { ToolsCreateResult } from '@opensip-cli/contracts';

export const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const TOOLS_CREATE = 'tools-create' as const;

export interface ToolsCreateInput {
  readonly toolId: string;
  readonly projectRoot: string;
  readonly force?: boolean;
  readonly template?: ToolsCreateTemplate;
}

/**
 * Scaffold a project-local Tool under `<project>/opensip-cli/tools/<id>/`.
 */
export function toolsCreate(input: ToolsCreateInput): ToolsCreateResult {
  const toolId = input.toolId.trim();
  const template = input.template ?? 'minimal-js';

  if (!TOOL_ID_PATTERN.test(toolId)) {
    return {
      type: TOOLS_CREATE,
      toolId,
      dir: '',
      files: [],
      success: false,
      error: "tool id must be kebab-case (e.g. 'hello-tools')",
    };
  }

  if (!isToolsCreateTemplate(template)) {
    return {
      type: TOOLS_CREATE,
      toolId,
      template,
      dir: '',
      files: [],
      success: false,
      error: `unknown template '${String(template)}' (choose minimal-js or ts-local)`,
    };
  }

  const commandName = toolId;
  const projectPaths = resolveProjectPaths(input.projectRoot);
  const toolDir = join(projectPaths.authoredToolsDir, toolId);
  const stableId = randomUUID();
  const rendered = TOOLS_CREATE_TEMPLATE_RENDERERS[template]({
    toolId,
    stableId,
    commandName,
  });

  const writeResult = writeTemplateFiles({
    toolDir,
    files: rendered.files,
    force: input.force,
  });

  if (!writeResult.success) {
    return {
      type: TOOLS_CREATE,
      toolId,
      template,
      dir: toolDir,
      files: [],
      success: false,
      error: writeResult.error,
    };
  }

  try {
    addTrustedToolToConfig(projectPaths.configFile, toolId);
  } catch (error) {
    return {
      type: TOOLS_CREATE,
      toolId,
      template,
      dir: toolDir,
      files: writeResult.files,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    type: TOOLS_CREATE,
    toolId,
    template,
    dir: toolDir,
    files: writeResult.files,
    success: true,
    nextSteps: rendered.nextSteps,
  };
}
