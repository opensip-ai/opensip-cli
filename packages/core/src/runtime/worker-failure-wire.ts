/**
 * Worker IPC failure wire projection (Plan 00 Phase 5).
 *
 * Serialize only machine-safe failure axes — never raw Error/cause objects.
 */

import {
  FAILURE_PROJECTION_SCHEMA_VERSION,
  normalizeErrorDefinition,
  type ErrorCatalogOwner,
  type ErrorDefinition,
} from '../lib/error-definition.js';
import {
  ToolError,
  canonicalToolErrorCode,
  createToolError,
  isToolErrorLike,
  normalizeToolErrorDefinition,
  toolErrorFromCanonicalCode,
} from '../lib/errors.js';
import { normalizeFailure } from '../lib/failure-envelope.js';
import { toMachineFailureProjection } from '../lib/failure-projection.js';
import { scrubText } from '../lib/safe-diagnostic-data.js';

import { getWorkerErrorFailureClass } from './worker-error-failure-class.js';

/** Schema version for worker failure payloads. */
export const WORKER_FAILURE_WIRE_VERSION = 1;

/** Structured-clone-safe failure payload sent across the worker IPC boundary. */
export interface WorkerFailureWire {
  readonly wireVersion: typeof WORKER_FAILURE_WIRE_VERSION;
  readonly message: string;
  readonly code?: string;
  readonly detailCode?: string;
  readonly failureClass?: string;
  /** Machine projection of FailureEnvelope (no operatorDetail/stack). */
  readonly failure?: Readonly<Record<string, unknown>>;
}

/** Parent-side input used to reconstruct a definition-backed worker failure. */
export interface WorkerFailureReconstructionInput {
  readonly message: string;
  readonly code?: string;
  readonly detailCode?: string;
  readonly failureClass?: string;
  readonly failure?: Readonly<Record<string, unknown>>;
  readonly failureWireVersion?: number;
  readonly stderrTail?: string;
  /** Optional host-attested owner for untrusted tool worker projections. */
  readonly expectedOwnerId?: string;
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    // @swallow-ok probe/optional capability: hostile descriptor reads yield no trusted wire field.
    return undefined;
  }
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    // @swallow-ok probe/optional capability: revoked arrays are not admissible projection objects.
    return false;
  }
}

function projectionDefinition(raw: unknown, expectedOwnerId?: string): ErrorDefinition | undefined {
  if (!isNonArrayObject(raw)) return undefined;
  if (ownData(raw, 'schemaVersion') !== FAILURE_PROJECTION_SCHEMA_VERSION) return undefined;

  const ownerRaw = ownData(raw, 'owner');
  if (!isNonArrayObject(ownerRaw)) return undefined;
  const id = ownData(ownerRaw, 'id');
  const displayName = ownData(ownerRaw, 'displayName');
  const packageName = ownData(ownerRaw, 'packageName');
  if (typeof id !== 'string' || typeof displayName !== 'string') return undefined;
  const owner: ErrorCatalogOwner = {
    id,
    displayName,
    ...(typeof packageName === 'string' ? { packageName } : {}),
  };
  if (expectedOwnerId !== undefined && owner.id !== expectedOwnerId) return undefined;

  try {
    return normalizeErrorDefinition(
      {
        code: ownData(raw, 'code'),
        source: ownData(raw, 'source'),
        defaultResponsibility: ownData(raw, 'responsibility'),
        kind: ownData(raw, 'kind'),
        retry: ownData(raw, 'retry'),
        severity: ownData(raw, 'severity'),
        exposure: ownData(raw, 'exposure'),
        exitClass: ownData(raw, 'exitClass'),
        operatorAction: ownData(raw, 'action'),
        stability: ownData(raw, 'stability') ?? 'internal',
        lifecycle: ownData(raw, 'lifecycle') ?? 'active',
        publicMetadataKeys: ownData(raw, 'publicMetadataKeys') ?? [],
      },
      owner,
      { allowLegacyCodes: true },
    );
  } catch {
    // @swallow-ok probe/optional capability: malformed worker projections fail typed reconstruction closed.
    return undefined;
  }
}

function safeDetailCode(code: string | undefined): string | undefined {
  return code !== undefined && /^[A-Z][A-Z0-9_.-]{0,127}$/u.test(code) ? code : undefined;
}

function projectedWorkerError(
  input: WorkerFailureReconstructionInput,
  definition: ErrorDefinition,
): ToolError | undefined {
  const metadata = input.failure === undefined ? undefined : ownData(input.failure, 'metadata');
  const projectedMessage =
    input.failure === undefined ? undefined : ownData(input.failure, 'message');
  // The versioned projection is authoritative. Never trust the parallel legacy
  // message when a valid definition exists.
  if (typeof projectedMessage !== 'string') return undefined;
  return createToolError(definition, scrubText(projectedMessage, 1000), {
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    ...(input.stderrTail === undefined ? {} : { stderrTail: input.stderrTail }),
    ...(typeof metadata === 'object' && metadata !== null
      ? { metadata: metadata as Readonly<Record<string, unknown>> }
      : {}),
  });
}

function legacyWorkerError(input: WorkerFailureReconstructionInput): ToolError | undefined {
  if (input.code === undefined) return undefined;
  const fallbackMessage = scrubText(
    typeof input.message === 'string' ? input.message : 'The worker operation failed.',
    1000,
  );
  const detailCode = safeDetailCode(input.detailCode);
  return toolErrorFromCanonicalCode(input.code, fallbackMessage, {
    code: detailCode ?? input.code,
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    ...(input.stderrTail === undefined ? {} : { stderrTail: input.stderrTail }),
  });
}

/**
 * Rebuild a worker failure from the versioned definition projection. Older or
 * malformed payloads fall back to the canonical legacy discriminator.
 */
export function toolErrorFromWorkerFailureWire(
  input: WorkerFailureReconstructionInput,
): ToolError | undefined {
  if (input.failureWireVersion === WORKER_FAILURE_WIRE_VERSION) {
    const definition = projectionDefinition(input.failure, input.expectedOwnerId);
    if (definition !== undefined) {
      return projectedWorkerError(input, definition);
    }
  }
  return legacyWorkerError(input);
}

function canonicalCodeFromDefinition(definition: ErrorDefinition): string | undefined {
  switch (definition.exitClass) {
    case 'configuration': {
      return 'CONFIGURATION_ERROR';
    }
    case 'not-found': {
      return 'NOT_FOUND';
    }
    case 'report-failed': {
      return 'NETWORK_ERROR';
    }
    case 'plugin-incompatible': {
      return 'PLUGIN_INCOMPATIBLE';
    }
    case 'runtime': {
      return definition.kind === 'timeout' ? 'TIMEOUT' : 'SYSTEM_ERROR';
    }
    case 'fatal': {
      return 'SYSTEM_ERROR';
    }
    default: {
      return undefined;
    }
  }
}

/**
 * Build a structured-clone-safe failure payload from any thrown value.
 */
export function toWorkerFailureWire(error: unknown): WorkerFailureWire {
  const envelope = normalizeFailure(error);
  const machine = toMachineFailureProjection(envelope);
  const failureClass = getWorkerErrorFailureClass(error);

  let code: string | undefined;
  let detailCode: string | undefined;
  if (isToolErrorLike(error)) {
    try {
      const definition = normalizeToolErrorDefinition(error.definition);
      if (error instanceof ToolError) {
        code = canonicalToolErrorCode(error);
      } else if (definition !== undefined) {
        code = canonicalCodeFromDefinition(definition);
      }
      detailCode = error.code === code ? undefined : error.code;
    } catch {
      // @swallow-ok probe/optional capability: the normalized machine projection
      // remains authoritative when a legacy discriminator is hostile.
    }
  } else if (envelope.known === 'known') {
    code = envelope.code;
  }

  return {
    wireVersion: WORKER_FAILURE_WIRE_VERSION,
    message: typeof machine.message === 'string' ? machine.message : 'The worker operation failed.',
    ...(code === undefined ? {} : { code }),
    ...(detailCode === undefined ? {} : { detailCode }),
    ...(failureClass === undefined ? {} : { failureClass }),
    failure: machine,
  };
}
