import { isUnknownRecord as isRecord } from '../model/value-helpers.js';

import type { UnknownRecord } from '../model/value-helpers.js';

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sourceCoordinate(value: unknown, minimum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

/** Validate the complete public GraphSymbolRef boundary before attesting lossless projection. */
export function isGraphSymbolProjection(symbol: unknown): symbol is UnknownRecord {
  if (!isRecord(symbol)) return false;
  return (
    nonEmptyString(symbol.symbolId) &&
    nonEmptyString(symbol.bodyHash) &&
    nonEmptyString(symbol.simpleName) &&
    nonEmptyString(symbol.qualifiedName) &&
    nonEmptyString(symbol.filePath) &&
    sourceCoordinate(symbol.line, 1) &&
    sourceCoordinate(symbol.column, 0) &&
    nonEmptyString(symbol.kind) &&
    nonEmptyString(symbol.visibility) &&
    nonEmptyString(symbol.package) &&
    typeof symbol.inTestFile === 'boolean' &&
    typeof symbol.definedInGenerated === 'boolean'
  );
}

/** Require a complete, unpaged node-detail search response before it can close a proof domain. */
export function isCompleteSymbolSearchProjection(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.data)) return false;
  const { data } = payload;
  return (
    data.detail === 'nodes' &&
    Array.isArray(data.symbols) &&
    data.symbols.every(isGraphSymbolProjection) &&
    sourceCoordinate(data.totalMatches, 0) &&
    data.totalMatches === data.symbols.length
  );
}
