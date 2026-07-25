// @fitness-ignore-file file-length-limit -- Kernel error base (ToolError, Result, exit-code mapping) plus its bounded JSON-safe metadata sanitizer are one cohesive unit; modestly over the soft limit. Extracting the sanitizer to a sibling is a reasonable follow-up.
/**
 * Typed error classes and Result pattern for opensip-cli.
 */

import {
  type ErrorCatalogOwner,
  type ErrorDefinition,
  coreSystemErrorCatalog,
  definitionFromLegacyCode,
  normalizeErrorDefinition,
} from './error-definition.js';
import { currentLogger } from './run-scope.js';


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
const MAX_METADATA_NODES = 256;

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|api[_-]?key|cookie|credential|private[_-]?key/i;

const CREDENTIAL_VALUE_PATTERNS: readonly RegExp[] = [
  /:\/\/([^/@\s]+):([^@/\s]+)@/gu,
  /\bbearer\s+[\w.~+/-]+=*/giu,
  /\bx-api-key[\s'":=]+[\w.~+/-]+=*/giu,
  /\b(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;&'"}]+/giu,
  /\b(?:osk_|sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}\b/gu,
];

/** Content-level credential scrubbing shared by metadata and text projections. */
export function redactCredentialText(text: string): string {
  let redacted = text;
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, (match) =>
      match.startsWith('://') ? '://***:***@' : '[redacted]',
    );
  }
  return redacted;
}

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
  const state = { seen: new WeakSet<object>(), remaining: MAX_METADATA_NODES };
  const prepared = prepareMetadataContainer(input, false, depth, state);
  return (
    prepared.ok
      ? sanitizeMetadataChildren(prepared.descriptors, false, depth, state)
      : prepared.value
  ) as Readonly<Record<string, unknown>>;
}

interface MetadataWalkState {
  readonly seen: WeakSet<object>;
  remaining: number;
}

function safeIsArray(value: unknown): boolean | undefined {
  try {
    return Array.isArray(value);
  } catch {
    return undefined;
  }
}

function isSafeMetadataField(key: string, descriptor: PropertyDescriptor): boolean {
  return (
    descriptor.enumerable === true &&
    !SENSITIVE_KEY.test(key) &&
    key !== '__proto__' &&
    key !== 'constructor' &&
    key !== 'prototype'
  );
}

function metadataArrayLength(descriptors: Record<string, PropertyDescriptor>): number {
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    return 0;
  }
  return Math.min(32, Math.max(0, Math.floor(lengthDescriptor.value)));
}

interface PreparedMetadataContainer {
  readonly ok: true;
  readonly descriptors: Record<string, PropertyDescriptor>;
}

interface RejectedMetadataContainer {
  readonly ok: false;
  readonly value: unknown;
}

function metadataContainerSentinel(
  isArray: boolean,
  reason: 'depth' | 'budget' | 'circular' | 'hostile',
): unknown {
  if (isArray) {
    const values = {
      depth: '[TruncatedArray]',
      budget: '[NodeBudgetExhausted]',
      circular: '[Circular]',
      hostile: '[HostileArray]',
    } as const;
    return values[reason];
  }
  const values = {
    depth: {},
    budget: { _meta: 'node-budget-exhausted' },
    circular: { _meta: 'circular' },
    hostile: { _meta: 'hostile-metadata' },
  } as const;
  return Object.freeze(values[reason]);
}

function prepareMetadataContainer(
  value: object,
  isArray: boolean,
  depth: number,
  state: MetadataWalkState,
): PreparedMetadataContainer | RejectedMetadataContainer {
  if (depth > MAX_METADATA_DEPTH) {
    return { ok: false, value: metadataContainerSentinel(isArray, 'depth') };
  }
  if (state.remaining <= 0) {
    return { ok: false, value: metadataContainerSentinel(isArray, 'budget') };
  }
  state.remaining -= 1;
  if (state.seen.has(value)) {
    return { ok: false, value: metadataContainerSentinel(isArray, 'circular') };
  }
  state.seen.add(value);

  try {
    return { ok: true, descriptors: Object.getOwnPropertyDescriptors(value) };
  } catch {
    return { ok: false, value: metadataContainerSentinel(isArray, 'hostile') };
  }
}

interface MetadataChild {
  readonly key: string;
  readonly descriptor?: PropertyDescriptor;
}

function metadataChildren(
  descriptors: Record<string, PropertyDescriptor>,
  isArray: boolean,
): readonly MetadataChild[] {
  const children: MetadataChild[] = [];
  if (isArray) {
    for (let index = 0; index < metadataArrayLength(descriptors); index += 1) {
      children.push({ key: String(index), descriptor: descriptors[String(index)] });
    }
    return children;
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!isSafeMetadataField(key, descriptor)) continue;
    children.push({ key: key.slice(0, 64), descriptor });
    if (children.length >= MAX_METADATA_KEYS) break;
  }
  return children;
}

function sanitizeMetadataChildren(
  descriptors: Record<string, PropertyDescriptor>,
  isArray: boolean,
  depth: number,
  state: MetadataWalkState,
): unknown {
  const output: unknown[] | Record<string, unknown> = isArray ? [] : {};
  for (const child of metadataChildren(descriptors, isArray)) {
    let sanitized: unknown = null;
    if (child.descriptor !== undefined) {
      sanitized =
        'value' in child.descriptor
          ? sanitizeErrorMetadataValue(child.descriptor.value, depth + 1, state)
          : '[Accessor]';
    }
    if (isArray) {
      (output as unknown[]).push(sanitized ?? null);
    } else if (sanitized !== undefined) {
      (output as Record<string, unknown>)[child.key] = sanitized;
    }
  }
  return Object.freeze(output);
}

function sanitizeErrorMetadataValue(
  value: unknown,
  depth: number,
  state: MetadataWalkState,
): unknown {
  if (value === null) return null;
  if (typeof value === 'string') {
    return redactCredentialText(value).slice(0, MAX_METADATA_STRING);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return undefined;
  }
  const isArray = safeIsArray(value);
  if (isArray === undefined) return '[HostileObject]';
  if (typeof value === 'object') {
    const prepared = prepareMetadataContainer(value, isArray, depth, state);
    return prepared.ok
      ? sanitizeMetadataChildren(prepared.descriptors, isArray, depth, state)
      : prepared.value;
  }
  return undefined;
}

interface OwnDataRead {
  readonly ok: boolean;
  readonly value?: unknown;
}

function readOwnData(value: object, key: PropertyKey): OwnDataRead {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return { ok: false };
    return { ok: true, value: descriptor.value };
  } catch {
    return { ok: false };
  }
}

/** Copy and fully validate a definition without trusting branded object getters. */
export function normalizeToolErrorDefinition(value: unknown): ErrorDefinition | undefined {
  if (typeof value !== 'object' || value === null || safeIsArray(value) !== false) return undefined;
  const ownerRead = readOwnData(value, 'owner');
  if (!ownerRead.ok || typeof ownerRead.value !== 'object' || ownerRead.value === null) {
    return undefined;
  }
  const id = readOwnData(ownerRead.value, 'id');
  const displayName = readOwnData(ownerRead.value, 'displayName');
  const packageName = readOwnData(ownerRead.value, 'packageName');
  if (
    !id.ok ||
    typeof id.value !== 'string' ||
    !displayName.ok ||
    typeof displayName.value !== 'string'
  ) {
    return undefined;
  }
  const owner: ErrorCatalogOwner = {
    id: id.value,
    displayName: displayName.value,
    ...(packageName.ok && typeof packageName.value === 'string'
      ? { packageName: packageName.value }
      : {}),
  };
  try {
    return normalizeErrorDefinition(value, owner, { allowLegacyCodes: true });
  } catch {
    // @swallow-ok probe/optional capability: malformed cross-copy definitions fail recognition closed.
    return undefined;
  }
}

function definitionMatchesCode(code: string, definition: ErrorDefinition): boolean {
  if (definition.code === code) return true;
  // Legacy detail codes intentionally carry the canonical family definition
  // (for example CONFIGURATION.GATE.* -> CONFIGURATION_ERROR). No other
  // code/definition mismatch is valid: accepting one would let a forged
  // cross-copy brand pair a public code with unrelated retry/exposure axes.
  return definitionFromLegacyCode(code).code === definition.code;
}

function resolveToolErrorConstruction(
  messageOrDefinition: string | ErrorDefinition,
  codeOrMessage: string | undefined,
  options: ToolErrorOptions | undefined,
): {
  readonly message: string;
  readonly code: string;
  readonly definition?: ErrorDefinition;
  readonly definitionFirst: boolean;
} {
  const normalizedDefinition = normalizeToolErrorDefinition(messageOrDefinition);
  if (normalizedDefinition !== undefined) {
    return {
      message: codeOrMessage ?? normalizedDefinition.code,
      code: normalizedDefinition.code,
      definition: normalizedDefinition,
      definitionFirst: true,
    };
  }
  return {
    message: typeof messageOrDefinition === 'string' ? messageOrDefinition : 'SYSTEM_ERROR',
    code: codeOrMessage ?? options?.code ?? 'SYSTEM_ERROR',
    definition: normalizeToolErrorDefinition(options?.definition),
    definitionFirst: false,
  };
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
    const construction = resolveToolErrorConstruction(messageOrDefinition, codeOrMessage, options);

    super(construction.message, options);
    this.name = 'ToolError';
    // In definition-first form the definition is the authority. Allowing an
    // options.code override creates an impossible code/axes pair on one error.
    this.code = construction.definitionFirst
      ? construction.code
      : (options?.code ?? construction.code);
    this.definition =
      construction.definition !== undefined &&
      definitionMatchesCode(this.code, construction.definition)
        ? construction.definition
        : definitionFromLegacyCode(this.code);
    this.failureClass =
      typeof options?.failureClass === 'string' ? options.failureClass.slice(0, 128) : undefined;
    // Redacted like `metadata`, not merely truncated. A child process's stderr tail is the
    // single most credential-dense field on this type — a failing `git` or scanner routinely
    // echoes a remote URL with an embedded token — and it was reaching persisted logs and
    // worker messages verbatim. D8: one choke point, applied at construction, so no caller
    // has to remember.
    this.stderrTail =
      typeof options?.stderrTail === 'string'
        ? redactCredentialText(options.stderrTail).slice(0, MAX_STDERR_TAIL)
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
    // The open `[key: string]: unknown` bag on ToolErrorOptions is marked for removal, but
    // 41 production files across every wave still populate it, so deleting the field now
    // would break Waves 2-5 rather than migrating them. It warns instead: the residual is
    // visible on every run that hits one, and the field itself is retired in Phase 6 once
    // the last caller moves to bounded `metadata`.
    const legacyKeys = Object.keys(legacy);
    this.legacyCompatibility = legacyKeys.length > 0 ? sanitizeErrorMetadata(legacy) : undefined;
    if (legacyKeys.length > 0) warnLegacyOptionBag(this.code, legacyKeys);
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
  if (typeof value !== 'object' || value === null) return false;
  const brand = readOwnData(value, TOOL_ERROR_BRAND);
  const message = readOwnData(value, 'message');
  const code = readOwnData(value, 'code');
  const definition = readOwnData(value, 'definition');
  const normalizedDefinition = definition.ok
    ? normalizeToolErrorDefinition(definition.value)
    : undefined;
  return (
    brand.ok &&
    brand.value === TOOL_ERROR_BRAND_VERSION &&
    message.ok &&
    typeof message.value === 'string' &&
    code.ok &&
    typeof code.value === 'string' &&
    normalizedDefinition !== undefined &&
    definitionMatchesCode(code.value, normalizedDefinition)
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
  let message: string;
  try {
    if (typeof error === 'object' && error !== null) {
      const ownMessage = readOwnData(error, 'message');
      message =
        ownMessage.ok && typeof ownMessage.value === 'string' ? ownMessage.value : typeof error;
    } else if (typeof error === 'string') {
      message = error;
    } else if (
      typeof error === 'number' ||
      typeof error === 'boolean' ||
      typeof error === 'bigint' ||
      typeof error === 'symbol'
    ) {
      message = String(error);
    } else {
      message = error === null ? 'null' : 'undefined';
    }
  } catch {
    message = '<unstringifiable>';
  }
  return redactCredentialText(message).slice(0, MAX_METADATA_STRING);
}

/**
 * Coerce an arbitrary throwable to an `Error` without discarding what it already carried.
 *
 * A bare `new Error(...)` here erased the code, definition and exit class of anything that
 * was structurally `ToolError`-like — which is exactly what a ToolError looks like after it
 * crosses a duplicate-core boundary, where `instanceof` is false but the brand is intact
 * (pnpm's `injectWorkspacePackages` puts two physical copies of core in one process). The
 * result normalized to `known: 'unknown'`, so a fully classified failure arrived at the CLI
 * boundary indistinguishable from a thrown string.
 */
/**
 * Warn once per (code, key-set) that a caller used the legacy open option bag.
 *
 * Deduplicated because these constructions sit on hot paths — a per-file walk can raise
 * thousands — and an unbounded warn stream is indistinguishable from noise, which is how a
 * migration signal gets ignored. The set is bounded so a hostile or generated key space
 * cannot grow it without limit.
 */
const warnedLegacyOptionBags = new Set<string>();
const MAX_LEGACY_BAG_WARNINGS = 64;

function warnLegacyOptionBag(code: string, keys: readonly string[]): void {
  const signature = `${code}|${[...keys].sort().join(',')}`;
  if (warnedLegacyOptionBags.has(signature)) return;
  if (warnedLegacyOptionBags.size >= MAX_LEGACY_BAG_WARNINGS) return;
  warnedLegacyOptionBags.add(signature);
  try {
    currentLogger().warn({
      evt: 'core.error.legacy_option_bag',
      code,
      keys: [...keys].sort(),
      msg: 'ToolError constructed with unrecognized options; move them into bounded `metadata` (the open bag is scheduled for removal)',
    });
  } catch {
    // @swallow-ok A migration warning must never be able to fail the construction of the
    // error it is describing — that would replace a real failure with a diagnostic one.
  }
}

/** Test seam: the warn set is process-lived by design, so tests must be able to reset it. */
export function resetLegacyOptionBagWarnings(): void {
  warnedLegacyOptionBags.clear();
}

function ensureError(error: unknown): Error {
  try {
    if (error instanceof Error) return error;
  } catch {
    // @swallow-ok probe/optional capability: revoked/hostile instanceof failure falls through to a safe Error.
  }
  if (isToolErrorLike(error)) {
    const rebuilt = new ToolError(
      readToolErrorMessage(error),
      typeof error.code === 'string' ? error.code : 'SYSTEM_ERROR',
    );
    return rebuilt;
  }
  // The catalog KEY is the legacy token; the definition's published `code` is the dotted
  // form. Resolve through the catalog so the two can never drift at this call site.
  return new SystemError(formatUnknownErrorMessage(error), {
    code: coreSystemErrorCatalog.require('UNKNOWN_FAILURE').code,
  });
}

/** Read a cross-copy ToolError-like message without invoking a hostile getter. */
function readToolErrorMessage(value: { readonly message?: unknown }): string {
  try {
    return typeof value.message === 'string' ? value.message : 'Tool error';
  } catch {
    return 'Tool error';
  }
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
    return err(ensureError(error));
  }
}

/** Wraps a sync function in a try/catch, returning a Result instead of throwing. */
export function tryCatch<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (error) {
    return err(ensureError(error));
  }
}
