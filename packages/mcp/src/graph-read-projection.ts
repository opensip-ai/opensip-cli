/** Pure DTO projections shared by the SQLite graph read operations. */

import { toGraphSymbolRef, type GraphSymbolRef, type Indexes } from '@opensip-cli/graph/read';

import type { DeadCodeDto } from './graph-read-port.js';
import type { Signal } from '@opensip-cli/core';

/** Project one graph occurrence into the public symbol DTO (or undefined if malformed). */
export function toSymbolRef(
  occurrence: Parameters<typeof toGraphSymbolRef>[0],
): GraphSymbolRef | undefined {
  return toGraphSymbolRef(occurrence);
}

/**
 * Map a `graph:orphan-subtree` signal to a {@link DeadCodeDto} without filesystem reads.
 *
 * Signal columns are **1-based** (ADR-0179); catalog `byOccId` keys use parser-native
 * **0-based** occurrence columns. Convert before lookup so dead-code projection
 * still resolves after the Signal base canonicalization.
 */
export function toDeadCodeDto(signal: Signal, indexes: Indexes): DeadCodeDto | undefined {
  const code = signal.code;
  if (code?.file === undefined || code.line === undefined || code.column === undefined) {
    return undefined;
  }
  // Signal.column is 1-based; occurrence identity is 0-based.
  const occurrenceColumn = code.column - 1;
  if (!Number.isFinite(occurrenceColumn) || occurrenceColumn < 0) return undefined;
  const occurrence = indexes.byOccId.get(
    `${code.file}:${String(code.line)}:${String(occurrenceColumn)}`,
  );
  if (occurrence === undefined) return undefined;
  const symbol = toSymbolRef(occurrence);
  if (symbol === undefined) return undefined;
  return {
    symbol,
    message: signal.message,
    ruleId: 'graph:orphan-subtree',
    reason: 'unreachable-from-inferred-entry-point',
    ...(signal.suggestion === undefined ? {} : { suggestion: signal.suggestion }),
  };
}
