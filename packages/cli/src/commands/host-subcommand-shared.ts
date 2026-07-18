/**
 * Shared types and helpers for host subcommand group leaf specs.
 */

import {
  type CommandScopeRequirement,
  type CommandSpec,
  type ProjectContext,
} from '@opensip-cli/core';

import type { HostRuntimeCommandSpec } from './host-runtime-access.js';
import type { CliCommandsContext } from './shared.js';

/** A host command spec — handler receives the {@link CliCommandsContext}. */
export type HostSpec = HostRuntimeCommandSpec<unknown, CliCommandsContext>;

/** Every grouped leaf needs the entered project scope (datastore / project context). */
export const PROJECT_SCOPE: CommandScopeRequirement = 'project';

/** The `command-result` output mode, named once (the leaves all share it). */
export const COMMAND_RESULT: CommandSpec['output'] = 'command-result';

export const RAW_STREAM: CommandSpec['output'] = 'raw-stream';

/** Prefer the discovered project root; fall back to literal cwd; finally process.cwd(). */
export function effectiveCwd(opts: { cwd?: string; projectContext?: ProjectContext }): string {
  return opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
}

/** Re-export the host-only decorator under the established local helper name. */

export { defineHostCommand as defineCommand } from './host-runtime-access.js';
export type { HostCommandRuntimePolicy } from './host-runtime-access.js';
