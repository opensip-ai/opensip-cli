import { ToolError } from '@opensip-cli/core';

import { safeParseJson } from './ingest-json.js';
import { ingestSarif } from './ingest-sarif.js';

import type { SarifLog } from './ingest-sarif.js';
import type { Signal } from '@opensip-cli/core';

/** Options for {@link parseStdoutSarif}: `source` names the emitting scanner for signal attribution and error text. */
export interface ParseStdoutSarifOptions {
  readonly source: string;
}

/**
 * Parse a SARIF log a scanner wrote to stdout into {@link Signal}s. Throws a
 * `ToolError` with code `ADAPTER.ARTIFACT.INVALID` when the stdout is not valid
 * JSON; otherwise ingests it as SARIF attributed to `opts.source`.
 */
export function parseStdoutSarif(raw: string, opts: ParseStdoutSarifOptions): readonly Signal[] {
  const parsed = safeParseJson(raw);
  if (!parsed.ok) {
    throw new ToolError(
      `${opts.source} produced invalid SARIF on stdout: ${parsed.error}`,
      'ADAPTER.ARTIFACT.INVALID',
    );
  }
  return ingestSarif(parsed.value as SarifLog, { source: opts.source });
}
