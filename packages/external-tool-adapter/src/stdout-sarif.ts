import { ToolError } from '@opensip-cli/core';

import { safeParseJson } from './ingest-json.js';
import { ingestSarif } from './ingest-sarif.js';

import type { SarifLog } from './ingest-sarif.js';
import type { Signal } from '@opensip-cli/core';

export interface ParseStdoutSarifOptions {
  readonly source: string;
}

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
