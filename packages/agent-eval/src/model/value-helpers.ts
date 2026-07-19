import type { AnswerFact } from './task.js';

/** A JSON-like object whose fields have not yet been validated. */
export type UnknownRecord = Readonly<Record<string, unknown>>;

/** Narrow an unknown value to a non-array object. */
export function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a JSON object without letting malformed response bytes escape as an exception. */
export function parseJsonRecord(text: string): UnknownRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return isUnknownRecord(parsed) ? parsed : undefined;
}

/** Recursively freeze authored task data while preserving its inferred type. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const child of Object.values(current as Readonly<Record<string, unknown>>)) {
      if (typeof child === 'object' && child !== null) pending.push(child);
    }
    if (!Object.isFrozen(current)) Object.freeze(current);
  }
  return value;
}

/** Retain the first occurrence of each structurally identical normalized fact. */
export function uniqueFacts(facts: readonly AnswerFact[]): readonly AnswerFact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = JSON.stringify(fact);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Deduplicate strings while preserving their first-observed order. */
export function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Return whether every string occurs exactly once. */
export function stringsAreUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Escape one literal for interpolation into a JavaScript regular expression. */
export function escapeRegularExpression(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
}

/** Compare strings by Unicode code point without locale-dependent collation. */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  for (;;) {
    const leftStep = leftPoints.next();
    const rightStep = rightPoints.next();
    if (leftStep.done || rightStep.done) {
      if (leftStep.done === rightStep.done) return 0;
      return leftStep.done ? -1 : 1;
    }
    const leftPoint = leftStep.value.codePointAt(0) ?? 0;
    const rightPoint = rightStep.value.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
}

/** Truncate a string to a byte ceiling without returning malformed UTF-8. */
export function boundedUtf8Prefix(text: string, maximumBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maximumBytes) return text;
  let prefix = bytes.subarray(0, maximumBytes).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > maximumBytes) prefix = prefix.slice(0, -1);
  return prefix;
}
