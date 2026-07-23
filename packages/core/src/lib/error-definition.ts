/**
 * Immutable error definitions and catalogs (Plan 00 Phase 2).
 *
 * Definitions carry orthogonal machine semantics. They are frozen values —
 * never import-time mutable registries. Catalogs are assembled explicitly
 * at composition boundaries.
 */

/** Where the failure arose. */
export type FailureSource = 'application' | 'infrastructure' | 'external';

/** Who can act (may be refined per occurrence without changing the code). */
export type FailureResponsibility =
  | 'user'
  | 'tool-author'
  | 'operator'
  | 'environment'
  | 'unknown';

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

export type ErrorCodeStability = 'public' | 'internal';
export type ErrorCodeLifecycle = 'active' | 'deprecated' | 'tombstoned';

/** Schema version for machine consumers of catalog / failure projections. */
export const ERROR_CATALOG_SCHEMA_VERSION = 1;
export const FAILURE_PROJECTION_SCHEMA_VERSION = 1;

/** Max definitions accepted from a single untrusted catalog contribution. */
export const MAX_DEFINITIONS_PER_CATALOG = 500;

const CODE_GRAMMAR = /^[A-Z][A-Z0-9]*(\.[A-Z][A-Z0-9_]*){2,}$/u;
const LEGACY_CODE = /^[A-Z][A-Z0-9_.-]*$/u;

export interface ErrorOwnerIdentity {
  /** Stable owner key (tool UUID or package name for substrate). */
  readonly id: string;
  /** Human-facing owner label (not a durable key). */
  readonly displayName: string;
  /** Package provenance string when known. */
  readonly packageName?: string;
}

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

export interface ErrorCatalogOwner {
  readonly id: string;
  readonly displayName: string;
  readonly packageName?: string;
}

export interface ErrorCatalog<TCodes extends string = string> {
  readonly schemaVersion: typeof ERROR_CATALOG_SCHEMA_VERSION;
  readonly owner: ErrorCatalogOwner;
  readonly definitions: Readonly<Record<TCodes, ErrorDefinition>>;
  readonly list: readonly ErrorDefinition[];
  get(code: string): ErrorDefinition | undefined;
  require(code: TCodes): ErrorDefinition;
}

export class ErrorDefinitionError extends Error {
  readonly code = 'CORE.ERROR_DEFINITION.INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ErrorDefinitionError';
  }
}

/**
 * Deep-freeze a plain JSON-like value. Used so catalogs are runtime-immutable,
 * not merely TypeScript-readonly.
 */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * Validate a published/new code grammar. Legacy short codes are accepted only
 * when `allowLegacy` is true (core system adapter).
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ErrorDefinitionError(`${label} has invalid value`);
  }
  return value as T;
}

/**
 * Copy and validate a hostile external definition object into a plain frozen definition.
 */
export function normalizeErrorDefinition(
  raw: unknown,
  owner: ErrorCatalogOwner,
  opts: { allowLegacyCodes?: boolean } = {},
): ErrorDefinition {
  if (!isPlainObject(raw)) {
    throw new ErrorDefinitionError('definition must be a plain object');
  }
  // Reject prototype pollution / accessors by reading only own enumerable data fields
  const code = assertErrorCodeShape(String(raw.code ?? ''), {
    allowLegacy: opts.allowLegacyCodes,
  });
  const operatorAction = String(raw.operatorAction ?? '');
  if (operatorAction.length === 0 || operatorAction.length > 512) {
    throw new ErrorDefinitionError(`definition ${code}: operatorAction required`);
  }

  const definition: ErrorDefinition = {
    code,
    owner: deepFreeze({
      id: owner.id,
      displayName: owner.displayName,
      ...(owner.packageName === undefined ? {} : { packageName: owner.packageName }),
    }),
    source: requireEnum(raw.source, SOURCES, 'source'),
    defaultResponsibility: requireEnum(raw.defaultResponsibility, RESPONSIBILITIES, 'defaultResponsibility'),
    kind: requireEnum(raw.kind, KINDS, 'kind'),
    retry: requireEnum(raw.retry, RETRIES, 'retry'),
    severity: requireEnum(raw.severity, SEVERITIES, 'severity'),
    exposure: requireEnum(raw.exposure, EXPOSURES, 'exposure'),
    exitClass: requireEnum(raw.exitClass, EXIT_CLASSES, 'exitClass'),
    operatorAction,
    stability: requireEnum(raw.stability ?? 'internal', STABILITIES, 'stability'),
    lifecycle: requireEnum(raw.lifecycle ?? 'active', LIFECYCLES, 'lifecycle'),
    ...(typeof raw.publicPresentationKey === 'string'
      ? { publicPresentationKey: raw.publicPresentationKey.slice(0, 128) }
      : {}),
    ...(typeof raw.supersededBy === 'string'
      ? { supersededBy: raw.supersededBy.slice(0, 128) }
      : {}),
    ...(Array.isArray(raw.publicMetadataKeys)
      ? {
          publicMetadataKeys: raw.publicMetadataKeys
            .filter((k): k is string => typeof k === 'string')
            .slice(0, 32)
            .map((k) => k.slice(0, 64)),
        }
      : {}),
  };

  if (definition.lifecycle === 'tombstoned' && !definition.supersededBy) {
    // tombstones may omit supersededBy when permanently retired without replacement
  }
  return deepFreeze(definition);
}

/**
 * Build an immutable package/tool error catalog.
 */
export function defineErrorCatalog<const TDefs extends Record<string, Omit<ErrorDefinition, 'owner'> & { code?: string }>>(
  owner: ErrorCatalogOwner,
  definitionsInput: TDefs,
  opts: { allowLegacyCodes?: boolean } = {},
): ErrorCatalog<Extract<keyof TDefs, string>> {
  if (!owner?.id || !owner.displayName) {
    throw new ErrorDefinitionError('catalog owner id and displayName are required');
  }
  const keys = Object.keys(definitionsInput);
  if (keys.length > MAX_DEFINITIONS_PER_CATALOG) {
    throw new ErrorDefinitionError(`catalog exceeds ${MAX_DEFINITIONS_PER_CATALOG} definitions`);
  }

  /** @type {Record<string, ErrorDefinition>} */
  const definitions: Record<string, ErrorDefinition> = {};
  const seen = new Set<string>();

  for (const key of keys) {
    const raw = definitionsInput[key] as Record<string, unknown>;
    const withCode = { ...raw, code: typeof raw.code === 'string' ? raw.code : key };
    const def = normalizeErrorDefinition(withCode, owner, opts);
    if (seen.has(def.code)) {
      throw new ErrorDefinitionError(`duplicate error code in catalog: ${def.code}`);
    }
    seen.add(def.code);
    definitions[key] = def;
  }

  const list = Object.freeze(Object.values(definitions).sort((a, b) => (a.code < b.code ? -1 : 1)));
  const frozenDefs = deepFreeze(definitions);

  const catalog: ErrorCatalog<Extract<keyof TDefs, string>> = {
    schemaVersion: ERROR_CATALOG_SCHEMA_VERSION,
    owner: deepFreeze({ ...owner }),
    definitions: frozenDefs as ErrorCatalog<Extract<keyof TDefs, string>>['definitions'],
    list,
    get(code: string) {
      return list.find((d) => d.code === code);
    },
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

/** Resolve a legacy ToolError string code to a core definition when possible. */
export function definitionFromLegacyCode(code: string): ErrorDefinition {
  return (
    coreSystemErrorCatalog.get(code) ??
    coreSystemErrorCatalog.require('UNKNOWN_FAILURE')
  );
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
