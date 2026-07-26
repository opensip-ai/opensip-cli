import { ValidationError } from '@opensip-cli/core';

import { sessionStoreErrorCatalog } from './errors/session-store-error-catalog.js';
import { isResolvableStoredRunId } from './run-write-shapes.js';


// Plan 01: 22 literals become five registered definitions; the branch lives in metadata.
const READ_BOUND = sessionStoreErrorCatalog.require('SESSION.READ.BOUND_INVALID');
const WRITE_INVALID = sessionStoreErrorCatalog.require('SESSION.WRITE.RECORD_INVALID');

/** Default newest-first parent-Run page size. */
export const DEFAULT_PARENT_RUN_LIST_LIMIT = 20;
/** Default deterministic RunStep page size. */
export const DEFAULT_PARENT_RUN_STEP_LIMIT = 100;
/** Hard cap for any parent-Run or RunStep read page. */
export const MAX_PARENT_RUN_READ_LIMIT = 500;
/** Default canonical byte budget for exact parent-Run evidence. */
export const DEFAULT_PARENT_RUN_EVIDENCE_BYTE_BUDGET = 8 * 1024 * 1024;
/** Hard canonical byte budget for exact parent-Run evidence. */
export const MAX_PARENT_RUN_EVIDENCE_BYTE_BUDGET = 8 * 1024 * 1024;

/** @throws {ValidationError} When a parent-Run identity is not safely resolvable. */
export function requireRunId(value: unknown): string {
  if (!isResolvableStoredRunId(value)) {
    throw new ValidationError(
      'Parent Run ID must contain 1-128 letters, numbers, underscores, or hyphens.',
      { code: WRITE_INVALID.code, definition: WRITE_INVALID, metadata: { field: 'run-id' } },
    );
  }
  return value;
}

/** @throws {ValidationError} When a RunStep offset is outside the bounded range. */
export function requireOffset(value: number): number {
  const maximum = Number.MAX_SAFE_INTEGER - MAX_PARENT_RUN_READ_LIMIT;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ValidationError(
      `Parent Run step offset must be a non-negative integer no greater than ${String(maximum)}.`,
      {
        code: READ_BOUND.code,
        definition: READ_BOUND,
        metadata: { field: 'offset' },
      },
    );
  }
  return value;
}

/** @throws {ValidationError} When a requested read limit is outside its bounded range. */
export function requirePositiveLimit(
  value: number,
  maximum: number,
  code: string,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ValidationError(`${label} must be an integer between 1 and ${String(maximum)}.`, {
      code,
    });
  }
  return value;
}

/** Recursively freeze a bounded read projection before it crosses the package boundary. */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
