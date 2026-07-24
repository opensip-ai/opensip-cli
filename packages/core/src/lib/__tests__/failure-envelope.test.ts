import { describe, it, expect } from 'vitest';

import { ToolError, createToolError } from '../errors.js';
import { coreSystemErrorCatalog } from '../error-definition.js';
import {
  normalizeFailure,
  toPublicFailureProjection,
  toMachineFailureProjection,
  toOperatorFailureProjection,
} from '../failure-envelope.js';

describe('normalizeFailure', () => {
  it('normalizes ToolError with definition', () => {
    const err = createToolError(coreSystemErrorCatalog.require('NOT_FOUND'), 'missing check');
    const env = normalizeFailure(err);
    expect(env.known).toBe('known');
    expect(env.code).toBe('NOT_FOUND');
    expect(env.definition.kind).toBe('not-found');
    expect(env.message).toContain('missing');
  });

  it('is total on primitives and hostile objects', () => {
    expect(normalizeFailure(null).known).toBe('unknown');
    expect(normalizeFailure(42).message).toContain('42');
    const hostile = {
      get message() {
        throw new Error('boom');
      },
    };
    const env = normalizeFailure(hostile);
    expect(env.schemaVersion).toBe(1);
    expect(typeof env.message).toBe('string');
  });

  it('preserves cause chain with bound depth', () => {
    const root = new Error('root');
    const mid = new Error('mid', { cause: root });
    const top = new ToolError('top', 'SYSTEM_ERROR', { cause: mid });
    const env = normalizeFailure(top);
    expect(env.causes.length).toBeGreaterThan(0);
    expect(env.causes[0]?.message).toMatch(/mid|root/);
  });

  it('models AggregateError as sibling set', () => {
    const agg = new AggregateError([new Error('a'), new Error('b')], 'many');
    const env = normalizeFailure(agg);
    expect(env.aggregate?.length).toBe(2);
    expect(env.aggregate?.[0]?.message).toBe('a');
  });

  it('separates public vs operator projections', () => {
    const err = new ToolError('x', 'SYSTEM_ERROR', { stderrTail: 'secret-ish tail' });
    const env = normalizeFailure(err);
    const pub = toPublicFailureProjection(env);
    const op = toOperatorFailureProjection(env);
    expect(pub).not.toHaveProperty('operatorDetail');
    expect(op.operatorDetail).toBeDefined();
    expect(toMachineFailureProjection(env)).not.toHaveProperty('operatorDetail');
  });
});
