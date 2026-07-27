/**
 * @fileoverview Scanner-report ingestion for the external-tool run loop: turn a
 * scanner's native output (SARIF / JSON / stdout) into normalized `Signal[]`, and
 * read + classify a FILE-backed report's validity (A11). Extracted from
 * `run-loop.ts` so the run loop keeps only the process-orchestration concern; this
 * module owns "read + parse the report".
 */

import { ToolError } from '@opensip-cli/core';

import { externalToolErrorCatalog } from './errors/external-tool-error-catalog.js';
import { safeParseJson } from './ingest-json.js';
import { acceptSarifDocument, ingestSarif } from './ingest-sarif.js';
import { redactCredentials } from './redact.js';

import type { AdapterRunContext, ExternalCommandSpec, ParsedScannerOutput } from './types.js';
import type { Signal } from '@opensip-cli/core';

const ARTIFACT_INVALID = externalToolErrorCatalog.require('EXTERNAL.SCANNER.ARTIFACT_INVALID');

/** Trailing stderr bytes preserved on an artifact/exit fault (credential-redacted). */
export const STDERR_TAIL = 2000;

/**
 * Parse native output into signals (SARIF via shared ingest; JSON/stdout via the descriptor).
 *
 * For `output.kind === 'sarif'`, applies {@link acceptSarifDocument} **before**
 * tolerant {@link ingestSarif} (OBS-SARIF): structurally invalid SARIF faults with
 * `EXTERNAL.SCANNER.ARTIFACT_INVALID` instead of a silent 0-signal clean pass under exit 0.
 */
export function parseSignals(
  command: ExternalCommandSpec,
  raw: string,
  ctx: AdapterRunContext,
): readonly Signal[] {
  if (command.output.kind === 'sarif') {
    return parseSarifSignals(raw, ctx.tool);
  }
  if (command.parse === undefined) return [];
  const json = command.output.kind === 'json' ? safeParseJson(raw) : undefined;
  const payload: ParsedScannerOutput = {
    kind: command.output.kind,
    raw,
    ...(json?.ok === true ? { json: json.value } : {}),
  };
  return command.parse(payload, ctx);
}

/**
 * Accept + ingest SARIF for the run-loop boundary. Throws
 * `EXTERNAL.SCANNER.ARTIFACT_INVALID` when JSON is invalid or the document fails
 * structural acceptance.
 */
export function parseSarifSignals(raw: string, tool: string): readonly Signal[] {
  const parsed = safeParseJson(raw);
  if (!parsed.ok) {
    throw new ToolError(
      `${tool} produced no usable sarif report (report unparseable).`,
      ARTIFACT_INVALID.code,
    );
  }
  const accepted = acceptSarifDocument(parsed.value);
  if (!accepted.ok) {
    throw new ToolError(
      `${tool} produced no usable sarif report (report structure: ${accepted.reason}).`,
      ARTIFACT_INVALID.code,
    );
  }
  return ingestSarif(accepted.log, { source: tool });
}

/** Why a file-backed scanner report is unusable (A11). */
export type ArtifactInvalidReason = 'missing' | 'oversize' | 'empty' | 'unparseable';

export interface ReportRead {
  readonly raw: string;
  readonly artifactValid: boolean;
  readonly invalidReason?: ArtifactInvalidReason;
}

/** Narrow IO port for {@link readReportArtifact} — a structural subset of `ScanLoopDeps`. */
export interface ArtifactIo {
  readonly fileSize: (path: string) => number;
  readonly readFile: (path: string) => string;
  readonly maxBuffer: number;
}

/**
 * Read a FILE-backed scanner report and classify its validity (A11). Size-guarded:
 * an over-cap report (OOM guard) is never read into memory. Returns the reason a
 * report is unusable so the caller can fault with a size-distinguished message and
 * never overwrite the on-disk report with an empty/truncated buffer.
 */
export function readReportArtifact(path: string, io: ArtifactIo): ReportRead {
  let size = -1;
  try {
    size = io.fileSize(path);
  } catch {
    return { raw: '', artifactValid: false, invalidReason: 'missing' };
  }
  if (size > io.maxBuffer) return { raw: '', artifactValid: false, invalidReason: 'oversize' };
  let raw: string;
  try {
    raw = io.readFile(path);
  } catch {
    return { raw: '', artifactValid: false, invalidReason: 'missing' };
  }
  if (raw.length === 0) return { raw, artifactValid: false, invalidReason: 'empty' };
  if (!safeParseJson(raw).ok) return { raw, artifactValid: false, invalidReason: 'unparseable' };
  return { raw, artifactValid: true };
}

/**
 * A11: build the typed `EXTERNAL.SCANNER.ARTIFACT_INVALID` fault for an unusable file-backed
 * report, distinguishing the oversize-cap case from missing/empty/unparseable. An
 * error FACTORY (not a thrower) — the caller `throw`s it, which keeps the failure
 * unmistakable at the call site.
 */
export function invalidArtifactFault(
  tool: string,
  command: ExternalCommandSpec,
  read: ReportRead,
  maxBuffer: number,
  stderr: string,
): ToolError {
  const maxMiB = Math.floor(maxBuffer / (1024 * 1024));
  const detail =
    read.invalidReason === 'oversize'
      ? `report exceeded the ${String(maxMiB)} MiB cap`
      : `report ${read.invalidReason ?? 'invalid'}`;
  return new ToolError(
    `${tool} produced no usable ${command.output.kind} report (${detail}).`,
    ARTIFACT_INVALID.code,
    { stderrTail: redactCredentials(stderr.slice(-STDERR_TAIL)) },
  );
}
