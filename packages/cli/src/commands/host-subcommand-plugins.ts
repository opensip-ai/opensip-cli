/**
 * Per-tool `plugin` subcommand group leaf specs and mount helpers.
 */

import { currentScope, type PluginLayout, type ToolRegistry } from '@opensip-cli/core';

import { mountCommandSpec } from './mount-command-spec.js';
import { pluginAdd, pluginList, pluginRemove, pluginSync } from './plugin.js';
import {
  COMMAND_RESULT,
  defineCommand,
  effectiveCwd,
  PROJECT_SCOPE,
  type HostSpec,
} from './host-subcommand-shared.js';

import type { CliCommandsContext } from './shared.js';
import type { CliProgram } from '@opensip-cli/contracts';
import type { ProjectContext } from '@opensip-cli/core';

function pluginCwdOption() {
  return {
    flag: '--cwd',
    value: '<path>',
    description: 'Project root',
    default: process.cwd(),
  } as const;
}

interface PluginCwdOpts {
  cwd?: string;
  projectContext?: ProjectContext;
}

function boundLayouts(ctx: CliCommandsContext, domain: string): readonly PluginLayout[] {
  const match = ctx.pluginLayouts.find((l) => l.domain === domain);
  return match ? [match] : [{ domain, userSubdirs: [] }];
}

function buildPluginListSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'list',
    description: `List installed ${domain} packs`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts;
      return pluginList(
        effectiveCwd(opts),
        boundLayouts(ctx, domain),
        currentScope()?.toolProvenance ?? [],
      );
    },
  });
}

function buildPluginAddSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'add',
    description: `Install a ${domain} pack and record it in opensip-cli.config.yml`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    args: [{ name: 'package', description: '' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts & { _args: string[] };
      const packageName = opts._args[0];
      return pluginAdd(packageName, effectiveCwd(opts), domain, boundLayouts(ctx, domain));
    },
  });
}

function buildPluginRemoveSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'remove',
    description: `Uninstall a ${domain} pack and remove it from opensip-cli.config.yml`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    args: [{ name: 'package', description: '' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts & { _args: string[] };
      const packageName = opts._args[0];
      return pluginRemove(packageName, effectiveCwd(opts), domain, boundLayouts(ctx, domain));
    },
  });
}

function buildPluginSyncSpec(ctx: CliCommandsContext, domain: string): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    name: 'sync',
    description: `Install every ${domain} pack declared in opensip-cli.config.yml (post-clone bootstrap)`,
    commonFlags: ['json'],
    options: [pluginCwdOption()],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as PluginCwdOpts;
      return pluginSync(effectiveCwd(opts), domain, boundLayouts(ctx, domain));
    },
  });
}

export function buildToolPluginLeaves(
  ctx: CliCommandsContext,
  domain: string,
): readonly HostSpec[] {
  return [
    buildPluginListSpec(ctx, domain),
    buildPluginAddSpec(ctx, domain),
    buildPluginRemoveSpec(ctx, domain),
    buildPluginSyncSpec(ctx, domain),
  ];
}

export interface ToolPluginGroup {
  readonly parentVerb: string;
  readonly parentAliases: readonly string[];
  /** @deprecated Use {@link parentVerb} — kept for completion inventory compat. */
  readonly toolVerb: string;
  readonly domain: string;
  readonly description: string;
  readonly leaves: readonly HostSpec[];
}

export function buildToolPluginGroups(
  ctx: CliCommandsContext,
  registry?: ToolRegistry,
): readonly ToolPluginGroup[] {
  return ctx.pluginLayouts.map((layout) => {
    const tool = registry
      ?.list()
      .find((candidate) => candidate.pluginLayout?.domain === layout.domain);
    const parentVerb = tool?.metadata.name ?? layout.domain;
    const parentAliases = tool?.identity.aliases ?? [];
    return {
      parentVerb,
      parentAliases,
      toolVerb: parentVerb,
      domain: layout.domain,
      description: `Manage ${layout.domain} extension packs (add, list, remove, sync)`,
      leaves: buildToolPluginLeaves(ctx, layout.domain),
    };
  });
}

export function mountToolPluginGroups(
  program: CliProgram,
  ctx: CliCommandsContext,
  registry?: ToolRegistry,
): void {
  for (const group of buildToolPluginGroups(ctx, registry)) {
    const primary = program.commands.find((c) => c.name() === group.parentVerb);
    if (primary === undefined) continue;
    const parent = primary.command('plugin').description(group.description);
    for (const leaf of group.leaves) {
      mountCommandSpec(parent, leaf, ctx);
    }
  }
}