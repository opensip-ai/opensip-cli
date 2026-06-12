/**
 * build-command-registration-input — thin builder for the data needed by
 * `registerCliCommands` after tool mounting.
 *
 * Extracted from the top-level composition root in `index.ts` (roadmap item 2)
 * to further reduce inline logic in the bootstrap sequencer. This follows the
 * same pattern as `build-per-run-scope.ts`.
 *
 * The host owns "pluginLayouts", "toolScaffolds", "sessionReplayRegistry", and
 * "toolCommandSpecs" preparation so the main entry point stays focused on
 * sequencing (registries, bootstrap, mounting, registration, dispatch).
 */

import { logger } from '@opensip-tools/core';

import { SessionReplayRegistry } from '../session-replay-registry.js';

import { EXPECTED_SCAFFOLDING_TOOL_IDS } from './register-tools.js';

import type {
  CommandSpec,
  PluginLayout,
  ScaffoldContext,
  ScaffoldFile,
  ToolCliContext,
  ToolRegistry,
} from '@opensip-tools/core';

/** The structured input consumed by `registerCliCommands`. */
export interface CommandRegistrationInput {
  readonly pluginLayouts: readonly NonNullable<PluginLayout>[];
  readonly toolScaffolds: readonly {
    readonly layout: PluginLayout;
    readonly scaffoldExamples: ((ctx: ScaffoldContext) => readonly ScaffoldFile[]) | undefined;
    readonly stableExampleIds: (() => readonly string[]) | undefined;
    readonly scaffoldConfigBlock: (() => string) | undefined;
  }[];
  readonly sessionReplayRegistry: SessionReplayRegistry;
  readonly toolCommandSpecs: readonly CommandSpec<unknown, ToolCliContext>[];
}

/**
 * Collects the registry-derived data needed for CLI command registration.
 * Emits the ADR-0038 back-compat diagnostic for expected bundled tools that
 * are absent (this warning is intentionally loud when a bundled tool is
 * missing, as it affects `init` scaffolding).
 */
export function buildCommandRegistrationInput(registry: ToolRegistry): CommandRegistrationInput {
  // Source the plugin-supporting domains from the registered tools'
  // declared layouts — the kernel never enumerates them (ADR-0009).
  const pluginLayouts = registry
    .list()
    .map((t) => t.pluginLayout)
    .filter((l): l is NonNullable<typeof l> => l !== undefined);

  // ADR-0038: the per-tool `init`-scaffold contributions, sourced from the same
  // registry. `init` iterates these (each tool's pluginLayout + scaffoldExamples)
  // instead of hardcoding fit/sim. A tool with no pluginLayout contributes nothing.
  const toolScaffolds = registry.list().flatMap((t) => {
    const layout = t.pluginLayout;
    if (layout === undefined) return [];
    return [
      {
        layout,
        scaffoldExamples: t.scaffoldExamples,
        stableExampleIds: t.stableExampleIds,
        scaffoldConfigBlock: t.scaffoldConfigBlock,
      },
    ];
  });

  // Back-compat diagnostic (ADR-0038): the old init always scaffolded fit/sim;
  // the registry-driven init scaffolds FEWER dirs if one of those is absent. A
  // loud warning makes a silent under-scaffold observable; a genuinely
  // uninstalled third-party tool stays silent (correct). The expected-id pin
  // lives beside BUNDLED_TOOL_PACKAGES (register-tools.ts) — see its JSDoc for
  // why it is a historical constant rather than derived from loaded manifests.
  for (const expectedId of EXPECTED_SCAFFOLDING_TOOL_IDS) {
    if (!registry.list().some((t) => t.metadata.id === expectedId)) {
      logger.warn({
        evt: 'cli.tool.expected_bundled_absent',
        module: 'cli:bootstrap',
        tool: expectedId,
        msg: `Expected bundled tool '${expectedId}' is absent from the registry — its init scaffold dirs will not be created.`,
      });
    }
  }

  const sessionReplayRegistry = SessionReplayRegistry.fromTools(registry);

  // The live tool command surface, sourced from the populated registry so the
  // `completion` command derives its flags from the same specs the runtime
  // mounts (no hand-maintained flag list to drift).
  const toolCommandSpecs = registry.list().flatMap((t) => t.commandSpecs ?? []);

  return {
    pluginLayouts,
    toolScaffolds,
    sessionReplayRegistry,
    toolCommandSpecs,
  };
}
