/**
 * Author-facing entry point for Tool plugins. Authors declare `commandSpecs` and
 * optional `extensionPoints`; {@link defineTool} derives `commands[]` and returns
 * a normalized {@link Tool} the host admits today without a second manual list.
 */

import { deriveCommandsFromSpecs } from './derive-commands-from-specs.js';

import type { CommandSpec } from './command-spec.js';
import type { ToolCliContext, Tool, ToolExtensionPoints, ToolMetadata } from './types.js';
import type { PluginLayout } from '../plugins/types.js'; // leaf import — define-tool must not pull the plugins barrel

/** Input to {@link defineTool} — the small author surface. */
export interface DefineToolInput {
  readonly metadata: ToolMetadata;
  readonly commandSpecs: readonly CommandSpec<unknown, ToolCliContext>[];
  readonly extensionPoints?: ToolExtensionPoints;
  readonly pluginLayout?: PluginLayout;
  readonly contractVersion?: string;
}

/**
 * Build a host-ready {@link Tool} from the reduced author input.
 *
 * Hooks live in `extensionPoints` on the returned tool. Top-level hook fields are
 * intentionally omitted so new tools have one bag; {@link resolveToolHooks} still
 * reads legacy top-level fields on older tools during migration.
 */
export function defineTool(input: DefineToolInput): Tool {
  const commands = deriveCommandsFromSpecs(input.commandSpecs);
  return {
    metadata: input.metadata,
    commands,
    commandSpecs: input.commandSpecs,
    ...(input.pluginLayout === undefined ? {} : { pluginLayout: input.pluginLayout }),
    ...(input.contractVersion === undefined ? {} : { contractVersion: input.contractVersion }),
    ...(input.extensionPoints === undefined ? {} : { extensionPoints: input.extensionPoints }),
  };
}
