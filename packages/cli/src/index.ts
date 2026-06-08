#!/usr/bin/env node

// @fitness-ignore-file detached-promises -- composition root invokes synchronous bootstrap helpers (mountAllToolCommands, registerCliCommands, printWelcome) that the heuristic mistakes for promise-returning calls
/**
 * OpenSIP Tools CLI — composition root. Reads top-to-bottom as wiring.
 * Bootstrap, context, command-mount, and error-handling each live in
 * their own module under `./bootstrap`, `./cli-context`, `./commands`,
 * and `./error-handler`. Adding a new tool requires zero changes here.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LanguageRegistry,
  ToolRegistry,
  logger,
  readPackageVersion,
} from '@opensip-tools/core';
import { Command } from 'commander';

import {
  bootstrapCli,
  installPreActionHook,
  maybeOpenDashboard,
  mountToolCommands,
  renderResult,
} from './bootstrap/index.js';
import { buildToolCliContext, createLiveViewRegistry, getOrOpenDatastore, setCliRegistriesForRun, setToolManifestsForRun, setToolProvenanceForRun } from './cli-context.js';
import { registerCliCommands } from './commands/index.js';
import { handleFatalBootstrapError, handleParseError } from './error-handler.js';
import { runWithTelemetryContext, shutdownTelemetry } from './telemetry/sdk-init.js';
import { printWelcome } from './welcome.js';

export * from './api.js';

const cliVersion = readPackageVersion(import.meta.url);

const program = new Command('opensip-tools')
  .description('Codebase analysis toolkit — pluggable tools for fitness, simulation, and more')
  // ADR-0008: per-run opt-out of OpenSIP Cloud signal sync. `--no-cloud` sets
  // `cloud` to false; the pre-action hook reads it via optsWithGlobals().
  .option('--no-cloud', 'Disable OpenSIP Cloud signal sync for this run')
  .version(cliVersion);

installPreActionHook(program, cliVersion);

async function main(): Promise<void> {
  // Fresh registries per CLI invocation — the previously-exported
  // `defaultLanguageRegistry` / `defaultToolRegistry` module globals are
  // gone (Phase 5 deferred Task 5.4). Tools read these via
  // `cli.scope.languages` / `cli.scope.tools`; bootstrap populates them
  // here and `setCliRegistriesForRun` makes them visible to the
  // `ToolCliContext.scope` getter via cli-context's per-run holders.
  const langRegistry = new LanguageRegistry();
  const toolRegistry = new ToolRegistry();
  setCliRegistriesForRun({ languages: langRegistry, tools: toolRegistry });

  // v2 persistence: datastore is opened LAZILY in cli-context.ts on
  // first access via getOrOpenDatastore. bootstrapCli just registers
  // tools and adapters; no SQLite file is created here.
  const { provenance, manifests } = await bootstrapCli({
    langRegistry,
    toolRegistry,
    projectDir: dirname(dirname(fileURLToPath(import.meta.url))),
    cwd: process.cwd(),
    cliEntryUrl: import.meta.url,
  });
  // Make the compatibility-gate provenance reachable by `plugin list`
  // (Phase 4) via the cli-context per-run holder.
  setToolProvenanceForRun(provenance);
  // Make the admitted manifests reachable by the pre-action-hook so it can
  // seed the per-run capability registry with each tool's declared domains
  // (release 2.10.0, §5.3).
  setToolManifestsForRun(manifests);

  const { ctx } = buildToolCliContext({
    program, render: renderResult, liveViews: createLiveViewRegistry(logger),
    maybeOpenDashboard, logger,
  });

  // Step 8 of the tool lifecycle (§5.4): mount each registered tool's commands
  // through the named sequencer seam (declarative commandSpecs / deprecated
  // register() fallback, per-tool failure isolation).
  mountToolCommands(toolRegistry, ctx);
  // Source the plugin-supporting domains from the registered tools'
  // declared layouts — the kernel never enumerates them (ADR-0009).
  const pluginLayouts = toolRegistry
    .list()
    .map((t) => t.pluginLayout)
    .filter((l): l is NonNullable<typeof l> => l !== undefined);
  registerCliCommands(program, {
    setExitCode: ctx.setExitCode,
    render: renderResult,
    datastore: () => getOrOpenDatastore(logger),
    pluginLayouts,
  });

  // Bare `opensip-tools` → welcome screen. The update check is owned by the
  // pre-action hook (which only runs for actual subcommands), so it naturally
  // skips zero-arg runs without a guard here.
  // Return (not process.exit) so the top-level `finally` still runs the
  // telemetry shutdown flush — consistent with this file's exitCode-over-
  // exit() principle below. Exit code defaults to 0.
  if (process.argv.length <= 2) {
    printWelcome({ version: program.version() ?? 'dev' });
    return;
  }

  // Dispatch inside the telemetry parent context so spans emitted during the
  // run (e.g. graph's per-stage spans) nest under the consumer's TRACEPARENT
  // when one was supplied. A plain pass-through when telemetry is disabled or
  // no parent context was extracted, so standalone runs pay nothing.
  await runWithTelemetryContext(() =>
    program.parseAsync().catch((error: unknown) =>
      handleParseError(error, { setExitCode: ctx.setExitCode, render: renderResult }),
    ),
  );
}

// Top-level fatal handler. Errors that escape `main` predate Commander's
// parse loop (bootstrap, registry registration, fs I/O during preflight)
// and so don't reach the per-command catch in `parseAsync().catch(...)`.
// Route them through the same error-handler seam so the exit code flows
// through `process.exitCode` (not `process.exit(N)` — the latter skips
// the pending stderr flush) and a `cli.bootstrap.failed` log line is
// emitted for observability. Audit 2026-05-23 G1.
try {
  await main();
} catch (error) {
  handleFatalBootstrapError(error, logger);
} finally {
  // Flush batched spans before the short-lived process exits — on normal
  // completion and on handled error exits alike. No-op when telemetry was
  // never started (standalone), so standalone runs pay nothing. The early
  // welcome-screen `process.exit(0)` above runs no commands and emits no
  // spans, so skipping the flush there is harmless.
  await shutdownTelemetry();
}
