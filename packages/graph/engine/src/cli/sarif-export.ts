/**
 * @fileoverview `sarif-export` subcommand mode helper (DEC-498, opensip
 * Phase 2/Phase 6).
 *
 * Builds the run's signal envelope (applying the OpenSIP rule-ID convention —
 * Option A — at assembly) and writes the SARIF v2.1.0 document to the
 * `--output-sarif <path>` file via the root-owned SARIF-file sink
 * (`cli.writeSarif`, ADR-0011 Phase 5). The opensip
 * `EngineSubprocessPort.runSarifExport` invokes this per commit-sync /
 * dead-code run, then lands the file on opensip's `SarifProvider`. Its
 * external behavior (the `--output-sarif` flag, byte-identical OpenSIP SARIF)
 * is unchanged: the canonical signal → SARIF formatter (`formatSignalSarif` in
 * `@opensip-cli/output`) emits the same bytes graph's former adapter did
 * once the envelope carries the OpenSIP-mapped rule IDs.
 *
 * Per ADR-0011 (file is a sink; the root renders/delivers), SARIF-to-file is a
 * root seam — graph no longer imports `@opensip-cli/output`. Validates the
 * provenance flags the consumer contract requires (`--tenant-id`/`--repo-id`)
 * so a misinvocation fails loudly (exit 2) rather than emitting an unscoped
 * file.
 */

import { randomUUID } from 'node:crypto';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { ConfigurationError, logger } from '@opensip-cli/core';

import { buildGraphEnvelope } from './build-envelope.js';

import type { Signal, ToolCliContext } from '@opensip-cli/core';

const MODULE_GRAPH_RENDER = 'graph:render';

/** Options consumed by the `sarif-export` subcommand. */
export interface SarifExportOptions {
  readonly outputSarif: string;
  readonly tenantId?: string;
  readonly repoId?: string;
  readonly runId?: string;
}

/**
 * Build the OpenSIP-convention SARIF envelope from the engine's findings and
 * write it to `opts.outputSarif` through the root-owned `cli.writeSarif` seam.
 *
 * `tenantId` / `repoId` are not embedded in the SARIF body today — the SARIF
 * shape carries no `properties` bag — but they are required at the boundary
 * (the opensip side always supplies them and scopes the ingest by them) and
 * `runId` is threaded into the log line for trace correlation.
 */
export async function runSarifExportMode(
  opts: SarifExportOptions,
  signals: readonly Signal[],
  cli: ToolCliContext,
): Promise<void> {
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

  // Option A: the envelope's signals carry the OpenSIP-mapped rule IDs, so the
  // shared `formatSignalSarif` (behind `cli.writeSarif`) emits the same SARIF
  // bytes graph's former adapter produced. `runId`/`createdAt` are SARIF-body-
  // irrelevant for this formatter, so deterministic placeholders are fine.
  const envelope = buildGraphEnvelope({
    signals,
    runId,
    createdAt: new Date().toISOString(),
  });
  await cli.writeSarif(envelope, opts.outputSarif);

  logger.info({
    evt: 'graph.render.sarif_export.complete',
    module: MODULE_GRAPH_RENDER,
    runId,
    output: opts.outputSarif,
    signalCount: signals.length,
  });
  cli.setExitCode(EXIT_CODES.SUCCESS);
}
