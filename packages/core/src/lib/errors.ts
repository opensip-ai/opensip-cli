/**
 * Typed error classes and Result pattern for opensip-cli.
 */

import { type ErrorDefinition, definitionFromLegacyCode } from './error-definition.js';

// =============================================================================
// ERROR CLASSES
// =============================================================================

/**
 * Closed union of canonical error codes carried by `ToolError` and its
 * subclasses. Open by intent at the consumer layer — callers may pass
 * any string in `ToolErrorOptions.code` (subclass-specific subcodes
 * like `'VALIDATION.RECIPE.DUPLICATE'` are common) — but the base
 * default for each subclass is one of these literals, which means an
 * `instanceof` check pairs naturally with an exhaustive switch on
 * `code` for the no-override case.
 */
export type ToolErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'SYSTEM_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'CONFIGURATION_ERROR'
  | 'PLUGIN_INCOMPATIBLE'
  | 'UNKNOWN_LIVE_VIEW';

/** Structural brand version for cross-copy recognition (not instanceof-only). */
export const TOOL_ERROR_BRAND_VERSION = 1;
const TOOL_ERROR_BRAND = Symbol.for('@opensip-cli/core/tool-error-brand');

const MAX_METADATA_KEYS = 32;
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_STRING = 2048;
const MAX_STDERR_TAIL = 4096;

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|api[_-]?key|cookie|credential|private[_-]?key/i;

/** Constructor options for {@link ToolError}: `code` plus bounded diagnostic metadata. */
export interface ToolErrorOptions extends ErrorOptions {
  code?: string;
  /** Supervisor/worker failure taxonomy (ADR-0054 resource-control diagnostics). */
  failureClass?: string;
  /** Truncated child stderr tail for operator triage on worker fault. */
  stderrTail?: string;
  /**
   * Bounded JSON-safe diagnostic metadata. Sensitive keys are stripped.
   * Prefer catalog `publicMetadataKeys` for anything that may leave the process.
   */
  metadata?: Readonly<Record<string, unknown>>;
  /**
   * Optional resolved definition for legacy subclass constructors
   * (`new NotFoundError(msg, { definition, metadata })`).
   */
  definition?: ErrorDefinition;
  /**
   * Legacy open bag — preserved only in {@link ToolError.legacyCompatibility}
   * during migration; never treated as safe metadata. Marked for Plan 01 removal.
   */
  [key: string]: unknown;
}

/**
 * Sanitize unknown metadata into a plain, bounded, JSON-safe object.
 * Hostile getters/cycles become sentinels; sensitive keys are dropped.
 */
export function sanitizeErrorMetadata(
  input: unknown,
  depth = 0,
): Readonly<Record<string, unknown>> {
  if (depth > MAX_METADATA_DEPTH || input === null || typeof input !== 'object') {
    return Object.freeze({});
  }
  /** @type {Record<string, unknown>} */
  const out: Record<string, unknown> = {};
  let count = 0;
  try {
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (count >= MAX_METADATA_KEYS) break;
      if (SENSITIVE_KEY.test(key)) continue;
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      const sanitized = sanitizeMetadataValue(value, depth + 1);
      if (sanitized === undefined) continue;
      out[key.slice(0, 64)] = sanitized;
      count += 1;
    }
  } catch {
    return Object.freeze({ _meta: 'hostile-metadata' });
  }
  return Object.freeze(out);
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, MAX_METADATA_STRING);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_METADATA_DEPTH) return '[TruncatedArray]';
    return Object.freeze(
      value.slice(0, 32).map((item) => sanitizeMetadataValue(item, depth + 1) ?? null),
    );
  }
  if (typeof value === 'object') {
    return sanitizeErrorMetadata(value, depth);
  }
  return undefined;
}

function isErrorDefinition(value: unknown): value is ErrorDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ErrorDefinition).code === 'string' &&
    typeof (value as ErrorDefinition).source === 'string' &&
    typeof (value as ErrorDefinition).kind === 'string' &&
    typeof (value as ErrorDefinition).exitClass === 'string'
  );
}

/** Base class for all opensip-cli errors; carries a `code` for programmatic dispatch. */
export class ToolError extends Error {
  /**
   * Error code. Typed as a `string` super-set of `ToolErrorCode` because
   * subclass call sites may opt into a more specific subcode via
   * `ToolErrorOptions.code` (e.g. `'VALIDATION.RECIPE.DUPLICATE'`). For
   * exhaustive-switch use cases, narrow with the `ToolErrorCode` union
   * after an `instanceof` check.
   */
  readonly code: string;
  /** Resolved immutable definition (legacy codes map through the core adapter). */
  readonly definition: ErrorDefinition;
  /** Machine-filterable failure class when the error originated at a worker boundary. */
  readonly failureClass?: string;
  /** Captured child stderr tail (truncated) when available. */
  readonly stderrTail?: string;
  /** Bounded JSON-safe metadata retained for diagnostics (not necessarily public). */
  readonly metadata: Readonly<Record<string, unknown>>;
  /**
   * Unrecognized legacy option fields parked for Plan 01 removal — operator-only,
   * never wire-safe.
   */
  readonly legacyCompatibility?: Readonly<Record<string, unknown>>;

  /**
   * @param messageOrDefinition Human message, or an {@link ErrorDefinition} (new form).
   * @param codeOrMessage Definition form: message. Legacy form: code string.
   * @param options Optional cause/metadata (both forms).
   */
  constructor(
    messageOrDefinition: string | ErrorDefinition,
    codeOrMessage?: string,
    options?: ToolErrorOptions,
  ) {
    const fromDefinition = isErrorDefinition(messageOrDefinition);
    const message = fromDefinition
      ? String(codeOrMessage ?? messageOrDefinition.code)
      : String(messageOrDefinition);
    const code = fromDefinition
      ? messageOrDefinition.code
      : String(codeOrMessage ?? options?.code ?? 'SYSTEM_ERROR');
    const definition = fromDefinition
      ? messageOrDefinition
      : (options?.definition ?? definitionFromLegacyCode(options?.code ?? code));

    super(message, options);
    this.name = 'ToolError';
    this.code = options?.code ?? code;
    this.definition = definition;
    this.failureClass =
      typeof options?.failureClass === 'string' ? options.failureClass.slice(0, 128) : undefined;
    this.stderrTail =
      typeof options?.stderrTail === 'string'
        ? options.stderrTail.slice(0, MAX_STDERR_TAIL)
        : undefined;

    const known = new Set([
      'code',
      'failureClass',
      'stderrTail',
      'metadata',
      'cause',
      'definition',
    ]);
    /** @type {Record<string, unknown>} */
    const legacy: Record<string, unknown> = {};
    if (options) {
      for (const [key, value] of Object.entries(options)) {
        if (known.has(key)) continue;
        legacy[key] = value;
      }
    }
    this.legacyCompatibility =
      Object.keys(legacy).length > 0 ? sanitizeErrorMetadata(legacy) : undefined;
    this.metadata = sanitizeErrorMetadata(options?.metadata ?? {});

    Object.defineProperty(this, TOOL_ERROR_BRAND, {
      value: TOOL_ERROR_BRAND_VERSION,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  /**
   * Operator-only string form — never wire-safe. Prefer normalized envelope
   * projections for public/persisted/worker sinks (Phase 3).
   */
  override toString(): string {
    return `${this.name} [${this.code}]: ${this.message}`;
  }
}

/**
 * Structural recognition of ToolError across duplicate physical @opensip-cli/core
 * copies. Validates brand version + plain shape; does not trust arbitrary brands.
 */
export function isToolErrorLike(value: unknown): value is ToolError {
  if (value instanceof ToolError) return true;
  if (typeof value !== 'object' || value === null) return false;
  const brand = (value as Record<symbol, unknown>)[TOOL_ERROR_BRAND];
  if (brand !== TOOL_ERROR_BRAND_VERSION) return false;
  const candidate = value as Partial<ToolError>;
  return (
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string' &&
    isErrorDefinition(candidate.definition)
  );
}

/** Preferred constructor: definition + message + options. */
export function createToolError(
  definition: ErrorDefinition,
  message: string,
  options?: ToolErrorOptions,
): ToolError {
  return new ToolError(definition, message, options);
}

/** Thrown when user-supplied input (config, CLI flags, recipes) fails schema or domain validation. */
export class ValidationError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'VALIDATION_ERROR', options);
    this.name = 'ValidationError';
  }
}

/** Thrown when a named resource (check, recipe, file, session) cannot be located. */
export class NotFoundError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'NOT_FOUND', options);
    this.name = 'NotFoundError';
  }
}

/** Thrown for internal invariant violations or unexpected runtime failures. */
export class SystemError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'SYSTEM_ERROR', options);
    this.name = 'SystemError';
  }
}

/** Thrown when an operation exceeds its allotted time budget. */
export class TimeoutError extends ToolError {
  readonly timeoutMs?: number;

  constructor(message: string, timeoutOrOptions?: number | ToolErrorOptions) {
    const options = typeof timeoutOrOptions === 'number' ? undefined : timeoutOrOptions;
    super(message, options?.code ?? 'TIMEOUT', options);
    this.name = 'TimeoutError';
    this.timeoutMs = typeof timeoutOrOptions === 'number' ? timeoutOrOptions : undefined;
  }
}

/** Thrown for HTTP or socket-level failures during outbound requests. */
export class NetworkError extends ToolError {
  readonly statusCode?: number;

  constructor(message: string, options?: ToolErrorOptions & { statusCode?: number }) {
    super(message, options?.code ?? 'NETWORK_ERROR', options);
    this.name = 'NetworkError';
    this.statusCode = options?.statusCode;
  }
}

/** Thrown when project or tool configuration is missing, malformed, or contradictory. */
export class ConfigurationError extends ToolError {
  constructor(message: string, options?: ToolErrorOptions) {
    super(message, options?.code ?? 'CONFIGURATION_ERROR', options);
    this.name = 'ConfigurationError';
  }
}

/**
 * Thrown when a tool plugin is rejected by the compatibility/trust gate
 * (launch) and the rejection must fail the run rather than skip
 * silently — i.e. the tool was explicitly requested but is incompatible,
 * or a project-local executable tool was not allowlisted (deny-by-default).
 *
 * Mapped to `EXIT_CODES.PLUGIN_INCOMPATIBLE` (exit 5) by
 * `mapToolErrorToExitCode` so an incompatible/untrusted plugin is
 * diagnosable from the exit code alone. Carries the structured
 * `diagnostic` the admission gate produced (compatibility reason or the
 * trust-policy message) for surfacing through the CLI error boundary.
 */
export class PluginIncompatibleError extends ToolError {
  /** The admission diagnostic (compatibility reason or trust-policy message). */
  readonly diagnostic?: string;

  constructor(message: string, options?: ToolErrorOptions & { diagnostic?: string }) {
    super(message, options?.code ?? 'PLUGIN_INCOMPATIBLE', options);
    this.name = 'PluginIncompatibleError';
    this.diagnostic = options?.diagnostic;
  }
}

/**
 * Thrown when a contribution is routed to a capability domain that no tool
 * has declared (launch, §5.3). A subclass of {@link NotFoundError}
 * (so existing not-found handling still catches it) that additionally
 * carries the structured diagnostic the capability registry produced: the
 * unknown `domainId` and the set of `knownDomains`. Code defaults to
 * `'CAPABILITY.DOMAIN.UNKNOWN'`.
 */
export class UnknownCapabilityDomainError extends NotFoundError {
  /** The domain id that was routed to but not declared. */
  readonly domainId: string;
  /** The domain ids that ARE declared on the registry (for diagnostics). */
  readonly knownDomains: readonly string[];

  constructor(
    message: string,
    options: ToolErrorOptions & {
      domainId: string;
      knownDomains: readonly string[];
    },
  ) {
    super(message, {
      ...options,
      code: options.code ?? 'CAPABILITY.DOMAIN.UNKNOWN',
    });
    this.name = 'UnknownCapabilityDomainError';
    this.domainId = options.domainId;
    this.knownDomains = options.knownDomains;
  }
}

/**
 * Thrown when a contribution fails the schema check of the capability
 * domain it targets (launch, §5.3). A subclass of
 * {@link ValidationError} that carries the structured diagnostic: the
 * `domainId`, the owning tool's `ownerToolId`, and a human-readable
 * `diagnostic` reason. Code defaults to
 * `'CAPABILITY.CONTRIBUTION.SCHEMA_MISMATCH'`.
 */
export class CapabilitySchemaMismatchError extends ValidationError {
  /** The domain id whose schema the contribution failed. */
  readonly domainId: string;
  /** The tool that owns the targeted domain. */
  readonly ownerToolId: string;
  /** Human-readable reason the contribution failed the schema. */
  readonly diagnostic: string;

  constructor(
    message: string,
    options: ToolErrorOptions & {
      domainId: string;
      ownerToolId: string;
      diagnostic: string;
    },
  ) {
    super(message, {
      ...options,
      code: options.code ?? 'CAPABILITY.CONTRIBUTION.SCHEMA_MISMATCH',
    });
    this.name = 'CapabilitySchemaMismatchError';
    this.domainId = options.domainId;
    this.ownerToolId = options.ownerToolId;
    this.diagnostic = options.diagnostic;
  }
}

/**
 * The canonical exit-class {@link ToolErrorCode} for a typed error, derived by
 * `instanceof` — the inverse of each subclass's default-code policy and the
 * direct counterpart of `mapToolErrorToExitCode`'s instanceof ladder. Subclasses
 * collapse to their canonical parent bucket (e.g. {@link
 * UnknownCapabilityDomainError} → `NOT_FOUND`, {@link
 * CapabilitySchemaMismatchError} → `VALIDATION_ERROR`).
 *
 * This is the discriminator a typed error needs to survive a serialization
 * boundary that flattens its prototype chain (the ADR-0054 worker IPC marshals
 * errors to plain `{ message, code, stack }`): the boundary carries this value
 * and {@link toolErrorFromCanonicalCode} rebuilds the right subclass on the far
 * side, so the frozen exit-code contract is preserved across the fork instead of
 * silently collapsing every worker-thrown typed error to `SystemError` (exit 1).
 */
export function canonicalToolErrorCode(error: ToolError): ToolErrorCode {
  if (error instanceof NotFoundError) return 'NOT_FOUND';
  if (error instanceof ConfigurationError) return 'CONFIGURATION_ERROR';
  if (error instanceof ValidationError) return 'VALIDATION_ERROR';
  if (error instanceof NetworkError) return 'NETWORK_ERROR';
  if (error instanceof PluginIncompatibleError) return 'PLUGIN_INCOMPATIBLE';
  if (error instanceof TimeoutError) return 'TIMEOUT';
  return 'SYSTEM_ERROR';
}

/**
 * Rebuild the canonical {@link ToolError} subclass from a {@link
 * canonicalToolErrorCode} value — the inverse direction, used at the parent side
 * of a serialization boundary (the ADR-0054 worker IPC) to restore a typed
 * error's exit class. `options.code` (when supplied) overrides the subclass
 * default so the original subcode (e.g. `CONFIGURATION.GATE.BASELINE_MISSING`)
 * round-trips onto the rebuilt instance for diagnostics.
 *
 * Returns `undefined` for an unrecognized code so the caller can fall through to
 * its own default (the SystemError → exit 1 fallback).
 */
export function toolErrorFromCanonicalCode(
  code: string,
  message: string,
  options?: ToolErrorOptions,
): ToolError | undefined {
  switch (code) {
    case 'NOT_FOUND': {
      return new NotFoundError(message, options);
    }
    case 'CONFIGURATION_ERROR': {
      return new ConfigurationError(message, options);
    }
    case 'VALIDATION_ERROR': {
      return new ValidationError(message, options);
    }
    case 'NETWORK_ERROR': {
      return new NetworkError(message, options);
    }
    case 'PLUGIN_INCOMPATIBLE': {
      return new PluginIncompatibleError(message, options);
    }
    case 'TIMEOUT': {
      return new TimeoutError(message, options);
    }
    case 'SYSTEM_ERROR': {
      return new SystemError(message, options);
    }
    default: {
      return undefined;
    }
  }
}

/** Extract a bounded display/log message from an unknown throwable. */
export function formatUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// =============================================================================
// RESULT PATTERN
// =============================================================================

export type Result<T, E = ToolError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

/** Constructs a success {@link Result} carrying `value`. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Constructs a failure {@link Result} carrying `error`. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Wraps an async function in a try/catch, returning a Result instead of throwing. */
export async function tryCatchAsync<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Wraps a sync function in a try/catch, returning a Result instead of throwing. */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
