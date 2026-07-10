/** Pure DTO projections shared by the SQLite graph read operations. */

import { toGraphSymbolRef, type GraphSymbolRef } from '@opensip-cli/graph/read';

import type { DeadCodeDto } from './graph-read-port.js';
import type { Signal } from '@opensip-cli/core';
import type { FunctionOccurrence, Indexes } from '@opensip-cli/graph';

/** Project one graph occurrence into the public symbol DTO (or undefined if malformed). */
export function toSymbolRef(occurrence: FunctionOccurrence): GraphSymbolRef | undefined {
  return toGraphSymbolRef(occurrence);
}

/** Map a `graph:orphan-subtree` signal to a {@link DeadCodeDto} without filesystem reads. */
export function toDeadCodeDto(signal: Signal, indexes: Indexes): DeadCodeDto | undefined {
  const code = signal.code;
  if (code?.file === undefined || code.line === undefined || code.column === undefined) {
    return undefined;
  }
  const occurrence = indexes.byOccId.get(
    `${code.file}:${String(code.line)}:${String(code.column)}`,
  );
  if (occurrence === undefined) return undefined;
  const symbol = toSymbolRef(occurrence);
  if (symbol === undefined) return undefined;
  return { symbol, message: signal.message };
}

/** Total out-edge count across the callees adjacency. */
export function edgeCount(indexes: Indexes): number {
  let total = 0;
  for (const targets of indexes.callees.values()) total += targets.length;
  return total;
}

/** Clamp a caller-supplied limit to a positive integer, defaulting when absent. */
export function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.trunc(limit);
}
