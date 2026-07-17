import { isPlainRecord, tryCatch } from '@opensip-cli/core';

/** Package-private primitives for validating mapped rows before any write lock. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isFiniteNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isJsonSerializable(value: unknown): boolean {
  const serialized = tryCatch(() => JSON.stringify(value));
  return serialized.ok && serialized.value !== undefined;
}

export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && isJsonSerializable(value);
}

export function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    isPlainRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string') &&
    isJsonSerializable(value)
  );
}
