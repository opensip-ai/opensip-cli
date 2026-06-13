#!/usr/bin/env node

// @fitness-ignore-file detached-promises -- composition root invokes synchronous bootstrap helpers (mountAllToolCommands, registerCliCommands, printWelcome) that the heuristic mistakes for promise-returning calls
/**
 * OpenSIP CLI — composition root (sequencer, not a god file).
 *
 * The canonical ordered description of the full tool + host lifecycle lives in
 * `bootstrap/tool-lifecycle.ts` (the 10 named steps, two phases: STARTUP in
 * bootstrapCli + mountToolCommands, PER-RUN in the preAction hook + builders).
 * This file wires the major seams (fresh registries per invocation, bootstrap,
 * pre-action hook install, ToolCliContext construction, command mounting,
 * host command registration, telemetry, top-level error paths) and then
 * dispatches. Individual steps are factored into `./bootstrap/*` (admission,
 * scope building, capability wiring, delivery) and `./commands/*`.
 *
 * Adding a new tool requires zero changes here — tools declare `commandSpecs`
 * (and optional hooks) and are discovered/admitted/mounted uniformly.
 *
 * See also: bootstrap/tool-lifecycle.ts (TOOL_LIFECYCLE_STEPS + JSDoc),
 * pre-action-hook.ts, build-per-run-scope.ts, register-tools.ts.
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LanguageRegistry, ToolRegistry, logger, readPackageVersion, getMeter } from '@opensip-cli/core';
import { Command } from 'commander';

import {
  bootstrapCli,
  installPreActionHook,
  maybeOpenReport,
  mountToolCommands,
  renderResult,
  buildCommandRegistrationInput,
} from './bootstrap/index.js';
import { buildToolCliContext, createLiveViewRegistry, getOrOpenDatastore } from './cli-context.js';
import { registerCliCommands } from './commands/index.js';
import { handleFatalBootstrapError, handleParseError } from './error-handler.js';
import { runWithTelemetryContext, shutdownTelemetry } from './telemetry/sdk-init.js';
import { printWelcome } from './welcome.js';

export * from './api.js';

const cliVersion = readPackageVersion(import.meta.url);

const program = new Command('opensip')
  .description('Codebase analysis toolkit — pluggable tools for fitness, simulation, and more')
  // ADR-0008: per-run opt-out of OpenSIP Cloud signal sync. `--no-cloud` sets
  // `cloud` to false; the pre-action hook reads it via optsWithGlobals().
  .option('--no-cloud', 'Disable OpenSIP Cloud signal sync for this run')
  .version(cliVersion)
  // Route Commander's own parse failures through `parseAsync().catch` →
  // `handleParseError` instead of letting Commander call `process.exit(N)`
  // directly. This restores the project's typed-error → exit-code contract for
  // declarative `choices`/argument validation: a bad `--resolution`/option
  // value is a usage error that must exit `CONFIGURATION_ERROR` (2) — the same
  // code the pre-command-plane in-handler `ValidationError` produced — not
  // Commander's default `1`. `handleParseError` preserves Commander's own
  // exit code for every OTHER Commander condition (unknown command/option →
  // 1, --help/--version → 0), so only the invalid-argument case is re-mapped.
  // Commander still writes its own error line to stderr before throwing, so the
  // handler renders nothing extra for a CommanderError (no duplicate output).
  .exitOverride();

async function main(): Promise<void> {
  // Fresh registries per CLI invocation. Tools read these via
  // `cli.scope.languages` / `cli.scope.tools`; bootstrap populates them here.
  const langRegistry = new LanguageRegistry();
  const toolRegistry = new ToolRegistry();

  // Persistence: datastore is opened LAZILY in cli-context.ts on
  // first access via getOrOpenDatastore. bootstrapCli just registers
  // tools and adapters; no SQLite file is created here.
  const { provenance, manifests } = await bootstrapCli({
    langRegistry,
    toolRegistry,
    projectDir: dirname(dirname(fileURLToPath(import.meta.url))),
    cwd: process.cwd(),
    cliEntryUrl: import.meta.url,
  });

  // Install the pre-action hook AFTER bootstrap so the populated registries +
  // admitted-tool manifests/provenance are captured directly in the hook
  // closure — no module-global handoff bag. The hook builds + enters the
  // per-run RunScope (stamping manifests/provenance onto it); from there every
  // per-run read goes through `currentScope()`.
  installPreActionHook(program, cliVersion, {
    languages: langRegistry,
    tools: toolRegistry,
    manifests,
    provenance,
  });

  const { ctx } = buildToolCliContext({
    render: renderResult,
    liveViews: createLiveViewRegistry(logger),
    maybeOpenReport,
    logger,
  });

  // Step 8 of the tool lifecycle (§5.4): mount each registered tool's commands
  // through the named sequencer seam. The host owns `program` and passes it in
  // (launch — the tool context no longer carries a raw-Commander handle, §8); the
  // one command surface is each tool's declarative commandSpecs.
  mountToolCommands(toolRegistry, program, ctx);

  // Extracted into a thin dedicated builder (roadmap item 2) to keep the
  // top-level composition root focused on sequencing. The builder returns the
  // exact shape consumed by `registerCliCommands`.
  const registrationInput = buildCommandRegistrationInput(toolRegistry);
  registerCliCommands(program, {
    setExitCode: ctx.setExitCode,
    render: renderResult,
    emitJson: ctx.emitJson,
    emitRaw: ctx.emitRaw,
    emitError: ctx.emitError,
    datastore: () => getOrOpenDatastore(logger),
    ...registrationInput,
  });

  // Bare `opensip` → welcome screen. The update check is owned by the
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
  // `--json` is read from argv here because bootstrap/parse errors fire OUTSIDE a
  // handler (no parsed opts). It selects the structured `CommandOutcome` error
  // path (§5.5) over human Ink rendering.
  const jsonRequested = process.argv.includes('--json');
  const commandStart = Date.now();
  await runWithTelemetryContext(() =>
    program.parseAsync().catch((error: unknown) =>
      handleParseError(error, {
        setExitCode: ctx.setExitCode,
        render: renderResult,
        jsonRequested,
      }),
    ),
  );
  // Phase 2: command duration histogram (low cardinality labels)
  const durationMs = Date.now() - commandStart;
  getMeter('opensip-cli').createHistogram('opensip_cli.command.duration_ms').record(durationMs, {
    command: process.argv[2] || 'welcome', // rough; real commands go through pre-action
  });
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
