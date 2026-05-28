// @fitness-ignore-file detached-promises -- bootstrap calls synchronous registration helpers (registerLanguageAdapters, registerFirstPartyTools) that the heuristic flags
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
 *   4. The project-local SQLite DataStore is opened so tools and CLI
 *      commands can persist sessions / baselines through it. Returned
 *      to the caller so the composition root can hand it to the
 *      `ToolCliContext` and the CLI-only commands.
 *
 * Discovery is async (dynamic `import()` of each tool package). The
 * caller awaits before walking the registry to mount Commander
 * subcommands so `--help` listings see every tool's commands.
 *
 * Datastore opening is sequenced AFTER tool / adapter registration so
 * registry side-effects (which never touch SQLite) land before the
 * file-system handle exists. If a tool's `register()` ever needs the
 * datastore at registration time, that's a contract change — flag it,
 * don't reorder silently.
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
 * party tools, and discover-and-register every third-party tool +
 * @opensip-tools/graph-* adapter pack. Datastore is NOT opened here —
 * it's a lazy getter on ToolCliContext (cli-context.ts), so dry-runs
 * and error paths that never read `cli.datastore` don't materialise
 * `.runtime/datastore.sqlite`.
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
