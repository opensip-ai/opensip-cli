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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  currentScope,
  resolveProjectPaths,
  resolveToolHooks,
  SystemError,
  type Tool,
  type ToolProvenance,
  logger as defaultLogger,
} from '@opensip-cli/core';
import {
  generateDashboardHtml,
  type DashboardInput as HtmlReportInput,
} from '@opensip-cli/dashboard';
import { SessionRepo } from '@opensip-cli/session-store';

import { dispatchExternalToolHook } from './bootstrap/dispatch-external-tool-hook.js';
import { type DispatchHostCtx } from './bootstrap/dispatch-replay-result.js';
import {
  isExternalToolProvenance,
  provenanceRecordFor,
  shouldRunHookInHost,
} from './bootstrap/tool-provenance.js';
import { buildHostDispatchCtx, getCurrentProjectRoot } from './cli-context.js';
import { launchReport } from './open-report.js';

import type { ReportResult } from '@opensip-cli/contracts';
import type { DataStore } from '@opensip-cli/datastore';

/**
 * Host-reserved top-level dashboard-input key a tool's `collectReportData` must
 * never set: `sessions` is the durable cross-tool run history the host owns. A
 * tool that returns it is ignored (best-effort) with a warning.
 */
const RESERVED_DASHBOARD_KEYS = new Set(['sessions']);

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
async function composeReportInput(): Promise<HtmlReportInput> {
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
  const sessions = repo ? [...repo.list({ limit: 20 })] : [];

  const input: HtmlReportInput = { sessions };

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
    // @fitness-ignore-next-line detached-promises -- mergeContribution returns void (a synchronous Object.assign + warn); the name-based heuristic misfires on a bare call statement.
    mergeContribution(input, contribution, tool, log);
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
        module: 'cli:report',
        tool: tool.metadata.id,
        msg: 'No host context to fork the report-data worker for an external tool; skipping its contribution.',
      });
    }
    return undefined;
  }
  try {
    const cwd = getCurrentProjectRoot();
    const result = await dispatchExternalToolHook({
      provenance: record,
      hook: 'collectReportData',
      cwd,
      ctx: hostCtx,
    });
    return (result ?? undefined) as Record<string, unknown> | undefined;
  } catch (error) {
    void log.warn({
      evt: 'cli.report.compose.external_hook_failed',
      module: 'cli:report',
      tool: tool.metadata.id,
      error: error instanceof Error ? error.message : String(error),
      msg: 'External tool report-data worker failed; its contribution is omitted (the report still renders).',
    });
    // @fitness-ignore-next-line error-handling-quality -- the failure IS logged via log.warn just above; an external report-data worker fault is best-effort by contract (parity with a tool that omits collectReportData): the report still renders for every other tool. NEVER an in-host fallback (that would run untrusted code).
    return undefined;
  }
}

/** Merge one tool's report contribution into the input, guarding reserved host keys. */
function mergeContribution(
  input: HtmlReportInput,
  contribution: Record<string, unknown> | undefined,
  tool: Tool,
  log: typeof defaultLogger,
): void {
  if (!contribution) return;
  // Guardrail (spec §8): tools must never clobber the host-owned `sessions` run
  // history. Ignore with a warning (best-effort) — the host owns the history.
  const reserved = Object.keys(contribution).filter((k) => RESERVED_DASHBOARD_KEYS.has(k));
  if (reserved.length > 0) {
    void log.warn({
      evt: 'cli.report.compose.reserved_key_ignored',
      module: 'cli:report',
      tool: tool.metadata.id,
      keys: reserved,
      msg: 'Tool collectReportData returned a reserved host key; it was ignored.',
    });
    for (const k of reserved) delete contribution[k];
  }
  Object.assign(input, contribution);
}

/**
 * Compose the cross-tool report, write it to
 * `<reportsDir>/latest.html`, and (optionally) open it in the browser.
 *
 * Returns a `ReportResult` describing the written path and whether a
 * browser was launched. Browser-launch failures never propagate — they
 * fall through to `opened: false` so the user can open the file manually.
 */
export async function composeAndWriteReport(opts: { open: boolean }): Promise<ReportResult> {
  const input = await composeReportInput();
  const html = generateDashboardHtml(input);

  const paths = resolveProjectPaths(getCurrentProjectRoot());
  mkdirSync(paths.reportsDir, { recursive: true });
  const reportPath = join(paths.reportsDir, 'latest.html');
  writeFileSync(reportPath, html, 'utf8');

  const opened = opts.open ? await launchReport(reportPath) : false;

  return { type: 'report', path: reportPath, opened };
}
