import { parseSarifSignals } from './run-loop-ingest.js';

import type { Signal } from '@opensip-cli/core';

/** Options for {@link parseStdoutSarif}: `source` names the emitting scanner for signal attribution and error text. */
export interface ParseStdoutSarifOptions {
  readonly source: string;
}

/**
 * Parse a SARIF log a scanner wrote to stdout into {@link Signal}s. Throws a
 * `ToolError` with code `ADAPTER.ARTIFACT.INVALID` when the stdout is not valid
 * JSON or fails run-loop SARIF acceptance (OBS-SARIF); otherwise ingests it as
 * SARIF attributed to `opts.source`.
 */
export function parseStdoutSarif(raw: string, opts: ParseStdoutSarifOptions): readonly Signal[] {
  return parseSarifSignals(raw, opts.source);
}
