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
 *
 * Barrel surface: only the symbols `index.ts` actually consumes are
 * re-exported from this barrel. Internal helpers (`mergeConfigDefaults`,
 * `loadCliDefaults`, `registerFirstPartyTools`, `FIRST_PARTY_TOOLS`,
 * `registerLanguageAdapters`, the global-config primitives) stay in
 * their files; bootstrap siblings and tests import them directly. Audit
 * 2026-05-23 M1.
 */

import { discoverAndRegisterGraphAdapterPackages } from './register-graph-adapters.js';
import { registerLanguageAdapters } from './register-language-adapters.js';
import {
  registerFirstPartyTools,
  discoverAndRegisterToolPackages,
} from './register-tools.js';

import type { LanguageRegistry, ToolRegistry } from '@opensip-tools/core';

// Re-export only the symbols the CLI composition root (`index.ts`) consumes.
export { mountAllToolCommands } from './register-tools.js';
export { renderResult } from './render.js';
export { builtinLiveViews } from './live-views.js';
export { maybeOpenDashboard } from './dashboard.js';
export { installPreActionHook } from './pre-action-hook.js';

export interface BootstrapOptions {
  readonly langRegistry: LanguageRegistry;
  readonly toolRegistry: ToolRegistry;
  /** Project directory used by `discoverToolPackages`; usually the CLI install dir. */
  readonly projectDir: string;
}

/**
 * One-shot bootstrap: register language adapters, register the first-
 * party tools, discover-and-register every third-party tool, then
 * discover-and-register every @opensip-tools/graph-* adapter pack.
 *
 * Graph adapter discovery runs BEFORE `mountAllToolCommands`: the
 * graph tool's `register()` method assumes adapters are already
 * available so its lang-adapter registry isn't empty when the first
 * `pickAdapter()` lands during a real run. PR 1a of plan
 * docs/plans/architecture/2026-05-23-plan-graph-adapter-package-split.md.
 */
export async function bootstrapCli(opts: BootstrapOptions): Promise<void> {
  registerLanguageAdapters(opts.langRegistry);
  registerFirstPartyTools(opts.toolRegistry);
  await discoverAndRegisterToolPackages(opts.toolRegistry, {
    projectDir: opts.projectDir,
  });
  await discoverAndRegisterGraphAdapterPackages({ projectDir: opts.projectDir });
}
