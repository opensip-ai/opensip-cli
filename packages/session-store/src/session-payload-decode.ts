/**
 * session-payload-decode — the shared, generic decoder for a stored session's
 * opaque `payload` blob (the inverse of each tool's `build*SessionPayload`).
 *
 * Session replay needs every tool (`fit`/`graph`/`sim`)
 * to read a persisted session back into a {@link SignalEnvelope} projection. The
 * persisted detail shares ONE structural shape — `{ summary, checks[] }`, each
 * check a `{ checkSlug, passed, violationCount?, durationMs, findings[] }` — so
 * the decode of THAT structure lives here once, parameterised by the few
 * per-tool differences (error-label, whether `filePath`/`violationCount` are
 * required, whether findings carry a metadata bag).
 *
 * This holds NO tool vocabulary: it does not know about fit checks, graph rules,
 * severity→category mapping, or signal IDs. Those projections stay in each
 * engine's `session-replay.ts` (`replaySignal`). What lives here is purely the
 * structural shape session-store persists — a faithful counterpart to the
 * package's opaque-payload charter: session-store owns persistence AND the
 * structural decode for replay, while tool semantics remain in the engines.
 *
 * The decoder tolerates legacy payloads that lack a top-level `__version`
 * (treated as v1 with best-effort projection). Tools should prefer their own
 * `*ReplayFromSession` functions (which call this decoder) for full projection
 * to their live result types; this module only gives the common structural
 * skeleton + the detected `payloadVersion` when present.
 */

import { extractPayloadVersion } from '@opensip-cli/core';

import type { SignalEnvelope } from '@opensip-cli/contracts';

/** JSON-safe scalar — the metadata-value subset the persisted shape permits. */
export type SessionPayloadScalar = string | number | boolean;

/** A decoded finding row — the structural superset across all tools. */
export interface DecodedSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  readonly metadata?: Readonly<Record<string, SessionPayloadScalar>>;
}

/** A decoded per-check row. */
export interface DecodedSessionCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly durationMs: number;
  readonly findings: readonly DecodedSessionFinding[];
}

/** The decoded session payload — `summary` + rule/check-grouped `checks[]`. */
export interface DecodedSessionPayload {
  readonly summary: SignalEnvelope['verdict']['summary'];
  readonly checks: readonly DecodedSessionCheck[];
  /**
   * Detected inner `__version` from the opaque tool payload (or undefined for
   * legacy pre-__version rows, which callers treat as v1 with projection).
   * This is the value of the top-level numeric key if present and valid.
   */
  readonly payloadVersion?: number;
}

/** Per-tool decode options — the only points where the tools' payloads differ. */
export interface DecodeSessionPayloadOptions {
  /** Tool label used in error messages (e.g. `'fit'`). */
  readonly tool: string;
  /** When true, every finding must carry a string `filePath` (graph). */
  readonly requireFilePath?: boolean;
  /** When true, every check must carry a numeric `violationCount` (graph/sim). */
  readonly requireViolationCount?: boolean;
  /** When true, decode each finding's scalar `metadata` bag (graph). */
  readonly allowMetadata?: boolean;
}

/**
 * Decode a stored session payload into its structural {@link DecodedSessionPayload}.
 *
 * @param payload - the opaque `StoredSession.payload` blob.
 * @param opts - per-tool decode options (label + required-field toggles).
 * @returns the decoded `{ summary, checks[] }` structure, plus `payloadVersion`
 *   (the detected inner `__version` if present and valid; undefined for legacy
 *   payloads that pre-date the convention — callers treat missing as v1).
 * @throws {TypeError} when `payload`/`checks`/`findings` are not the expected
 *   object/array shapes.
 * @throws {Error} when a required scalar field is missing or mistyped, or a
 *   finding severity is not `error`/`warning`.
 */
export function decodeSessionPayload(
  payload: unknown,
  opts: DecodeSessionPayloadOptions,
): DecodedSessionPayload {
  if (payload === null || typeof payload !== 'object') {
    throw new Error(`${opts.tool} session has no replay payload`);
  }
  const candidate = payload as { summary?: unknown; checks?: unknown };
  const summary = decodeSummary(candidate.summary, `${opts.tool} session summary`);
  if (!Array.isArray(candidate.checks)) {
    throw new TypeError(`${opts.tool} session payload is missing checks[]`);
  }
  const payloadVersion = extractPayloadVersion(payload);
  return {
    summary,
    checks: candidate.checks.map((check) => decodeCheck(check, opts)),
    ...(payloadVersion === undefined ? {} : { payloadVersion }),
  };
}

/**
 * Decode the `summary` verdict-counts block.
 *
 * @throws {Error} when the value is missing or any count is not a number.
 */
export function decodeSummary(value: unknown, label: string): SignalEnvelope['verdict']['summary'] {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${label} is missing`);
  }
  const summary = value as Record<string, unknown>;
  return {
    total: numberField(summary, 'total', label),
    passed: numberField(summary, 'passed', label),
    failed: numberField(summary, 'failed', label),
    errors: numberField(summary, 'errors', label),
    warnings: numberField(summary, 'warnings', label),
  };
}

/**
 * Decode one check row.
 *
 * @throws {Error} when the row is not an object or a required field is mistyped.
 * @throws {TypeError} when `findings` is not an array.
 */
function decodeCheck(value: unknown, opts: DecodeSessionPayloadOptions): DecodedSessionCheck {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${opts.tool} session check row is invalid`);
  }
  const check = value as Record<string, unknown>;
  const label = `${opts.tool} session check`;
  const checkSlug = stringField(check, 'checkSlug', label);
  let violationCount: number | undefined;
  if (opts.requireViolationCount) {
    violationCount = numberField(check, 'violationCount', label);
  } else if (typeof check.violationCount === 'number') {
    violationCount = check.violationCount;
  }
  if (!Array.isArray(check.findings)) {
    throw new TypeError(`${opts.tool} session check ${checkSlug} is missing findings[]`);
  }
  return {
    checkSlug,
    passed: booleanField(check, 'passed', label),
    ...(violationCount === undefined ? {} : { violationCount }),
    durationMs: numberField(check, 'durationMs', label),
    findings: check.findings.map((finding) => decodeFinding(finding, opts)),
  };
}

/**
 * Decode one finding row.
 *
 * @throws {Error} when the row is not an object, a required string is mistyped,
 *   or the severity is not `error`/`warning`.
 */
function decodeFinding(value: unknown, opts: DecodeSessionPayloadOptions): DecodedSessionFinding {
  if (value === null || typeof value !== 'object') {
    throw new Error(`${opts.tool} session finding is invalid`);
  }
  const finding = value as Record<string, unknown>;
  const label = `${opts.tool} session finding`;
  const severity = finding.severity;
  if (severity !== 'error' && severity !== 'warning') {
    throw new Error(`${opts.tool} session finding has invalid severity`);
  }
  const filePath = opts.requireFilePath
    ? stringField(finding, 'filePath', label)
    : optionalString(finding.filePath);
  const line = optionalNumber(finding.line);
  const column = optionalNumber(finding.column);
  const suggestion = optionalString(finding.suggestion);
  const metadata = opts.allowMetadata ? decodeMetadata(finding.metadata) : undefined;
  return {
    ruleId: stringField(finding, 'ruleId', label),
    message: stringField(finding, 'message', label),
    severity,
    ...(filePath === undefined ? {} : { filePath }),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** Narrow an open metadata bag to its scalar subset; undefined when nothing survives. */
function decodeMetadata(
  value: unknown,
): Readonly<Record<string, SessionPayloadScalar>> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const out: Record<string, SessionPayloadScalar> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      out[key] = entry;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** @throws {Error} when the field is not a number. */
export function numberField(source: Record<string, unknown>, field: string, label: string): number {
  const value = source[field];
  if (typeof value !== 'number') throw new Error(`${label}.${field} must be a number`);
  return value;
}

/** @throws {Error} when the field is not a string. */
export function stringField(source: Record<string, unknown>, field: string, label: string): string {
  const value = source[field];
  if (typeof value !== 'string') throw new Error(`${label}.${field} must be a string`);
  return value;
}

/** @throws {Error} when the field is not a boolean. */
export function booleanField(
  source: Record<string, unknown>,
  field: string,
  label: string,
): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') throw new Error(`${label}.${field} must be a boolean`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
