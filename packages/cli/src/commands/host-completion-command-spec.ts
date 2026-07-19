/**
 * Shell-completion host leaf.
 *
 * The caller supplies the live host surface projection so this leaf remains
 * independent of top-level host composition and cannot introduce a
 * completion-builder cycle.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';

import {
  assembleCompletionInventory,
  printCompletionScript,
  INTERNAL_COMMANDS,
  type GroupLike,
  type Shell,
  type SpecLike,
  type ToolPluginGroupLike,
} from './completion.js';
import { defineHostCommand as defineCommand } from './host-runtime-access.js';
import { showInternalCommands } from './internal-command-visibility.js';

import type { HostRuntimeCommandSpec } from './host-runtime-access.js';
import type { CliCommandsContext } from './shared.js';

export interface HostCompletionSurface {
  readonly specs: readonly SpecLike[];
  readonly groups: readonly GroupLike[];
  readonly toolPluginGroups: readonly ToolPluginGroupLike[];
}

/** Build the raw-stream shell-completion command. */
export function createCompletionCommandSpec(
  ctx: CliCommandsContext,
  hostSurface: () => HostCompletionSurface,
): HostRuntimeCommandSpec<unknown, CliCommandsContext> {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-command-specs.ts',
      declaration: 'buildCompletionSpec',
    },
    name: 'completion',
    description: 'Print a shell-completion script (bash | zsh | fish)',
    commonFlags: [],
    // Empty description preserves the historical help shape for the positional.
    args: [{ name: 'shell', description: '' }],
    scope: 'none',
    output: 'raw-stream',
    rawStreamReason: 'completion-script',
    handler: (rawOpts) => {
      const opts = rawOpts as { _args: string[] };
      const shell = opts._args[0];
      const normalized = shell.toLowerCase();
      if (normalized !== 'bash' && normalized !== 'zsh' && normalized !== 'fish') {
        process.stderr.write(`Unsupported shell: ${shell}. Expected one of: bash, zsh, fish.\n`);
        ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
        return;
      }
      const host = hostSurface();
      const internalCommands = showInternalCommands()
        ? new Set<string>()
        : (ctx.toolInternalCommands ?? INTERNAL_COMMANDS);
      const inventory = assembleCompletionInventory({
        toolSpecs: ctx.toolCommandSpecs ?? [],
        hostSpecs: host.specs,
        groups: host.groups,
        toolPluginGroups: host.toolPluginGroups,
        internalCommands,
      });
      printCompletionScript(normalized satisfies Shell, inventory);
    },
  });
}
