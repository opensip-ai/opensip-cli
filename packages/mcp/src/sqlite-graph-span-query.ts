import { err, ok, type Result } from '@opensip-cli/core';
import { compareCodePointStrings } from '@opensip-cli/graph/read';

import { toSymbolRef } from './graph-read-projection.js';
import { readError } from './mcp-error.js';

import type { CatalogGeneration } from './catalog-generation.js';
import type { McpReadError } from './mcp-error.js';
import type { SymbolRef } from './symbol-dto.js';

const MAX_SPAN_CANDIDATES = 500;
const SPAN_SCAN_BATCH_SIZE = 512;

interface SpanProjection {
  readonly candidates: readonly SymbolRef[];
  readonly reasons: readonly string[];
}

function insertBoundedSpanCandidate(selected: SymbolRef[], candidate: SymbolRef): boolean {
  let low = 0;
  let high = selected.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = selected[middle];
    if (
      current !== undefined &&
      compareCodePointStrings(current.symbolId, candidate.symbolId) < 0
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const current = selected[low];
  if (current?.symbolId === candidate.symbolId) return false;
  if (low >= MAX_SPAN_CANDIDATES + 1) return true;
  selected.splice(low, 0, candidate);
  if (selected.length > MAX_SPAN_CANDIDATES + 1) selected.pop();
  return true;
}

function projectSpanOccurrence(
  occurrence: Parameters<typeof toSymbolRef>[0],
  file: string,
  line: number,
  selected: SymbolRef[],
  state: { malformed: boolean },
): number {
  if (occurrence.kind === 'module-init') return 0;
  if (occurrence.filePath !== file || occurrence.line > line || line > occurrence.endLine) return 0;
  const ref = toSymbolRef(occurrence);
  if (ref === undefined) {
    state.malformed = true;
    return 0;
  }
  return insertBoundedSpanCandidate(selected, ref) ? 1 : 0;
}

async function scanShouldStop(visited: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (visited % SPAN_SCAN_BATCH_SIZE !== 0) return signal?.aborted === true;
  await new Promise<void>((resolve) => setImmediate(resolve));
  return signal?.aborted === true;
}

export async function projectSpanCandidates(
  generation: CatalogGeneration,
  file: string,
  line: number,
  signal?: AbortSignal,
): Promise<Result<SpanProjection, McpReadError>> {
  const state = { malformed: false };
  const selected: SymbolRef[] = [];
  let total = 0;
  let visited = 0;
  for (const occurrence of generation.indexes.byOccId.values()) {
    if (signal?.aborted === true) {
      return err(readError('cancelled', 'Symbol location read was cancelled.'));
    }
    visited++;
    total += projectSpanOccurrence(occurrence, file, line, selected, state);
    if (await scanShouldStop(visited, signal)) {
      return err(readError('cancelled', 'Symbol location read was cancelled.'));
    }
  }
  if (signal?.aborted === true) {
    return err(readError('cancelled', 'Symbol location read was cancelled.'));
  }
  return ok({
    candidates: selected.slice(0, MAX_SPAN_CANDIDATES),
    reasons: [
      ...(state.malformed ? ['malformed-symbol-omitted'] : []),
      ...(total > MAX_SPAN_CANDIDATES ? ['span-candidate-cap'] : []),
    ],
  });
}
