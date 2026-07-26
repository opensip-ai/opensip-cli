// @fitness-ignore-file file-length-limit -- Cohesive single-source contract: the immutable error-definition type surface (axes, owner identity, catalog) and the validators that enforce it. Splitting types from their validators is a possible follow-up; kept together as one authority for now.
/**
 * Immutable error definitions and catalogs (Plan 00 Phase 2).
 *
 * Definitions carry orthogonal machine semantics. They are frozen values —
 * never import-time mutable registries. Catalogs are assembled explicitly
 * at composition boundaries.
 */

import { ErrorDefinitionError } from './error-definition-error.js';
import { isPlainDataObject } from './plain-data-object.js';

/** Where the failure arose. */
export type FailureSource = 'application' | 'infrastructure' | 'external';

/** Who can act (may be refined per occurrence without changing the code). */
export type FailureResponsibility = 'user' | 'tool-author' | 'operator' | 'environment' | 'unknown';

/** Closed failure kind vocabulary. */
export type FailureKind =
  | 'validation'
  | 'not-found'
  | 'conflict'
  | 'permission'
  | 'integrity'
  | 'invariant'
  | 'I/O'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'resource'
  | 'compatibility'
  | 'security';

/** Default retry posture for the definition (caller still owns policy). */
export type FailureRetryPosture = 'never' | 'transient' | 'caller-policy';

/**
 * Execution-failure severity. Distinct from finding SignalSeverity and
 * persisted ToolRunOutcome — definition severity never alone decides runOutcome.
 */
export type ExecutionFailureSeverity = 'warning' | 'error' | 'fatal';

/** How far fields may travel without further redaction policy. */
export type FailureExposure = 'public' | 'redacted' | 'operator-only';

/** Host-neutral exit class (contracts maps to numeric codes). */
export type FailureExitClass =
  | 'success'
  | 'runtime'
  | 'configuration'
  | 'not-found'
  | 'report-failed'
  | 'plugin-incompatible'
  | 'cancelled'
  | 'fatal';

/** Whether a code is part of the public surface or internal-only. */
export type ErrorCodeStability = 'public' | 'internal';
/** Lifecycle state of an error code. */
export type ErrorCodeLifecycle = 'active' | 'deprecated' | 'tombstoned';

/** Schema version for machine consumers of catalog / failure projections. */
export const ERROR_CATALOG_SCHEMA_VERSION = 1;
export const FAILURE_PROJECTION_SCHEMA_VERSION = 1;

/** Max definitions accepted from a single untrusted catalog contribution. */
export const MAX_DEFINITIONS_PER_CATALOG = 500;

const CODE_GRAMMAR = /^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9_]*){2,}$/u;
const LEGACY_CODE = /^[A-Z][A-Z0-9_.-]*$/u;

/** Identity of the owner (tool or substrate package) that defines an error. */
export interface ErrorOwnerIdentity {
  /** Stable owner key (tool UUID or package name for substrate). */
  readonly id: string;
  /** Human-facing owner label (not a durable key). */
  readonly displayName: string;
  /** Package provenance string when known. */
  readonly packageName?: string;
}

/** Immutable, frozen error definition carrying orthogonal machine-failure semantics. */
export interface ErrorDefinition {
  readonly code: string;
  readonly owner: ErrorOwnerIdentity;
  readonly source: FailureSource;
  readonly defaultResponsibility: FailureResponsibility;
  readonly kind: FailureKind;
  readonly retry: FailureRetryPosture;
  readonly severity: ExecutionFailureSeverity;
  readonly exposure: FailureExposure;
  readonly exitClass: FailureExitClass;
  readonly operatorAction: string;
  readonly stability: ErrorCodeStability;
  readonly lifecycle: ErrorCodeLifecycle;
  readonly publicPresentationKey?: string;
  readonly supersededBy?: string;
  /** Bounded outward field allowlist for public/telemetry/worker projections. */
  readonly publicMetadataKeys?: readonly string[];
}

/** Owner metadata for an error catalog. */
export interface ErrorCatalogOwner {
  readonly id: string;
  readonly displayName: string;
  readonly packageName?: string;
}

/** Immutable per-owner catalog of error definitions, indexed by code. */
export interface ErrorCatalog<TCodes extends string = string> {
  readonly schemaVersion: typeof ERROR_CATALOG_SCHEMA_VERSION;
  readonly owner: ErrorCatalogOwner;
  /**
   * The single `OWNER` segment every code in this catalog starts with, derived from the
   * definitions rather than declared. `undefined` only for the legacy class-default catalog,
   * whose codes predate the dotted grammar.
   */
  readonly codeHead: string | undefined;
  readonly definitions: Readonly<Record<TCodes, ErrorDefinition>>;
  readonly list: readonly ErrorDefinition[];
  get(code: string): ErrorDefinition | undefined;
  require(code: TCodes): ErrorDefinition;
}

/**
 * Re-exported from its leaf module so existing importers are untouched (ruling D10).
 * The class itself lives in `error-definition-error.ts` because it is thrown *by* catalog
 * validation and therefore cannot import a catalog to resolve its own definition.
 */
export {
  ErrorDefinitionError,
  ERROR_DEFINITION_ERROR_BRAND,
  isErrorDefinitionErrorLike,
} from './error-definition-error.js';

/**
 * Deep-freeze a plain JSON-like value. Used so catalogs are runtime-immutable,
 * not merely TypeScript-readonly.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): Readonly<T> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value;
  }
  const object = value as object;
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  try {
    if (Object.isFrozen(object)) return value;
    // Descriptors avoid invoking accessors while walking a value supplied by a
    // plugin. Cycles are cut by `seen`, so this helper stays total for hostile
    // JSON-like graphs instead of recursing forever.
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
      if ('value' in descriptor) deepFreeze(descriptor.value, seen);
    }
    return Object.freeze(value);
  } catch {
    // A Proxy may reject descriptor inspection or freezing. Callers that need a
    // trusted immutable value first copy through the catalog normalizer; this
    // public utility must not crash merely because inspection was hostile.
    return value;
  }
}

/**
 * Validate a published/new code grammar. Legacy short codes are accepted only
 * when `allowLegacy` is true (core system adapter).
 * @throws {ErrorDefinitionError} When the code is not a bounded non-empty string or fails the grammar.
 */
export function assertErrorCodeShape(code: string, opts: { allowLegacy?: boolean } = {}): string {
  if (typeof code !== 'string' || code.length === 0 || code.length > 128) {
    throw new ErrorDefinitionError('error code must be a bounded non-empty string');
  }
  if (CODE_GRAMMAR.test(code)) return code;
  if (opts.allowLegacy && LEGACY_CODE.test(code)) return code;
  throw new ErrorDefinitionError(
    `error code '${code}' must match OWNER.DOMAIN.CONDITION (or legacy allowlist during migration)`,
  );
}

/**
 * Read one own data property without invoking a plugin-supplied accessor.
 * @throws {ErrorDefinitionError} When the descriptor cannot be inspected or is an accessor.
 */
function ownData(value: object, key: PropertyKey): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new ErrorDefinitionError(`${String(key)} could not be inspected`);
  }
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) {
    throw new ErrorDefinitionError(`${String(key)} must be a data property`);
  }
  return descriptor.value;
}

/** @throws {ErrorDefinitionError} When catalog owner input is malformed or cannot be inspected. */
function normalizeCatalogOwner(raw: ErrorCatalogOwner): ErrorCatalogOwner {
  if (!isPlainDataObject(raw)) {
    throw new ErrorDefinitionError('catalog owner must be a plain object');
  }
  const id = asBoundedString(ownData(raw, 'id'), 'catalog owner id');
  const displayName = asBoundedString(ownData(raw, 'displayName'), 'catalog owner displayName');
  const packageNameRaw = ownData(raw, 'packageName');
  const packageName =
    packageNameRaw === undefined
      ? undefined
      : asBoundedString(packageNameRaw, 'catalog owner packageName');
  if (id.length === 0 || id.length > 128 || displayName.length === 0 || displayName.length > 128) {
    throw new ErrorDefinitionError('catalog owner id and displayName must be bounded strings');
  }
  if (packageName !== undefined && packageName.length > 214) {
    throw new ErrorDefinitionError('catalog owner packageName is too long');
  }
  return deepFreeze({ id, displayName, ...(packageName === undefined ? {} : { packageName }) });
}

/** @throws {ErrorDefinitionError} When an array element cannot be safely inspected. */
function boundedStringList(value: unknown): readonly string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const out: string[] = [];
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length =
      lengthDescriptor !== undefined &&
      'value' in lengthDescriptor &&
      typeof lengthDescriptor.value === 'number'
        ? Math.min(32, Math.max(0, Math.floor(lengthDescriptor.value)))
        : 0;
    for (let index = 0; index < length; index += 1) {
      const item = ownData(value, String(index));
      if (typeof item === 'string') out.push(item.slice(0, 64));
    }
    return out;
  } catch (error) {
    if (error instanceof ErrorDefinitionError) throw error;
    throw new ErrorDefinitionError('publicMetadataKeys could not be inspected');
  }
}

/**
 * Coerce only string primitives (reject objects that stringify to [object Object]).
 * @throws {ErrorDefinitionError} When value is a non-primitive (object, array, symbol, function).
 */
function asBoundedString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new ErrorDefinitionError(`${label} must be a string`);
}

const SOURCES: readonly FailureSource[] = ['application', 'infrastructure', 'external'];
const RESPONSIBILITIES: readonly FailureResponsibility[] = [
  'user',
  'tool-author',
  'operator',
  'environment',
  'unknown',
];
const KINDS: readonly FailureKind[] = [
  'validation',
  'not-found',
  'conflict',
  'permission',
  'integrity',
  'invariant',
  'I/O',
  'network',
  'timeout',
  'cancelled',
  'resource',
  'compatibility',
  'security',
];
const RETRIES: readonly FailureRetryPosture[] = ['never', 'transient', 'caller-policy'];
const SEVERITIES: readonly ExecutionFailureSeverity[] = ['warning', 'error', 'fatal'];
const EXPOSURES: readonly FailureExposure[] = ['public', 'redacted', 'operator-only'];
const EXIT_CLASSES: readonly FailureExitClass[] = [
  'success',
  'runtime',
  'configuration',
  'not-found',
  'report-failed',
  'plugin-incompatible',
  'cancelled',
  'fatal',
];
const STABILITIES: readonly ErrorCodeStability[] = ['public', 'internal'];
const LIFECYCLES: readonly ErrorCodeLifecycle[] = ['active', 'deprecated', 'tombstoned'];

/**
 * Return value when it is one of the allowed enum members.
 * @throws {ErrorDefinitionError} When value is not one of the allowed members.
 */
function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ErrorDefinitionError(`${label} has invalid value`);
  }
  return value as T;
}

/**
 * Enforce that a `supersededBy` pointer means something.
 *
 * This replaces an empty `if (lifecycle === 'tombstoned' && !supersededBy) {}` branch whose
 * only content was a comment. The rule that branch gestured at — "a tombstone must name a
 * successor" — is **deliberately not enforced**, because the comment it carried states the
 * opposite intent: a code can be permanently retired with no replacement, and requiring a
 * successor would make that legitimate state unrepresentable.
 *
 * What was genuinely unguarded is the pointer itself. `supersededBy` was accepted as any
 * string, truncated to 128 characters, frozen, and published into the generated error-code
 * index — so a typo'd or self-referential pointer became a permanent dangling reference in a
 * public document, and a resolution loop for anything that follows it.
 *
 * @throws {ErrorDefinitionError} When `supersededBy` is not a valid code, points at its own
 * code, or is present on a definition still declared `active`.
 */
function assertSupersessionCoherent(definition: ErrorDefinition): void {
  const successor = definition.supersededBy;
  if (successor === undefined) return;
  // Legacy codes are allowed: a superseded code may well point at a legacy-grammar one
  // during migration, which is exactly when supersession is used.
  assertErrorCodeShape(successor, { allowLegacy: true });
  if (successor === definition.code) {
    throw new ErrorDefinitionError(`definition ${definition.code}: supersededBy points at itself`);
  }
  if (definition.lifecycle === 'active') {
    throw new ErrorDefinitionError(
      `definition ${definition.code}: supersededBy requires lifecycle 'deprecated' or 'tombstoned'`,
    );
  }
}

/**
 * Copy and validate a hostile external definition object into a plain frozen definition.
 * @throws {ErrorDefinitionError} When raw is not a plain object, the code/operatorAction are invalid, any axis fails enum validation, or `supersededBy` is incoherent.
 */
export function normalizeErrorDefinition(
  raw: unknown,
  owner: ErrorCatalogOwner,
  opts: { allowLegacyCodes?: boolean; defaultCode?: string } = {},
): ErrorDefinition {
  if (!isPlainDataObject(raw)) {
    throw new ErrorDefinitionError('definition must be a plain object');
  }
  const normalizedOwner = normalizeCatalogOwner(owner);
  // Reject prototype pollution / accessors by reading only own data fields.
  const rawCode = ownData(raw, 'code') ?? opts.defaultCode;
  const code = assertErrorCodeShape(asBoundedString(rawCode, 'code'), {
    allowLegacy: opts.allowLegacyCodes,
  });
  const operatorAction = asBoundedString(ownData(raw, 'operatorAction'), 'operatorAction');
  if (operatorAction.length === 0 || operatorAction.length > 512) {
    throw new ErrorDefinitionError(`definition ${code}: operatorAction required`);
  }

  const stability = ownData(raw, 'stability');
  const lifecycle = ownData(raw, 'lifecycle');
  const publicPresentationKey = ownData(raw, 'publicPresentationKey');
  const supersededBy = ownData(raw, 'supersededBy');
  const publicMetadataKeys = boundedStringList(ownData(raw, 'publicMetadataKeys'));

  const definition: ErrorDefinition = {
    code,
    owner: normalizedOwner,
    source: requireEnum(ownData(raw, 'source'), SOURCES, 'source'),
    defaultResponsibility: requireEnum(
      ownData(raw, 'defaultResponsibility'),
      RESPONSIBILITIES,
      'defaultResponsibility',
    ),
    kind: requireEnum(ownData(raw, 'kind'), KINDS, 'kind'),
    retry: requireEnum(ownData(raw, 'retry'), RETRIES, 'retry'),
    severity: requireEnum(ownData(raw, 'severity'), SEVERITIES, 'severity'),
    exposure: requireEnum(ownData(raw, 'exposure'), EXPOSURES, 'exposure'),
    exitClass: requireEnum(ownData(raw, 'exitClass'), EXIT_CLASSES, 'exitClass'),
    operatorAction,
    stability: requireEnum(stability ?? 'internal', STABILITIES, 'stability'),
    lifecycle: requireEnum(lifecycle ?? 'active', LIFECYCLES, 'lifecycle'),
    ...(typeof publicPresentationKey === 'string'
      ? { publicPresentationKey: publicPresentationKey.slice(0, 128) }
      : {}),
    ...(typeof supersededBy === 'string' ? { supersededBy: supersededBy.slice(0, 128) } : {}),
    ...(publicMetadataKeys === undefined ? {} : { publicMetadataKeys }),
  };

  assertSupersessionCoherent(definition);
  return deepFreeze(definition);
}

/**
 * Build an immutable package/tool error catalog.
 *
 * Every code in one catalog must share one head — the `OWNER` segment of
 * `OWNER.DOMAIN.CONDITION`. The head is not declared; it is READ from the first definition and
 * the rest are held to it, so a catalog cannot disagree with itself and there is no second
 * place for the head to drift out of sync with the codes.
 *
 * The rule buys two things. Codes become collision-proof across owners without any central
 * allocator: two packages that both need a "config is invalid" condition cannot mint the same
 * string. And the head names the OWNER rather than the failure kind, which is what makes it
 * worth reading — `kind`, `severity`, `source` and `exitClass` are already structured fields on
 * the definition, so a head like `VALIDATION.` was both redundant and free to contradict them.
 *
 * `allowLegacyCodes` opts out, and exists for exactly one catalog: the class-default codes
 * (`VALIDATION_ERROR`, `UNKNOWN_FAILURE`, …) that predate the dotted grammar and are the
 * totality fallback for unregistered input (ruling D11).
 *
 * @throws {ErrorDefinitionError} When the owner lacks id/displayName, the definition count exceeds the cap, two entries share a code, or the codes do not share one head.
 */
export function defineErrorCatalog<
  const TDefs extends Record<string, Omit<ErrorDefinition, 'owner'> & { code?: string }>,
>(
  owner: ErrorCatalogOwner,
  definitionsInput: TDefs,
  opts: { allowLegacyCodes?: boolean } = {},
): ErrorCatalog<Extract<keyof TDefs, string>> {
  const normalizedOwner = normalizeCatalogOwner(owner);
  if (!isPlainDataObject(definitionsInput)) {
    throw new ErrorDefinitionError('catalog definitions must be a plain object');
  }
  let keys: string[];
  try {
    keys = Object.keys(definitionsInput);
  } catch {
    throw new ErrorDefinitionError('catalog definitions could not be inspected');
  }
  if (keys.length > MAX_DEFINITIONS_PER_CATALOG) {
    throw new ErrorDefinitionError(`catalog exceeds ${MAX_DEFINITIONS_PER_CATALOG} definitions`);
  }

  /** @type {Record<string, ErrorDefinition>} */
  const definitions: Record<string, ErrorDefinition> = {};
  const seen = new Set<string>();

  let head: string | undefined;

  for (const key of keys) {
    const raw = ownData(definitionsInput, key);
    const def = normalizeErrorDefinition(raw, normalizedOwner, { ...opts, defaultCode: key });
    if (seen.has(def.code)) {
      throw new ErrorDefinitionError(`duplicate error code in catalog: ${def.code}`);
    }
    if (opts.allowLegacyCodes !== true) {
      const codeHead = def.code.slice(0, def.code.indexOf('.'));
      head ??= codeHead;
      if (codeHead !== head) {
        throw new ErrorDefinitionError(
          `definition ${def.code}: catalog head is '${head}', so every code in it must start with '${head}.'`,
        );
      }
    }
    seen.add(def.code);
    definitions[key] = def;
  }

  const list = Object.freeze(
    [...Object.values(definitions)].sort((a, b) => a.code.localeCompare(b.code)),
  );
  const frozenDefs = deepFreeze(definitions);

  const catalog: ErrorCatalog<Extract<keyof TDefs, string>> = {
    schemaVersion: ERROR_CATALOG_SCHEMA_VERSION,
    owner: normalizedOwner,
    codeHead: head,
    definitions: frozenDefs,
    list,
    get(code: string) {
      return list.find((d) => d.code === code);
    },
    /** @throws {ErrorDefinitionError} When no definition exists for the given catalog key. */
    require(code: Extract<keyof TDefs, string>) {
      const def = frozenDefs[code as string];
      if (!def) {
        throw new ErrorDefinitionError(`unknown catalog key: ${String(code)}`);
      }
      return def;
    },
  };
  return deepFreeze(catalog);
}

/**
 * Core/system catalog mapping existing ToolErrorCode defaults without big-bang rename.
 */
export const CORE_SYSTEM_ERROR_OWNER: ErrorCatalogOwner = {
  id: 'opensip-cli.core',
  displayName: 'OpenSIP Core',
  packageName: '@opensip-cli/core',
};

export const coreSystemErrorCatalog = defineErrorCatalog(
  CORE_SYSTEM_ERROR_OWNER,
  {
    VALIDATION_ERROR: {
      code: 'VALIDATION_ERROR',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction: 'Fix the invalid input, flag, or configuration value and retry.',
      stability: 'public',
      lifecycle: 'active',
    },
    NOT_FOUND: {
      code: 'NOT_FOUND',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'not-found',
      operatorAction: 'Verify the resource name and list available options.',
      stability: 'public',
      lifecycle: 'active',
      // fromNativeError records the errno here; without the allowlist
      // `allowlistedMetadata` discards the one machine-classification datum it captured.
      publicMetadataKeys: ['errno'],
    },
    SYSTEM_ERROR: {
      code: 'SYSTEM_ERROR',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Retry once; if it persists, capture the run id and report a bug.',
      stability: 'public',
      lifecycle: 'active',
      // fromNativeError records the errno here; without the allowlist
      // `allowlistedMetadata` discards the one machine-classification datum it captured.
      publicMetadataKeys: ['errno'],
    },
    TIMEOUT: {
      code: 'TIMEOUT',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'timeout',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction: 'Increase the deadline or reduce workload; check for hung dependencies.',
      stability: 'public',
      lifecycle: 'active',
    },
    'CORE.SYSTEM.DEADLINE_EXCEEDED': {
      code: 'CORE.SYSTEM.DEADLINE_EXCEEDED',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'timeout',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction: 'Increase the outer deadline or reduce the operation workload.',
      stability: 'public',
      lifecycle: 'active',
    },
    'CORE.SYSTEM.CANCELLED': {
      code: 'CORE.SYSTEM.CANCELLED',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'cancelled',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'cancelled',
      operatorAction: 'The operation was cancelled. Re-run if the work is still needed.',
      stability: 'public',
      lifecycle: 'active',
    },
    'CORE.SYSTEM.PERMISSION': {
      code: 'CORE.SYSTEM.PERMISSION',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'permission',
      retry: 'never',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Check filesystem permissions for the affected path.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['errno', 'hop'],
    },
    'CORE.SYSTEM.RESOURCE': {
      code: 'CORE.SYSTEM.RESOURCE',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'resource',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'runtime',
      operatorAction: 'Free resources (disk, file descriptors, or memory) and retry.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['errno'],
    },
    NETWORK_ERROR: {
      code: 'NETWORK_ERROR',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'network',
      retry: 'transient',
      severity: 'error',
      exposure: 'redacted',
      exitClass: 'report-failed',
      operatorAction: 'Check network connectivity and the remote endpoint.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: ['status'],
    },
    CONFIGURATION_ERROR: {
      code: 'CONFIGURATION_ERROR',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction: 'Check opensip-cli.config.yml and CLI flags.',
      stability: 'public',
      lifecycle: 'active',
    },
    PLUGIN_INCOMPATIBLE: {
      code: 'PLUGIN_INCOMPATIBLE',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'compatibility',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'plugin-incompatible',
      operatorAction:
        'Upgrade OpenSIP CLI or the tool, or trust a project-local tool via tools.trusted.',
      stability: 'public',
      lifecycle: 'active',
    },
    UNKNOWN_LIVE_VIEW: {
      code: 'UNKNOWN_LIVE_VIEW',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'runtime',
      operatorAction: 'Use a registered live view key for this tool.',
      stability: 'internal',
      lifecycle: 'active',
    },
    UNKNOWN_FAILURE: {
      code: 'CORE.SYSTEM.UNKNOWN_FAILURE',
      source: 'application',
      defaultResponsibility: 'unknown',
      kind: 'invariant',
      retry: 'never',
      severity: 'fatal',
      exposure: 'operator-only',
      exitClass: 'fatal',
      operatorAction: 'Capture the run id and operator detail; do not retry blindly.',
      stability: 'public',
      lifecycle: 'active',
      publicMetadataKeys: [],
    },
  },
  { allowLegacyCodes: true },
);

/**
 * Resolve a ToolError string code against the core adapter catalog.
 *
 * CLEAN BREAK (Plan 01): the family fallback is GONE. This used to guess a definition from the
 * first token of the code — `CONFIG.*` meant "configuration error", `SYSTEM.*` meant "internal
 * invariant" — which made an unregistered code look classified while carrying axes nobody
 * chose for it, and quietly demoted anything whose head was not in the switch. Guessing is now
 * impossible: a code either resolves to a definition some package actually declared, or it is
 * honestly unknown.
 *
 * The function stays TOTAL (ruling D11). An unknown code resolves to `UNKNOWN_FAILURE` rather
 * than throwing, because a third-party tool shipping a code nobody registered must not be able
 * to crash the host — and because this runs while something has already failed.
 *
 * Callers should prefer `resolveDefinitionForCode`, which consults every registered catalog
 * (core's own, plus substrates and loaded tools via the per-run registry) before falling back
 * here.
 */
export function definitionFromLegacyCode(code: string): ErrorDefinition {
  return coreSystemErrorCatalog.get(code) ?? coreSystemErrorCatalog.require('UNKNOWN_FAILURE');
}

/**
 * Machine-consumer compatibility policy (GD 14).
 * Additive fields are forward-compatible; breaking changes require a new schema version.
 */
export const MACHINE_CONSUMER_COMPATIBILITY = deepFreeze({
  catalogSchemaVersion: ERROR_CATALOG_SCHEMA_VERSION,
  failureProjectionSchemaVersion: FAILURE_PROJECTION_SCHEMA_VERSION,
  additiveFieldsForwardCompatible: true,
  breakingChangeRequiresNewVersion: true,
  deprecationWindowRequired: true,
});
