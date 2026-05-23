/**
 * bootstrap — composition-root for the CLI.
 *
 * `bootstrapCli({ langRegistry, toolRegistry })` performs the side-effect-y
 * registrations the dispatcher needs before Commander is wired up:
 *
 *   1. Bundled language adapters land in the supplied `LanguageRegistry`.
 *   2. First-party tools (fitness / simulation / graph) land in the
 *      supplied `ToolRegistry`.
 *   3. Third-party tools — discovered via `discoverToolPackages` from
 *      core — are imported and registered as third-party. The built-in
 *      ids are skipped to avoid double-registration warnings.
 *
 * Discovery is async (dynamic `import()` of each tool package). The
 * caller awaits before walking the registry to mount Commander
 * subcommands so `--help` listings see every tool's commands.
 */

import { registerLanguageAdapters } from './register-language-adapters.js';
import {
  registerFirstPartyTools,
  discoverAndRegisterToolPackages,
} from './register-tools.js';

import type { LanguageRegistry, ToolRegistry } from '@opensip-tools/core';

export { registerLanguageAdapters } from './register-language-adapters.js';
export {
  FIRST_PARTY_TOOLS,
  registerFirstPartyTools,
  discoverAndRegisterToolPackages,
  mountAllToolCommands,
} from './register-tools.js';
export { loadCliDefaults, mergeConfigDefaults, type CliDefaults } from './cli-defaults.js';
export { renderResult, builtinLiveViews, maybeOpenDashboard } from './render-helpers.js';
export { installPreActionHook } from './pre-action-hook.js';

export interface BootstrapOptions {
  readonly langRegistry: LanguageRegistry;
  readonly toolRegistry: ToolRegistry;
  /** Project directory used by `discoverToolPackages`; usually the CLI install dir. */
  readonly projectDir: string;
}

/**
 * One-shot bootstrap: register language adapters, register the first-
 * party tools, then discover-and-register every third-party tool.
 */
export async function bootstrapCli(opts: BootstrapOptions): Promise<void> {
  registerLanguageAdapters(opts.langRegistry);
  registerFirstPartyTools(opts.toolRegistry);
  await discoverAndRegisterToolPackages(opts.toolRegistry, {
    projectDir: opts.projectDir,
  });
}
