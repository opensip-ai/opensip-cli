import { describe, expect, it } from 'vitest';

import { NotFoundError } from '../../lib/errors.js';
import { toWorkerFailureWire, WORKER_FAILURE_WIRE_VERSION } from '../worker-failure-wire.js';

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
    expect(wire.message).toContain('boom');
    expect(wire.failure).toBeDefined();
  });
});
