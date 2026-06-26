/**
 * Ergonomic authoring helper — a thin facade over {@link defineTool} that builds
 * primary/nested command drafts from a reduced input surface.
 */

import { defineNestedCommand, definePrimaryCommand } from './command-spec-draft.js';
import { defineTool, type DefineToolInput } from './define-tool.js';
import { TOOL_CONTRACT_VERSION } from './types.js';

import type { CommandSpec } from './command-spec.js';
import type { ToolIdentity } from './identity.js';
import type { Tool, ToolCliContext, ToolMetadata } from './types.js';

/** Reduced author input for {@link createTool}. */
export interface CreateToolInput {
  readonly identity: ToolIdentity;
  readonly metadata: Omit<ToolMetadata, 'name'>;
  readonly primaryCommand: Omit<
    CommandSpec<unknown, ToolCliContext>,
    'name' | 'aliases' | 'parent'
  >;
  readonly subcommands?: readonly (Omit<CommandSpec<unknown, ToolCliContext>, 'parent'> & {
    readonly name: string;
  })[];
  readonly extensionPoints?: DefineToolInput['extensionPoints'];
  readonly pluginLayout?: DefineToolInput['pluginLayout'];
  readonly contractVersion?: string;
}

/**
 * Build a host-ready {@link Tool} from a reduced author surface.
 * Delegates all validation and derivation to {@link defineTool}.
 */
export function createTool(input: CreateToolInput): Tool {
  const commandSpecs = [
    definePrimaryCommand(input.primaryCommand),
    ...(input.subcommands ?? []).map((spec) => defineNestedCommand(spec)),
  ];

  return defineTool({
    identity: input.identity,
    metadata: input.metadata,
    commandSpecs,
    contractVersion: input.contractVersion ?? TOOL_CONTRACT_VERSION,
    ...(input.extensionPoints === undefined ? {} : { extensionPoints: input.extensionPoints }),
    ...(input.pluginLayout === undefined ? {} : { pluginLayout: input.pluginLayout }),
  });
}
