// @fitness-ignore-file detached-promises -- the preAction hook is a composition root: its body invokes synchronous bootstrap helpers (mergeConfigDefaults, configureLogger, the checkSchemaVersion/checkNoProject/warnAboutPhantom bailout guards, enterScope) that the name-based heuristic mistakes for promise-returning calls. The one genuine async call (maybeInitializeOwningTool) is awaited. Matches the same suppression on index.ts and bootstrap/index.ts.
/**
 * pre-action-hook — Commander `preAction` body.
 *
 * Runs before every subcommand's action. Centralises run-id generation,
 * config-merge, project-context resolution, schema-version bailout, and
 * (only when the run will proceed) log file initialisation. Datastore is
 * NOT opened here — that's a lazy getter on ToolCliContext (Task 1.3).
 *
 * Ordering is load-bearing: side effects only fire AFTER all bailout
 * decisions. Sequence:
 *
 *   1. generate runId
 *   2. read opts; resolve project context (pure; may throw on strict --config)
 *   3. expose context on opts.projectContext (collision-free name)
 *   4. bailout window — schema check (Phase 6.3), phantom warn (Phase 7)
 *   5. side-effect setup — configureLogger({ logDir }) + setProjectContextForRun
 *      gated on project.scope === 'project' && existsSync(projectRoot)
 *   6. Project: header (Phase 2.2)
 *   7. cli.start log line
 *   8. lazy Tool.initialize() — run the owning tool's optional one-time
 *      init exactly once per process, after the scope is entered and just
 *      before the action body (P1a). CLI-only commands have no owner and
 *      skip it; a failing init is fatal.
 *
 * Strict --config: when `--config <path>` doesn't resolve, the
 * underlying ValidationError surfaces with exit 2 — no silent walk-up.
 */

import { existsSync } from "node:fs";

import {
  configureLogger,
  currentScope,
  enterScope,
  generatePrefixedId,
  logger,
  resolveProjectContext,
  resolveProjectPaths,
  SystemError,
  type LanguageRegistry,
  type ProjectContext,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from "@opensip-cli/core";
import { getMeter } from "@opensip-cli/core";

import { startProfiling } from "../telemetry/profiling.js";
import { checkForUpdate, formatUpdateNag } from "../update-notifier.js";

import { BootstrapError } from "./bootstrap-error.js";
import { buildPerRunScope } from "./build-per-run-scope.js";
import { loadCliDefaults, mergeConfigDefaults } from "./cli-defaults.js";
import { loadOwningToolCapabilities } from "./load-tool-capabilities.js";
import {
  checkNoProjectAndBailout,
  checkSchemaVersionAndBailout,
  warnAboutPhantomRuntimes,
} from "./pre-action-guards.js";
import { initializedToolIds } from "./process-idempotency.js";

import type { Command } from "commander";

/** npm package whose version the update check compares against. */
const CLI_PACKAGE_NAME = "opensip-cli";

const MODULE_TAG = "cli:bootstrap";

/**
 * Process-scoped idempotency for Tool.initialize() (see process-idempotency.ts).
 * The Set is intentionally process-scoped per the Tool contract ("at most once per process").
 * Resets are called on per-invocation context setup to prevent leakage.
 *
 * GA Low hygiene: centralized in process-idempotency.ts for better isolation and auditability.
 */

// Re-export the reset for consumers that imported it from here (e.g. cli-context.ts for per-invocation resets).

/**
 * Find the registered tool that owns the invoked subcommand, matching the
 * descriptor's canonical name or any alias. Returns undefined for
 * CLI-only commands (init/sessions/configure/plugin/...) — they belong to
 * no tool, so no `initialize()` runs for them.
 */
export function resolveOwningTool(
  tools: ToolRegistry,
  cmdName: string,
): Tool | undefined {
  return tools
    .list()
    .find((tool) =>
      tool.commands.some(
        (c) => c.name === cmdName || (c.aliases?.includes(cmdName) ?? false),
      ),
    );
}

/**
 * Lazy, memoized Tool.initialize() (P1a). Resolve the tool owning the
 * invoked subcommand and run its initialize() exactly once per process,
 * after the scope is entered and immediately before the action body. Tools
 * not invoked this run pay nothing; `--help`/welcome run no initialize().
 *
 * Fail-fast: a throwing initialize() fails the run closed rather than letting a
 * half-initialised tool run its command and silently appear to work. The
 * id is recorded only on success, so a transient failure can retry in a
 * long-lived host. Extracted from the hook body to keep its complexity
 * within budget.
 *
 * @throws {BootstrapError} (exit 1) when the owning tool's initialize() throws —
 *   the top-level boundary renders it (human stderr / structured `--json`).
 */
async function maybeInitializeOwningTool(
  tools: ToolRegistry,
  cmdName: string,
  runId: string,
): Promise<void> {
  const owningTool = resolveOwningTool(tools, cmdName);
  if (!owningTool?.initialize) return;
  const toolHumanId = owningTool.metadata.name ?? owningTool.metadata.id;
  if (initializedToolIds.has(toolHumanId)) return;
  try {
    await owningTool.initialize();
    initializedToolIds.add(toolHumanId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({
      evt: "cli.tool.initialize_failed",
      module: MODULE_TAG,
      runId,
      toolId: owningTool.metadata.id, // stable UUID for structured
      toolName: toolHumanId,
      error: msg,
    });
    // §4.7: a tool-init failure becomes a typed BootstrapError (exit 1) the
    // top-level boundary renders, instead of an inline stderr write + exit.
    throw new BootstrapError({
      message: `Tool '${toolHumanId}' failed to initialize: ${msg}`,
      humanMessage: `✗ Tool '${toolHumanId}' failed to initialize: ${msg}`,
      suggestion: undefined,
      exitCode: 1,
    });
  }
}

/**
 * The `scope.configDocument` slot value (ADR-0023 one-reader): the validated
 * document rides the scope so tools project their shapes from it instead of
 * re-reading the file — but ONLY when a real config file was read. A
 * config-less run stays document-less so tools that hard-error on a missing
 * config (fitness) stay loud instead of silently validating `{}`.
 */

/**
 * The per-invocation bootstrap result the hook needs to BUILD the scope —
 * the populated registries plus the admitted-tool manifests/provenance. These
 * are created in `main()` BEFORE the scope can be constructed (the registries
 * are inputs to `RunScope`; you can't read them off a scope that doesn't exist
 * yet), so the composition root captures them in this closure and hands them to
 * `installPreActionHook`. After the hook calls `enterScope`, every per-run read
 * (project, datastore, manifests, provenance, …) goes through `currentScope()`
 * — there is NO module-global handoff bag (the former `currentRuntimeContext`).
 */
export interface PreActionRuntime {
  readonly languages: LanguageRegistry;
  readonly tools: ToolRegistry;
  readonly manifests: readonly ToolPluginManifest[];
  readonly provenance: readonly ToolProvenance[];
}

/**
 * Mount the bootstrap `preAction` hook on the supplied program.
 *
 * @param program The root Commander program.
 * @param version The CLI version (from `readPackageVersion` at the entry
 *   point). Threaded in rather than re-read here so the `mini` banner shows
 *   the SAME version `--version` reports — and so the kernel-adjacent hook
 *   doesn't resolve cli-ui's or its own package version by mistake.
 * @param runtime The bootstrap result (registries + admitted manifests/
 *   provenance). Captured in the hook closure instead of read from a module
 *   global — the composition root installs the hook AFTER `bootstrapCli`
 *   populates the registries (see {@link PreActionRuntime}).
 */
// The body (including the preAction hook arrow it registers) sequences the full
// per-invocation bootstrap: runId, defaults merge, project resolve + bailouts,
// scope construction/enter, metrics, profiling start, lazy tool init, capability
// drive. It has many explicit early-exit paths by design (the documented contract
// for "only side effects after all bailouts"). Cognitive complexity exceeds 15
// because it is the single source of truth for ordering; splitting would obscure
// the load-bearing sequence and duplicate the guard/enter wiring. Acceptable for
// this composition root (see similar disables on other bootstrap entry points).
/* eslint-disable sonarjs/cognitive-complexity */
export function installPreActionHook(
  program: Command,
  version: string,
  runtime: PreActionRuntime,
): void {
  program.hook("preAction", async (_thisCommand, actionCommand) => {
    const runId = generatePrefixedId("run");

    const opts = actionCommand.opts();
    const cwd = (opts.cwd as string) ?? process.cwd();
    const cwdExplicit = actionCommand.getOptionValueSource("cwd") === "cli";

    // Keep the loaded defaults around: `mergeConfigDefaults` only copies the
    // flag-shaped fields onto opts, but `ui.banner` has no flag — we read it
    // straight off the config object below to build the UiContext.
    const cliDefaults = loadCliDefaults(cwd, opts.config as string | undefined);
    mergeConfigDefaults(opts, cliDefaults);

    // Single bootstrap-time configuration of the process-wide logger
    // singleton. Replaces the four prior free mutators (`setSilent`,
    // `setDebugMode`, `setRunId`, `initLogFile`). `logDir` is wired in
    // below once the project context is resolved — at that point the
    // logsDir is known and we apply a second `configureLogger` to fill
    // it in. The two-call sequence is intentional: silencing stderr
    // before the project-resolve step is what makes Ink renders clean
    // even when the project is missing.
    configureLogger({
      silent: true,
      debugMode: Boolean(opts.debug),
      runId,
    });

    // 2. Resolve the project context — pure, no side effects.
    //    Strict --config: throws ValidationError when explicit path misses.
    let project: ProjectContext;
    try {
      project = resolveProjectContext({
        cwd,
        cwdExplicit,
        explicitConfigPath: opts.config as string | undefined,
      });
    } catch (error) {
      // §4.7: a config-resolve failure (e.g. strict --config miss) becomes a typed
      // BootstrapError the top-level boundary renders — human stderr / structured
      // --json — instead of an inline stderr write + process.exit.
      const msg = error instanceof Error ? error.message : String(error);
      throw new BootstrapError({
        message: msg,
        humanMessage: `✗ ${msg}`,
        suggestion: "Check opensip-cli.config.yml (or your --config path).",
        exitCode: 2,
      });
    }

    // 3. Stash the context on opts under the COLLISION-FREE name.
    //    `opts.project` is reserved for Commander's --project [path] flag
    //    in uninstall.ts; we never use that name here.
    (opts as Record<string, unknown>).projectContext = project;
    // Stash the resolved "was --cwd typed on the CLI?" signal alongside it,
    // so the `init` command-spec handler (launch Phase 6) reads ONE
    // source instead of recomputing `getOptionValueSource('cwd')` on its own
    // Commander command. `actionCommand` IS the init command here, so this is
    // byte-identical to the former register-init computation.
    (opts as Record<string, unknown>).cwdExplicit = cwdExplicit;

    // 4. Bailout window — each may THROW a BootstrapError (rendered by the
    //    top-level boundary) before any side effects. Phantom warn is non-fatal;
    //    warns then continues.
    checkSchemaVersionAndBailout(project, runId);

    // Build the effective set of project-agnostic command names from the base list
    // PLUS any tool CommandSpecs that declare scope: 'none'. This makes the
    // declared `CommandSpec.scope` drive enforcement (previously the hardcoded
    // name list made the field dead for tools and third-party commands).
    const extraAgnostic = new Set<string>();
    for (const tool of runtime.tools.list()) {
      for (const c of tool.commands || []) {
        if (c.scope === "none") {
          extraAgnostic.add(c.name);
          (c.aliases ?? []).forEach((a: string) => extraAgnostic.add(a));
        }
      }
    }
    checkNoProjectAndBailout(
      project,
      cwd,
      actionCommand.name(),
      runId,
      extraAgnostic,
    );
    warnAboutPhantomRuntimes(project, opts.json === true);

    // 5. Side-effect setup, gated on a real project being present.
    if (project.scope === "project" && existsSync(project.projectRoot)) {
      const projectPaths = resolveProjectPaths(project.projectRoot);
      // Second configureLogger call — fills in the project-scoped logDir
      // now that the project context is resolved. Leaves silent/debugMode/runId
      // untouched (configureLogger only writes fields present in the bag).
      configureLogger({ logDir: projectPaths.logsDir });
    }

    // Build the per-run RunScope and enter it via AsyncLocalStorage so
    // library functions deep in the call tree (currentScope() readers)
    // see the bound logger/registries/project + a lazy datastore thunk.
    // enterWith propagates forward through the same async chain, so the
    // action body invoked after this hook sees the same scope without
    // needing a callback wrapper — which Commander does not expose.
    // (Phase 5 deferred Task 5.2 / T1 Item D close-out.)
    // Resolve presentation + update state once, before the scope is built.
    // bannerSize: explicit `cli.ui.banner`, else the product default `mini`.
    // update: the cached newer-version string (best-effort; undefined when
    // up-to-date / opted-out / non-TTY). The `mini` banner shows it inline;
    // other sizes — and the banner-less `--json` path — fall back to the
    // stderr nag so the signal is never silently lost.
    const bannerSize = cliDefaults.ui?.banner ?? "mini";
    const update = checkForUpdate({ name: CLI_PACKAGE_NAME, version });
    if (update && (bannerSize !== "mini" || opts.json === true)) {
      process.stderr.write(formatUpdateNag(version, update));
    }

    // ADR-0008: select the cloud signal sink for this run. Sync + cheap —
    // keyless / `cloud.sync:false` / `--no-cloud` / non-https → no-op with no
    // IO; the entitlement check is deferred to first emit so non-signal
    // commands pay nothing. `opts.cloud === false` comes from `--no-cloud`.
    //
    // `cloud` layers the user-level opt-out (~/.opensip-cli/config.yml#cloud)
    // over the project's `cli.cloud:` block (audit P0-2): a user `sync: false`
    // disables sync for every project on this machine.
    const { languages, tools, manifests, provenance } = runtime;

    // Extracted to thin the composition root (GA architectural blocker #2).
    // All scope construction + wiring now lives in a dedicated small builder
    // with explicit inputs. The hook remains the high-level sequencer. The
    // registries + admitted-tool manifests/provenance come from the closure
    // the composition root captured (no module-global handoff bag); the
    // builder stamps manifests/provenance onto the scope for host commands.
    const scope = buildPerRunScope({
      project,
      runId,
      cwd,
      cliDefaults,
      registries: { languages, tools },
      manifests,
      provenance,
      apiKey: opts.apiKey as string | undefined,
      // @fitness-ignore-next-line null-safety -- Commander's optsWithGlobals() always returns an OptionValues object (never null/undefined); the heuristic misreads the method-call-then-property access. `.cloud` is an absent-or-boolean flag, compared with `=== false`.
      noCloud: actionCommand.optsWithGlobals().cloud === false,
      logger,
      ui: { version, update },
    });

    enterScope(scope);

    // Phase 3 hygiene: scope entry via ALS (enterScope) is now the single source of truth
    // for per-run state. No holder mirror or mark dance. All subsequent readers (including
    // host command bodies) must see a valid currentScope().
    if (!currentScope()) {
      throw new SystemError("Scope was not entered before command dispatch", {
        code: "SYSTEM.SCOPE.NOT_ENTERED",
      });
    }

    // Lifecycle diagnostics (§5.10): record key construction facts on the per-run bus.
    // These (plus the per-domain events emitted from loadCapabilityDomain and the
    // wiring events from buildPerRunScope) ride on every CommandOutcome so --json
    // consumers see the full uniform lifecycle (tools loaded, subscopes contributed,
    // capability domains wired + driven, config validated, etc.). This directly
    // improves observability of the blast-radius bootstrap paths (architecture review).
    scope.diagnostics.event(
      "load",
      "debug",
      `${tools.list().length} tool(s) loaded`,
    );
    scope.diagnostics.counter("tools.loaded", tools.list().length);

    // Phase 2 metrics (low cardinality)
    getMeter("opensip-cli")
      .createCounter("opensip_cli.commands.started")
      .add(1, {
        command: actionCommand.name(),
      });
    scope.diagnostics.event(
      "validate",
      "debug",
      `project config resolved (scope: ${project.scope})`,
    );

    // The `ℹ Project:` location line is rendered once, under the banner,
    // by cli-ui's ProjectHeader — mounted by the App shell (static
    // commands, via render.ts reading currentScope().project) and by each
    // live view (fit/graph). No imperative pre-action print.

    // Structured start log.
    logger.info({
      evt: "cli.run.start",
      module: MODULE_TAG,
      runId,
      command: actionCommand.name(),
      cwd,
      projectRoot: project.projectRoot,
      scope: project.scope,
    });

    if (project.walkedUp > 0) {
      logger.info({
        evt: "cli.project.discovered",
        module: MODULE_TAG,
        runId,
        cwd,
        projectRoot: project.projectRoot,
        walkedUp: project.walkedUp,
      });
    }

    // Optional profiling (Phase 3, severable). Start after scope (runId available).
    // Respects the dual-gate (OPENSIP_PROFILING + OTEL) or OTEL-only fallback.
    startProfiling(scope, actionCommand.name());

    // 8. Lazy, memoized Tool.initialize() — runs the owning tool's
    //    optional one-time init here, AFTER enterScope (so eager setup that
    //    registers packs / reads currentScope() sees the bound scope) and
    //    immediately before Commander invokes the action body. See the
    //    helper for the once-per-process + fail-fast semantics.
    await maybeInitializeOwningTool(tools, actionCommand.name(), runId);

    // 9. §5.3/§4.5: drive the generic capability loader for the invoked tool's
    //    declared domains (e.g. graph-adapter). Lazy per command — only the
    //    owning tool's domains load, routed through the host's capability
    //    registry to each owner's registrar. Replaces the host-coupled,
    //    eager register-graph-adapters.ts.
    const driven = await loadOwningToolCapabilities({
      owningTool: resolveOwningTool(tools, actionCommand.name()),
      projectDir: project.projectRoot,
      configPath: project.scope === "project" ? project.configPath : undefined,
    });
    if (driven > 0) {
      scope.diagnostics.event(
        "load",
        "debug",
        `drove ${String(driven)} owning-tool capability domain(s) (see per-domain 'capability ... loaded' events for contribution counts + errors)`,
      );
      scope.diagnostics.counter("capabilities.driven", driven);
    }
  });

  // Resilience: best-effort release of per-run resources (parseCache, recipe config slot,
  // contributed sub-scopes, diagnostics bus) after the action body completes for every
  // command. Complements the narrow dispose() impl and the current lack of finally in
  // many paths. postAction fires for normal completion; error paths are covered by
  // handleParseError + handleFatalBootstrapError (which may also dispose in future passes).
  // Idempotent: dispose is cheap and safe to call more than once.
  program.hook("postAction", async () => {
    try {
      const s = currentScope();
      if (s && typeof s.dispose === "function") {
        s.dispose();
      }
    } catch {
      // Swallow dispose errors on shutdown; the run has already produced its outcome.
    }
  });
}
/* eslint-enable sonarjs/cognitive-complexity */
