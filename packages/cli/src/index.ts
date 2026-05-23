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
  defaultLanguageRegistry,
  defaultToolRegistry,
  logger,
  readPackageVersion,
} from '@opensip-tools/core';
import { Command } from 'commander';

import {
  bootstrapCli,
  builtinLiveViews,
  installPreActionHook,
  maybeOpenDashboard,
  mountAllToolCommands,
  renderResult,
} from './bootstrap/index.js';
import { buildToolCliContext, createLiveViewRegistry } from './cli-context.js';
import { registerCliCommands } from './commands/index.js';
import { handleParseError } from './error-handler.js';
import { maybeNotify } from './update-notifier.js';
import { printWelcome } from './welcome.js';

export * from './api.js';

const program = new Command('opensip-tools')
  .description('Codebase analysis toolkit — pluggable tools for fitness, simulation, and more')
  .version(readPackageVersion(import.meta.url));

installPreActionHook(program);

async function main(): Promise<void> {
  await bootstrapCli({
    langRegistry: defaultLanguageRegistry,
    toolRegistry: defaultToolRegistry,
    projectDir: dirname(dirname(fileURLToPath(import.meta.url))),
  });

  const { ctx } = buildToolCliContext({
    program, render: renderResult, liveViews: createLiveViewRegistry(logger),
    builtinLiveViews, maybeOpenDashboard, logger,
  });

  mountAllToolCommands(defaultToolRegistry, ctx);
  registerCliCommands(program, { setExitCode: ctx.setExitCode, render: renderResult });

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

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`opensip-tools: fatal error: ${message}\n`);
  process.exit(1);
}
