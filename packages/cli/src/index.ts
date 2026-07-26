#!/usr/bin/env node
// @fitness-ignore-file module-coupling-fan-out -- executable composition root intentionally wires independent bootstrap, host-command, telemetry, and rendering planes.

/**
 * OpenSIP CLI — composition root (sequencer, not a god file).
 *
 * The canonical ordered description of the full tool + host lifecycle lives in
 * `bootstrap/tool-lifecycle.ts` (the 10 named steps, two phases: STARTUP in
 * bootstrapCli + mountAllToolCommands, PER-RUN in the preAction hook + builders).
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

import { BUILTIN_TRUST_POLICY } from '@opensip-cli/config';
import {
  LanguageRegistry,
  ToolRegistry,
  logger,
  readPackageVersion,
  getMeter,
} from '@opensip-cli/core';
import { Command } from 'commander';

import { buildRuntimeCommandInventory } from './bootstrap/build-runtime-command-inventory.js';
import { runCommandDispatchBoundary } from './bootstrap/command-dispatch-boundary.js';
import {
  bootstrapCli,
  disposeCurrentScope,
  executeReportOpen,
  installPreActionHook,
  isRootVersionRequest,
  mountAllToolCommands,
  renderResult,
  buildCommandRegistrationInput,
  resolveStartupExecutionMode,
} from './bootstrap/index.js';
import { installInterruptAbortCoordinator } from './bootstrap/interrupt-abort.js';
import { installLastResortFailureNet } from './bootstrap/last-resort-failure-net.js';
import { runLightweightCommandProbe } from './bootstrap/lightweight-command-probe.js';
import { PolicyAuditCollector } from './bootstrap/policy-audit.js';
import { rejectHostCommandCollisions } from './bootstrap/reject-host-command-collisions.js';
import { startupFailureAsBootstrapError } from './bootstrap/startup-error.js';
import {
  acquireStartupRuntimeLease,
  type StartupRuntimeLeaseHandoff,
} from './bootstrap/startup-runtime-lease.js';
import { HOST_SUBSTRATE_ERROR_CATALOGS } from './bootstrap/substrate-error-catalogs.js';
import { buildToolCliContext, createLiveViewRegistry, getOrOpenDatastore } from './cli-context.js';
import { buildCommandScopeIndex } from './commands/command-scope-index.js';
import {
  buildPreBootstrapInspectionHostSpecs,
  buildTopLevelHostSpecs,
} from './commands/host-command-specs.js';
import {
  createSafeRuntimeLeaseEventBuffer,
  isInspectionOnlyHostRequest,
} from './commands/host-runtime-access.js';
import {
  buildHostSubcommandGroups,
  buildToolPluginGroups,
} from './commands/host-subcommand-groups.js';
import { registerCliCommands } from './commands/index.js';
import { handleFatalBootstrapError, handleParseError } from './error-handler.js';
import { resolvedCommandLabel } from './telemetry/command-label.js';
import { runWithTelemetryContext, shutdownTelemetry } from './telemetry/sdk-init.js';
import { printWelcome } from './welcome.js';

export * from './api.js';

// Process-edge last-resort net (Plan 00): install before any async work.
installLastResortFailureNet();
// Host-owned SIGINT/SIGTERM → per-invocation AbortSignal (Plan 00 Phase 4).
const interruptCoordinator = installInterruptAbortCoordinator();
process.once('exit', () => {
  interruptCoordinator.dispose();
});

const cliVersion = readPackageVersion(import.meta.url);

function createRootProgram(): Command {
  return (
    new Command('opensip')
      .description(
        'Codebase intelligence from your terminal — pluggable tools for fitness, simulation, and more',
      )
      // ADR-0008: per-run opt-out of OpenSIP Cloud signal sync. `--no-cloud` sets
      // `cloud` to false; the pre-action hook reads it via optsWithGlobals().
      .option('--no-cloud', 'Disable OpenSIP Cloud signal sync for this run')
      .option(
        '--no-plugins',
        'Skip loading installed npm tool packages (incident response; does not affect bundled or authored tools)',
      )
      // NOTE: the root program does NOT register a Commander `.version()` option.
      // A Commander version option on the root is a GLOBAL option that intercepts
      // `--version` even after a known subcommand, so `opensip fit --version` would
      // print the CLI version instead of the tool's. The per-tool `--version`
      // (decorateToolPrimary) is a subcommand-local Commander version option, and
      // the bare `opensip --version` (CLI version) is handled by the host argv
      // pre-scan (`isRootVersionRequest`) below — before Commander parses — so the
      // two never collide. See decorate-tool-primary.ts and the version phase spec.
      // Route Commander's own parse failures through `parseAsync().catch` →
      // `handleParseError` instead of letting Commander call `process.exit(N)`
      // directly. This restores the project's typed-error → exit-code contract for
      // declarative `choices`/argument validation.
      .exitOverride()
  );
}

async function main(): Promise<void> {
  const userArgv = process.argv.slice(2);
  const jsonRequested = userArgv.includes('--json');
  // Resolve the exact internal-command + host-marker pair before startup tool
  // discovery. A forged one-sided marker must fail before an external package's
  // module can be evaluated in this process.
  const runtimeMode = resolveStartupExecutionMode(userArgv, process.env);
  const inspectionOnly = isInspectionOnlyHostRequest(
    userArgv,
    buildPreBootstrapInspectionHostSpecs(),
  );

  // Bare `opensip --version` / `-V` → the CLI version (host-owned), printed
  // before any bootstrap. A `--version` AFTER a subcommand is that tool's own
  // (handled by decorateToolPrimary's subcommand-local version option).
  if (isRootVersionRequest(process.argv.slice(2))) {
    process.stdout.write(`${cliVersion}\n`);
    return;
  }

  // Bare `opensip` needs no project/user discovery or coordination. Keep the
  // welcome path ahead of registry/bootstrap construction.
  if (process.argv.length <= 2) {
    printWelcome({ version: cliVersion });
    return;
  }

  const cliProjectDir = dirname(dirname(fileURLToPath(import.meta.url)));
  if (
    !inspectionOnly &&
    (await runLightweightCommandProbe({
      program: createRootProgram(),
      argv: userArgv,
      projectDir: cliProjectDir,
      cwd: process.cwd(),
      cliEntryUrl: import.meta.url,
      runtimeMode,
    }))
  ) {
    return;
  }

  // Dynamic Tool discovery reads both project-local and user-global roots.
  // Acquire their shared footprint before the first discovery read. Once the
  // selected CommandSpec is known, project commands hand it into teardown while
  // scope-none host commands release discovery-only dimensions before action.
  const startupLeaseEvents = inspectionOnly ? undefined : createSafeRuntimeLeaseEventBuffer();
  let startupRuntimeLease: StartupRuntimeLeaseHandoff | undefined;
  try {
    startupRuntimeLease = inspectionOnly
      ? undefined
      : await acquireStartupRuntimeLease({
          argv: userArgv,
          defaultCwd: process.cwd(),
          onEvent: startupLeaseEvents?.onEvent,
        });
  } catch (error) {
    await handleParseError(startupFailureAsBootstrapError(error), {
      setExitCode: (code) => {
        process.exitCode = code;
      },
      render: renderResult,
      jsonRequested,
    });
    // @swallow-ok handleParseError already presented the failure through the canonical output seam.
    return;
  }
  try {
    const program = createRootProgram();
    // Fresh registries per CLI invocation. Tools read these via
    // `cli.scope.languages` / `cli.scope.tools`; bootstrap populates them here.
    const langRegistry = new LanguageRegistry();
    const toolRegistry = new ToolRegistry();
    // Ruling D1: substrate packages own error codes but are not Tools, so the composition
    // root is the only place that can declare them. Registering BEFORE any tool loads is
    // what makes a third-party tool claiming a substrate-owned code a refusal rather than a
    // silent reassignment to whichever contributor happened to be merged last.
    for (const contribution of HOST_SUBSTRATE_ERROR_CATALOGS) {
      toolRegistry.registerSubstrateCatalog(contribution);
    }

    // Persistence: datastore is opened LAZILY in cli-context.ts on
    // first access via getOrOpenDatastore. bootstrapCli just registers
    // tools and adapters; no SQLite file is created here.
    const {
      provenance,
      manifests,
      bootstrapDiagnostics,
      startupTimings,
      trustPolicy,
      policyAudit,
    } = inspectionOnly
      ? {
          provenance: [],
          manifests: [],
          bootstrapDiagnostics: [],
          startupTimings: [],
          trustPolicy: BUILTIN_TRUST_POLICY,
          policyAudit: new PolicyAuditCollector(),
        }
      : await bootstrapCli({
          langRegistry,
          toolRegistry,
          projectDir: cliProjectDir,
          cwd: startupRuntimeLease?.selection.cwd ?? process.cwd(),
          cwdExplicit: startupRuntimeLease?.selection.cwdExplicit ?? false,
          ...(startupRuntimeLease?.selection.explicitConfigPath === undefined
            ? {}
            : {
                explicitConfigPath: startupRuntimeLease.selection.explicitConfigPath,
              }),
          cliEntryUrl: import.meta.url,
          argv: userArgv,
          runtimeMode,
          /** @throws {Error} When standard discovery lacks its required runtime lease. */
          assertExternalDiscoveryProtected: (projectRoot) => {
            if (startupRuntimeLease === undefined) {
              throw new Error('Standard startup reached discovery without its runtime lease.');
            }
            startupRuntimeLease.assertDiscoveryProtected(projectRoot);
          },
        });
    rejectHostCommandCollisions(toolRegistry);

    const { ctx, runActionHooks, getExitCode } = buildToolCliContext({
      render: renderResult,
      liveViews: createLiveViewRegistry(logger),
      maybeOpenReport: executeReportOpen,
      logger,
    });

    // Extracted into a thin dedicated builder (roadmap item 2) to keep the
    // top-level composition root focused on sequencing. The builder returns the
    // exact shape consumed by `registerCliCommands`.
    const registrationInput = buildCommandRegistrationInput(toolRegistry, {
      // ADR-0054 M4-F: an EXTERNAL tool's session replay runs in a forked worker
      // (its runtime never runs in-host); bundled replays in-host.
      provenance,
      cwd: startupRuntimeLease?.selection.cwd ?? process.cwd(),
    });
    const commandCtx = {
      setExitCode: ctx.setExitCode,
      getExitCode,
      render: renderResult,
      reportFailure: ctx.reportFailure,
      emitJson: ctx.emitJson,
      emitRaw: ctx.emitRaw,
      emitError: ctx.emitError,
      datastore: () => getOrOpenDatastore(logger),
      manifests,
      provenance,
      toolContext: ctx,
      toolRunActionHooks: runActionHooks,
      ...registrationInput,
    };

    // Build host/tool command surfaces ONCE — same values feed scope indexing,
    // plain runtime inventory projection, and Commander mounting so inventory
    // cannot drift through repeated builders.
    const hostSpecs = buildTopLevelHostSpecs(commandCtx);
    const hostGroups = buildHostSubcommandGroups(commandCtx);
    const toolPluginGroups = buildToolPluginGroups(commandCtx, toolRegistry);
    const commandScopes = buildCommandScopeIndex({
      toolSpecs: registrationInput.toolCommandSpecs,
      hostSpecs,
      hostGroups,
      toolPluginGroups,
    });
    const runtimeCommands = buildRuntimeCommandInventory({
      toolRegistry,
      toolCommandSpecs: registrationInput.toolCommandSpecs,
      hostSpecs,
      hostGroups,
      toolPluginGroups,
      manifests,
      provenance,
    });

    // Install the pre-action hook AFTER bootstrap + command-scope indexing so the
    // populated registries, admitted-tool manifests/provenance, and live
    // CommandSpec.scope declarations are captured directly in the hook closure.
    const commandActionScopeRunner = installPreActionHook(
      program,
      cliVersion,
      {
        languages: langRegistry,
        tools: toolRegistry,
        manifests,
        provenance,
        bootstrapDiagnostics,
        startupTimings,
        trustPolicy,
        policyAudit,
        runtimeCommands,
      },
      commandScopes,
      startupRuntimeLease,
      startupLeaseEvents,
    );

    // Step 8 of the tool lifecycle (§5.4): mount each registered tool's commands
    // through the named sequencer seam. The host owns `program` and passes it in
    // (launch — the tool context no longer carries a raw-Commander handle, §8); the
    // one command surface is each tool's declarative commandSpecs.
    mountAllToolCommands(
      toolRegistry,
      program,
      ctx,
      provenance,
      runActionHooks,
      commandActionScopeRunner,
    );

    registerCliCommands(program, commandCtx, commandActionScopeRunner);

    // Dispatch inside the telemetry parent context so spans emitted during the
    // run (e.g. graph's per-stage spans) nest under the consumer's TRACEPARENT
    // when one was supplied. A plain pass-through when telemetry is disabled or
    // no parent context was extracted, so standalone runs pay nothing.
    // `--json` is read from argv here because bootstrap/parse errors fire OUTSIDE a
    // handler (no parsed opts). It selects the structured `CommandOutcome` error
    // path (§5.5) over human Ink rendering.
    const commandStart = Date.now();
    await runCommandDispatchBoundary({
      dispatch: () => runWithTelemetryContext(() => program.parseAsync()),
      actionScope: commandActionScopeRunner,
      presentError: (error) =>
        handleParseError(error, {
          setExitCode: ctx.setExitCode,
          render: renderResult,
          jsonRequested,
        }),
      disposeAmbientScope: disposeCurrentScope,
    });
    // Phase 2: command duration histogram. The label is the RESOLVED command name
    // (stamped by the pre-action hook), not raw `process.argv[2]` — a typo, flag,
    // or path as argv[2] would otherwise blow up the metric's label cardinality.
    const durationMs = Date.now() - commandStart;
    getMeter('opensip-cli').createHistogram('opensip_cli.command.duration_ms').record(durationMs, {
      command: resolvedCommandLabel(),
    });
  } catch (error) {
    // Bootstrap/registration failures happen outside Commander's action
    // pipeline. Machine callers still receive the same structured bootstrap
    // outcome and canonical typed exit code as pre-action failures. Preserve
    // the established human fatal presentation for non-JSON callers. In both
    // cases presentation completes while the discovery reader is live, then
    // the adjacent finally releases it.
    if (jsonRequested) {
      await handleParseError(startupFailureAsBootstrapError(error), {
        setExitCode: (code) => {
          process.exitCode = code;
        },
        render: renderResult,
        jsonRequested: true,
      });
    } else {
      handleFatalBootstrapError(error, logger);
    }
  } finally {
    // Parse/help/bootstrap failures may occur before preAction transfers the
    // startup reader into the command lifecycle. The handoff is idempotent and
    // becomes a no-op after a successful transfer.
    startupRuntimeLease?.releaseStartupOwned();
  }
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
  disposeCurrentScope();
  // Flush batched spans before the short-lived process exits — on normal
  // completion and on handled error exits alike. No-op when telemetry was
  // never started (standalone), so standalone runs pay nothing. The zero-arg
  // welcome-screen return above runs no commands and emits no spans; keeping the
  // flush path uniform is harmless.
  await shutdownTelemetry();
}
