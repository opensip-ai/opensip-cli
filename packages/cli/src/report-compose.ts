/**
 * report-compose — the cross-tool report composition root.
 *
 * Audit 2026-05-29 (L2): the CLI, not any single tool, composes the HTML
 * report. It walks every registered tool's `collectReportData(scope)`
 * contribution and merges the results into one HTML report input, then
 * renders the self-contained HTML via `@opensip-cli/dashboard` and
 * writes it to the project's reports directory.
 *
 * This is what decouples fitness from graph: fitness contributes only
 * its own catalogs (`checkCatalog` / `recipeCatalog` / `editorProtocol`)
 * and graph contributes only `graphCatalog`. Neither reaches into the
 * other; the CLI owns the merge because composition needs the tool
 * REGISTRY (`RunScope.tools`), which the tool-facing `ToolScope`
 * deliberately excludes.
 *
 * Why read `currentScope()` here and nowhere in the tool packages: the
 * `Tool` contract must not depend on `RunScope` (that would reintroduce
 * a kernel⟷tool cycle). The CLI is the only layer allowed to read the
 * concrete `RunScope` (which has `.tools`) — tools receive the narrower
 * `ToolScope` view as the `collectReportData` parameter.
 */

import { basename, join } from 'node:path';

import {
  currentScope,
  resolveToolHooks,
  SystemError,
  type Tool,
  type ToolProvenance,
  logger as defaultLogger,
} from '@opensip-cli/core';
import {
  encodeReportViewSelection,
  generateDashboardHtml,
  normalizeReportViewSelection,
  type DashboardInput as HtmlReportInput,
  type ReportViewSelection,
} from '@opensip-cli/dashboard';
import { orderSessionsForSuiteGrouping, RunRepo, SessionRepo } from '@opensip-cli/session-store';

import { writeArtifactAtomically } from './bootstrap/atomic-artifact-write.js';
import { bindToolCliContext } from './bootstrap/bind-tool-context.js';
import { collectDeclaredInputsForTool } from './bootstrap/declared-inputs.js';
import { dispatchExternalToolHook } from './bootstrap/dispatch-external-tool-hook.js';
import { type DispatchHostCtx } from './bootstrap/dispatch-replay-result.js';
import { resolveStateLockPolicy } from './bootstrap/state-lock-policy.js';
import {
  isExternalToolProvenance,
  provenanceRecordFor,
  shouldRunHookInHost,
} from './bootstrap/tool-provenance.js';
import {
  buildHostDispatchCtx,
  getCurrentProjectRoot,
  getCurrentRuntimePaths,
} from './cli-context.js';
import { buildReportLaunchTarget, launchReport } from './open-report.js';

import type { ReportResult, StoredRunStep } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

/**
 * Host-reserved top-level dashboard-input keys a tool's `collectReportData`
 * must never set. Sessions/runs are durable cross-tool history and selection is
 * host-owned navigation. A tool that returns one is ignored with a warning.
 */
const RESERVED_DASHBOARD_KEYS = new Set(['runs', 'selection', 'sessions']);
const UNSAFE_DASHBOARD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const REPORT_MODULE = 'cli:report';

interface ComposeReportOptions {
  readonly open: boolean;
  readonly selection?: ReportViewSelection;
  /**
   * Byte budget for the inlined graph catalog. Omitted ⇒ the dashboard's
   * shareable default. Raised by `opensip report --max-catalog-mb` when the
   * reader wants the full catalog for LOCAL exploration rather than a report
   * small enough to send someone.
   */
  readonly maxGraphCatalogBytes?: number;
}

/**
 * Build the merged HTML report input from every registered tool's
 * report-data contribution, on top of the shared session history.
 *
 * Sessions come from the CLI (cross-tool history); each tool's
 * `collectReportData` returns its own keyed inputs which are merged
 * onto the base via `Object.assign`. Contributions are best-effort: a
 * tool that omits `collectReportData`, or returns an empty object,
 * simply contributes nothing.
 *
 * @throws {Error} When called outside an entered `RunScope` (i.e. not inside
 *   a CLI action body), since session history and tool contributions both
 *   require the scope.
 */
async function composeReportInput(selection?: ReportViewSelection): Promise<HtmlReportInput> {
  const scope = currentScope();
  if (!scope) {
    // Use a typed error with code so the top-level handler + --json paths
    // produce a clean, consistent failure instead of a raw Error.
    throw new SystemError(
      'report composition requires an entered RunScope (run inside a CLI action body).',
      { code: 'SYSTEM.SCOPE.NOT_ENTERED' },
    );
  }

  const log = scope.logger ?? defaultLogger;
  const datastore = scope.datastore() as DataStore | undefined;
  const repo = datastore ? new SessionRepo(datastore) : undefined;
  const runRepo = datastore ? new RunRepo(datastore) : undefined;
  const sessions = repo ? orderSessionsForSuiteGrouping([...repo.list({ limit: 20 })]) : [];
  // ADR-0144 Strategy A: sessions stay raw; the dashboard client labels
  // duration/score via @opensip-cli/format — do not embed labels here.
  const recentRuns = runRepo ? [...runRepo.listRuns({ limit: 20 })] : [];
  const stepsByRun: ReadonlyMap<string, readonly StoredRunStep[]> = runRepo
    ? runRepo.listStepsForRuns(recentRuns.map((run) => run.id))
    : new Map<string, readonly StoredRunStep[]>();

  const normalizedSelection = normalizeReportViewSelection(selection);
  const requestedRunId = normalizedSelection?.runId;
  const matchedStoredRun =
    requestedRunId !== undefined && recentRuns.some((run) => run.id === requestedRunId);
  const resolvedSelection =
    normalizedSelection === undefined
      ? undefined
      : ({
          view: normalizedSelection.view,
          ...(matchedStoredRun ? { runId: requestedRunId } : {}),
        } satisfies ReportViewSelection);
  log.info?.({
    evt: 'cli.report.compose.selection',
    module: REPORT_MODULE,
    view: resolvedSelection?.view ?? 'overview',
    hasRunId: requestedRunId !== undefined,
    matchedStoredRun,
  });

  const input: HtmlReportInput = {
    sessions,
    runs: recentRuns.map((run) => ({
      ...run,
      steps: stepsByRun.get(run.id) ?? [],
    })),
    ...(resolvedSelection === undefined ? {} : { selection: resolvedSelection }),
    declaredInputs: collectDeclaredInputsForTool('report'),
  };
  const claimedKeys = new Map<string, string>();

  const provenance = scope.toolProvenance;
  // Built lazily ONLY when an external tool is encountered (so a bundled-only run
  // never constructs the dispatch ctx). Shared across all external tools this run.
  let hostCtx: DispatchHostCtx | undefined;
  for (const tool of scope.tools.list()) {
    // ADR-0054 M4-F: a BUNDLED tool's collectReportData runs in-host (trusted
    // computing base); an EXTERNAL tool's runs in a forked HOOK worker so its
    // untrusted runtime never executes in the host process.
    let contribution: Record<string, unknown> | undefined;
    if (shouldRunHookInHost(tool, provenance)) {
      contribution = await resolveToolHooks(tool).collectReportData?.(scope);
    } else {
      hostCtx ??= buildHostDispatchCtx(log);
      contribution = await collectExternalReportData(tool, provenance, hostCtx, log);
    }
    mergeContribution(input, contribution, tool, log, claimedKeys);
  }

  return input;
}

/**
 * Gather an EXTERNAL tool's `collectReportData` over a forked hook worker
 * (ADR-0054 M4-F). The worker imports the untrusted runtime, runs the hook
 * against its own re-bootstrapped scope, and returns the plain-data contribution.
 * A fork failure is best-effort: logged + the tool contributes nothing (parity
 * with a tool that omits the hook), NEVER an in-host fallback. Returns `undefined`
 * when there is no host ctx to fork with (the worker needs one to serve any
 * host-RPC upcall the hook makes; without it we skip rather than run in-host).
 */
async function collectExternalReportData(
  tool: Tool,
  provenance: readonly ToolProvenance[],
  hostCtx: DispatchHostCtx | undefined,
  log: typeof defaultLogger,
): Promise<Record<string, unknown> | undefined> {
  const record = provenanceRecordFor(tool, provenance);
  if (
    record === undefined ||
    !isExternalToolProvenance(tool, provenance) ||
    hostCtx === undefined
  ) {
    if (hostCtx === undefined) {
      void log.warn({
        evt: 'cli.report.compose.external_hook_skipped',
        module: REPORT_MODULE,
        tool: tool.metadata.id,
        msg: 'No host context to fork the report-data worker for an external tool; skipping its contribution.',
      });
    }
    return undefined;
  }
  try {
    const cwd = getCurrentProjectRoot();
    const boundHostCtx = bindToolCliContext(tool, hostCtx);
    const result = await dispatchExternalToolHook({
      provenance: record,
      hook: 'collectReportData',
      cwd,
      ctx: boundHostCtx,
    });
    return (result ?? undefined) as Record<string, unknown> | undefined;
  } catch (error) {
    void log.warn({
      evt: 'cli.report.compose.external_hook_failed',
      module: REPORT_MODULE,
      tool: tool.metadata.id,
      error: error instanceof Error ? error.message : String(error),
      msg: 'External tool report-data worker failed; its contribution is omitted (the report still renders).',
    });
    return undefined;
  }
}

/** Merge one tool's report contribution into the input, guarding host and object keys. */
function mergeContribution(
  input: HtmlReportInput,
  contribution: Record<string, unknown> | undefined,
  tool: Tool,
  log: typeof defaultLogger,
  claimedKeys: Map<string, string>,
): void {
  if (!contribution) return;
  const toolId = tool.metadata.name ?? tool.metadata.id;
  // Guardrail (spec §8): tools must never clobber host-owned history or
  // navigation. Prototype-mutating keys are rejected at the same boundary: an
  // external hook can return arbitrary plain data, and `Object.assign` would
  // otherwise invoke Object.prototype.__proto__ and make an inherited
  // `selection` bypass the stored-run match above.
  const blocked = Object.keys(contribution).filter(
    (key) => RESERVED_DASHBOARD_KEYS.has(key) || UNSAFE_DASHBOARD_KEYS.has(key),
  );
  if (blocked.length > 0) {
    void log.warn({
      evt: 'cli.report.compose.reserved_key_ignored',
      module: REPORT_MODULE,
      tool: toolId,
      keys: blocked,
      msg: 'Tool collectReportData returned a reserved or unsafe host key; it was ignored.',
    });
  }
  for (const key of Object.keys(contribution)) {
    if (RESERVED_DASHBOARD_KEYS.has(key) || UNSAFE_DASHBOARD_KEYS.has(key)) continue;
    const otherTool = claimedKeys.get(key);
    if (otherTool !== undefined && otherTool !== toolId) {
      void log.warn({
        evt: 'cli.report.compose.collision',
        module: REPORT_MODULE,
        tool: toolId,
        otherTool,
        key,
        msg: 'Tool collectReportData returned a key already contributed by another tool; first writer wins.',
      });
      continue;
    }
    claimedKeys.set(key, toolId);
    // Define an own data property rather than assigning through an inherited
    // setter. This keeps the merge safe even if the input object's prototype is
    // extended by the embedding application.
    Object.defineProperty(input, key, {
      value: contribution[key],
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
}

/**
 * Compose the cross-tool report, write it to
 * `<reportsDir>/latest.html`, and (optionally) open it in the browser.
 *
 * Returns a `ReportResult` describing the written path and whether a
 * browser was launched. Browser-launch failures never propagate — they
 * fall through to `opened: false` so the user can open the file manually.
 */
export async function composeAndWriteReport(opts: ComposeReportOptions): Promise<ReportResult> {
  const input = await composeReportInput(opts.selection);
  const html = generateDashboardHtml(
    opts.maxGraphCatalogBytes === undefined
      ? input
      : { ...input, maxGraphCatalogBytes: opts.maxGraphCatalogBytes },
  );

  // Scope-aware: an ephemeral (no-init) run must write its report into the user
  // cache, never into the user's repository. Atomic write avoids concurrent
  // audit --open / report races corrupting latest.html mid-write.
  const paths = getCurrentRuntimePaths();
  const reportPath = join(paths.reportsDir, 'latest.html');
  const scope = currentScope();
  const logger = scope?.logger ?? defaultLogger;
  writeArtifactAtomically(reportPath, html, {
    policy: resolveStateLockPolicy(),
    logger,
    runId: scope?.runId,
    command: 'report',
    cwdBasename:
      scope?.projectContext?.projectRoot === undefined
        ? basename(process.cwd())
        : basename(scope.projectContext.projectRoot),
  });

  const fragment =
    input.selection === undefined ? undefined : encodeReportViewSelection(input.selection);
  const launchTarget = buildReportLaunchTarget(reportPath, fragment);
  const opened = opts.open ? await launchReport(launchTarget) : false;

  return { type: 'report', path: reportPath, opened };
}
