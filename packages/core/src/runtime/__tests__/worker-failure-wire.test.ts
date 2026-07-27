import { describe, expect, it } from 'vitest';

import { coreSystemErrorCatalog, defineErrorCatalog } from '../../lib/error-definition.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  toolErrorFromWorkerFailureWire,
  toWorkerFailureWire,
  WORKER_FAILURE_WIRE_VERSION,
} from '../worker-failure-wire.js';

import type { ErrorDefinition } from '../../lib/error-definition.js';

const projectionCatalog = defineErrorCatalog(
  { id: 'test.worker-wire', displayName: 'Worker wire test' },
  {
    configuration: {
      code: 'TEST.WIRE.CONFIGURATION',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'validation',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'configuration',
      operatorAction: 'Correct the input.',
      stability: 'internal',
      lifecycle: 'active',
    },
    notFound: {
      code: 'TEST.WIRE.NOT_FOUND',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'not-found',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'not-found',
      operatorAction: 'Choose an existing resource.',
      stability: 'internal',
      lifecycle: 'active',
    },
    reportFailed: {
      code: 'TEST.WIRE.REPORT_FAILED',
      source: 'external',
      defaultResponsibility: 'environment',
      kind: 'network',
      retry: 'transient',
      severity: 'error',
      exposure: 'operator-only',
      exitClass: 'report-failed',
      operatorAction: 'Retry after restoring connectivity.',
      stability: 'internal',
      lifecycle: 'active',
    },
    pluginIncompatible: {
      code: 'TEST.WIRE.PLUGIN_INCOMPATIBLE',
      source: 'application',
      defaultResponsibility: 'tool-author',
      kind: 'compatibility',
      retry: 'never',
      severity: 'error',
      exposure: 'public',
      exitClass: 'plugin-incompatible',
      operatorAction: 'Install a compatible plugin.',
      stability: 'internal',
      lifecycle: 'active',
    },
    timeout: {
      code: 'TEST.WIRE.TIMEOUT',
      source: 'infrastructure',
      defaultResponsibility: 'environment',
      kind: 'timeout',
      retry: 'caller-policy',
      severity: 'error',
      exposure: 'operator-only',
      exitClass: 'runtime',
      operatorAction: 'Retry within a larger outer budget.',
      stability: 'internal',
      lifecycle: 'active',
    },
    runtime: {
      code: 'TEST.WIRE.RUNTIME',
      source: 'infrastructure',
      defaultResponsibility: 'operator',
      kind: 'invariant',
      retry: 'never',
      severity: 'error',
      exposure: 'operator-only',
      exitClass: 'runtime',
      operatorAction: 'Inspect the worker diagnostics.',
      stability: 'internal',
      lifecycle: 'active',
    },
    fatal: {
      code: 'TEST.WIRE.FATAL',
      source: 'infrastructure',
      defaultResponsibility: 'operator',
      kind: 'invariant',
      retry: 'never',
      severity: 'fatal',
      exposure: 'operator-only',
      exitClass: 'fatal',
      operatorAction: 'Inspect the worker diagnostics.',
      stability: 'internal',
      lifecycle: 'active',
    },
    cancelled: {
      code: 'TEST.WIRE.CANCELLED',
      source: 'application',
      defaultResponsibility: 'user',
      kind: 'cancelled',
      retry: 'never',
      severity: 'warning',
      exposure: 'public',
      exitClass: 'cancelled',
      operatorAction: 'Restart the operation if desired.',
      stability: 'internal',
      lifecycle: 'active',
    },
  },
);

function crossCopyToolError(definition: ErrorDefinition): object {
  const error = {};
  Object.defineProperties(error, {
    message: { value: `worker failed: ${definition.code}` },
    code: { value: definition.code },
    definition: { value: definition },
    [Symbol.for('@opensip-cli/core/tool-error-brand')]: { value: 1 },
  });
  return error;
}

describe('toWorkerFailureWire', () => {
  it('projects ToolError without raw stack or secrets', () => {
    const error = new NotFoundError('missing', {
      code: 'NOT_FOUND',
      metadata: { id: 'x', password: 'secret' },
      failureClass: 'tool-handler-throw',
    });
    const wire = toWorkerFailureWire(error);
    expect(wire.wireVersion).toBe(WORKER_FAILURE_WIRE_VERSION);
    expect(wire.message).toContain('missing');
    expect(wire.code).toBe('NOT_FOUND');
    expect(wire.failureClass).toBe('tool-handler-throw');
    expect(wire.failure).toBeDefined();
    expect(JSON.stringify(wire)).not.toContain('secret');
    expect(wire).not.toHaveProperty('stack');
  });

  it('handles primitive throws', () => {
    const wire = toWorkerFailureWire('boom');
    expect(wire.message).toBe('An unexpected internal failure occurred.');
    expect(wire.failure).toBeDefined();
    expect(JSON.stringify(wire)).not.toContain('boom');
  });

  it('reconstructs definition axes from a valid versioned projection', () => {
    const wire = toWorkerFailureWire(new NotFoundError('missing recipe'));
    const rebuilt = toolErrorFromWorkerFailureWire({
      ...wire,
      failureWireVersion: wire.wireVersion,
    });
    expect(rebuilt?.code).toBe('NOT_FOUND');
    expect(rebuilt?.definition.exitClass).toBe('not-found');
    expect(rebuilt?.definition.owner.id).toBe(coreSystemErrorCatalog.owner.id);
  });

  it('uses the validated projection message instead of an unsafe parallel message', () => {
    const wire = toWorkerFailureWire(new NotFoundError('safe message'));
    const rebuilt = toolErrorFromWorkerFailureWire({
      ...wire,
      message: 'Bearer secret-token-value',
      failureWireVersion: wire.wireVersion,
    });
    expect(rebuilt?.message).toBe('safe message');
    expect(rebuilt?.message).not.toContain('secret-token-value');
  });

  it('falls back deterministically for an owner mismatch', () => {
    const wire = toWorkerFailureWire(new NotFoundError('safe message'));
    const rebuilt = toolErrorFromWorkerFailureWire({
      ...wire,
      failureWireVersion: wire.wireVersion,
      expectedOwnerId: 'another-tool',
    });
    expect(rebuilt?.code).toBe('NOT_FOUND');
    expect(rebuilt?.definition.owner.id).toBe(coreSystemErrorCatalog.owner.id);
  });

  it('falls back without throwing for a revoked Proxy projection', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() =>
      toolErrorFromWorkerFailureWire({
        message: 'safe fallback',
        code: 'NOT_FOUND',
        failureWireVersion: WORKER_FAILURE_WIRE_VERSION,
        failure: revoked.proxy,
      }),
    ).not.toThrow();
  });

  it('rejects malformed projections and falls back only to a valid legacy discriminator', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor trap');
        },
      },
    );
    for (const failure of [
      null,
      hostile,
      { schemaVersion: 999 },
      { schemaVersion: 1 },
      { schemaVersion: 1, owner: [] },
      { schemaVersion: 1, owner: { id: 42, displayName: 'Bad owner' } },
    ]) {
      expect(
        toolErrorFromWorkerFailureWire({
          message: 'safe fallback',
          code: 'NOT_FOUND',
          failureWireVersion: WORKER_FAILURE_WIRE_VERSION,
          failure: failure as Readonly<Record<string, unknown>>,
        }),
      ).toBeInstanceOf(NotFoundError);
    }

    const valid = toWorkerFailureWire(new NotFoundError('safe message'));
    expect(
      toolErrorFromWorkerFailureWire({
        ...valid,
        failureWireVersion: valid.wireVersion,
        failure: { ...valid.failure, kind: 'not-a-kind' },
      }),
    ).toBeInstanceOf(NotFoundError);
    expect(
      toolErrorFromWorkerFailureWire({
        message: 'no discriminator',
        failureWireVersion: WORKER_FAILURE_WIRE_VERSION,
      }),
    ).toBeUndefined();
  });

  it('requires a string message in an otherwise valid projection', () => {
    const wire = toWorkerFailureWire(new NotFoundError('safe message'));
    expect(
      toolErrorFromWorkerFailureWire({
        ...wire,
        failureWireVersion: wire.wireVersion,
        failure: { ...wire.failure, message: 42 },
      }),
    ).toBeUndefined();
  });

  it.each([
    ['configuration', 'CONFIGURATION_ERROR'],
    ['notFound', 'NOT_FOUND'],
    ['reportFailed', 'NETWORK_ERROR'],
    ['pluginIncompatible', 'PLUGIN_INCOMPATIBLE'],
    ['timeout', 'TIMEOUT'],
    ['runtime', 'SYSTEM_ERROR'],
    ['fatal', 'SYSTEM_ERROR'],
    ['cancelled', undefined],
  ] as const)('derives the legacy %s discriminator from projected definition axes', (key, code) => {
    const definition = projectionCatalog.require(key);
    const wire = toWorkerFailureWire(crossCopyToolError(definition));
    expect(wire.code).toBe(code);
    expect(wire.detailCode).toBe(definition.code);
  });

  it('carries a known native cancellation code onto the compatibility wire', () => {
    const wire = toWorkerFailureWire(new DOMException('This operation was aborted', 'AbortError'));
    expect(wire.code).toBe('CORE.SYSTEM.CANCELLED');
  });
});
