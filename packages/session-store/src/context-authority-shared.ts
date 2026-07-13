import type { TaskContextPlaneKind } from '@opensip-cli/contracts';

export const GRAPH_TOOL_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';
export const GRAPH_TOOL_NAME = 'graph';
export const EVIDENCE_SCHEMA_VERSION = 1;
export const CAP_REASON = /(?:^|[-_.])(?:cap|limit|truncat(?:ed|ion)?)(?:$|[-_.])/iu;
const CONTEXT_RUN_ID = /^RUN_[0-9A-HJKMNP-TV-Z]{26}$/u;
const CONTEXT_STEP_ID = /^STEP_[0-9A-HJKMNP-TV-Z]{26}$/u;
export const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/u;

export type EvidenceStatus =
  'rebuilt' | 'reused' | 'partial' | 'unsupported' | 'failed' | 'cancelled';

export const EVIDENCE_STATUSES: ReadonlySet<string> = new Set([
  'rebuilt',
  'reused',
  'partial',
  'unsupported',
  'failed',
  'cancelled',
]);

export const PLANE_AUTHORITY: Readonly<
  Record<TaskContextPlaneKind, { readonly command: string; readonly ordinal: number }>
> = Object.freeze({
  inventory: { command: 'graph-context-inventory', ordinal: 0 },
  graph: { command: 'graph-context-ensure', ordinal: 1 },
  'test-selection': { command: 'graph-context-select-tests', ordinal: 2 },
});

export function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  const expected = new Set(allowed);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

export function exactOptionalKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

export function boundedControlFreeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}

export function safeRunId(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT_RUN_ID.test(value);
}

export function safeStepId(value: unknown): value is string {
  return typeof value === 'string' && CONTEXT_STEP_ID.test(value);
}

export function safeDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
