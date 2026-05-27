#!/usr/bin/env node

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
  mountAllToolCommands,
  renderResult,
} from './bootstrap/index.js';
import { buildToolCliContext, createLiveViewRegistry, getOrOpenDatastore, setCliRegistriesForRun } from './cli-context.js';
import { registerCliCommands } from './commands/index.js';
import { handleFatalBootstrapError, handleParseError } from './error-handler.js';
import { maybeNotify } from './update-notifier.js';
import { printWelcome } from './welcome.js';

export * from './api.js';

const program = new Command('opensip-tools')
  .description('Codebase analysis toolkit — pluggable tools for fitness, simulation, and more')
  .version(readPackageVersion(import.meta.url));

installPreActionHook(program);

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
  await bootstrapCli({
    langRegistry,
    toolRegistry,
    projectDir: dirname(dirname(fileURLToPath(import.meta.url))),
  });

  const { ctx } = buildToolCliContext({
    program, render: renderResult, liveViews: createLiveViewRegistry(logger),
    maybeOpenDashboard, logger,
  });

  mountAllToolCommands(toolRegistry, ctx);
  registerCliCommands(program, {
    setExitCode: ctx.setExitCode,
    render: renderResult,
    datastore: () => getOrOpenDatastore(logger),
  });

  // Bare `opensip-tools` → welcome screen. The update notifier runs
  // AFTER this short-circuit by design (don't nag on zero-arg runs);
  // see docs/architecture/50-runtime/01-cli-dispatch.md.
  if (process.argv.length <= 2) {
    printWelcome({ version: program.version() ?? 'dev' });
    process.exit(0);
  }
  maybeNotify({ name: '@opensip-tools/cli', version: program.version() ?? '0.0.0' });

  await program.parseAsync().catch((error: unknown) =>
    handleParseError(error, { setExitCode: ctx.setExitCode, render: renderResult }),
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
}
