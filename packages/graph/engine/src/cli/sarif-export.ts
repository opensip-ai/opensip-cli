/**
 * @fileoverview `sarif-export` subcommand mode helper (DEC-498, opensip
 * Phase 2/Phase 6).
 *
 * Runs the graph pipeline's findings through the OpenSIP-convention SARIF
 * renderer (`renderSarifOpenSip`, aliased `renderSarif`) and writes the
 * SARIF v2.1.0 document to the `--output-sarif <path>` file. The opensip
 * `EngineSubprocessPort.runSarifExport` invokes this per commit-sync /
 * dead-code run, then lands the file on opensip's `SarifProvider`.
 *
 * Sibling of `runCatalogJsonMode` (`graph-modes.ts`): same throw-and-catch
 * style (rethrows typed errors for the top-level `handleGraphError`), same
 * synchronous file write (bounded payload; want disk backpressure rather
 * than a deferred-write surprise).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { EXIT_CODES } from '@opensip-tools/contracts';
import { ConfigurationError, logger, readPackageVersion } from '@opensip-tools/core';

import { renderSarif } from '../render/sarif.js';

import type { Signal, ToolCliContext } from '@opensip-tools/core';

const MODULE_GRAPH_RENDER = 'graph:render';

/** Options consumed by the `sarif-export` subcommand. */
export interface SarifExportOptions {
  readonly outputSarif: string;
  readonly tenantId?: string;
  readonly repoId?: string;
  readonly runId?: string;
}

/**
 * Render the engine's findings as OpenSIP-convention SARIF and write them
 * to `opts.outputSarif`. Validates the provenance flags the consumer
 * contract requires (`--tenant-id`, `--repo-id`) so a misinvocation fails
 * loudly (exit 2) rather than emitting an unscoped file.
 *
 * `tenantId` / `repoId` are not embedded in the SARIF body today — the
 * `renderSarifOpenSip` shape carries no `properties` bag — but they are
 * required at the boundary (the opensip side always supplies them and
 * scopes the ingest by them) and `runId` is threaded into the log line
 * for trace correlation.
 */
export function runSarifExportMode(
  opts: SarifExportOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): void {
  if (typeof opts.tenantId !== 'string' || opts.tenantId.length === 0) {
    throw new ConfigurationError('--output-sarif requires --tenant-id <id>.');
  }
  if (typeof opts.repoId !== 'string' || opts.repoId.length === 0) {
    throw new ConfigurationError('--output-sarif requires --repo-id <id>.');
  }

  const runId = opts.runId ?? randomUUID();
  logger.info({
    evt: 'graph.render.sarif_export.start',
    module: MODULE_GRAPH_RENDER,
    runId,
    output: opts.outputSarif,
  });

  const sarif = renderSarif(signals, {
    tool: 'opensip-tools-graph',
    toolVersion: readPackageVersion(import.meta.url),
  });

  mkdirSync(dirname(opts.outputSarif), { recursive: true });
  writeFileSync(opts.outputSarif, sarif);

  logger.info({
    evt: 'graph.render.sarif_export.complete',
    module: MODULE_GRAPH_RENDER,
    runId,
    output: opts.outputSarif,
    bytes: sarif.length,
    signalCount: signals.length,
  });
  cli.setExitCode(EXIT_CODES.SUCCESS);
}
