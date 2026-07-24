import { describe, expect, it } from 'vitest';

import { coreSystemErrorCatalog } from '../../lib/error-definition.js';
import { NotFoundError } from '../../lib/errors.js';
import {
  toolErrorFromWorkerFailureWire,
  toWorkerFailureWire,
  WORKER_FAILURE_WIRE_VERSION,
} from '../worker-failure-wire.js';

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
});
