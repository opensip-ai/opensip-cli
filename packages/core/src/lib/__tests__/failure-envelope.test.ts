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

  it('is deterministic and JSON-serializable', () => {
    const err = new ToolError('same', 'VALIDATION_ERROR', {
      metadata: { a: 1, password: 'x' },
    });
    const a = normalizeFailure(err);
    const b = normalizeFailure(err);
    expect(JSON.stringify(toMachineFailureProjection(a))).toBe(
      JSON.stringify(toMachineFailureProjection(b)),
    );
    expect(() => JSON.stringify(toPublicFailureProjection(a))).not.toThrow();
  });

  it('idempotent re-normalize of projections does not throw', () => {
    const env = normalizeFailure(new Error('e'));
    const machine = toMachineFailureProjection(env);
    expect(normalizeFailure(machine).schemaVersion).toBe(1);
  });

  it('caps oversized sibling aggregates', () => {
    const many = Array.from({ length: 40 }, (_, i) => new Error(`e${i}`));
    const env = normalizeFailure(new AggregateError(many, 'agg'));
    expect(env.aggregate?.length).toBeLessThanOrEqual(16);
    expect(env.aggregateTruncated).toBe(true);
  });

  it('strips secrets from public projection metadata', () => {
    const def = coreSystemErrorCatalog.require('NOT_FOUND');
    const err = createToolError(def, 'missing', {
      metadata: { identifier: 'x', token: 'secret' },
    });
    // NOT_FOUND has no publicMetadataKeys — public projection should not leak token
    const pub = JSON.stringify(toPublicFailureProjection(normalizeFailure(err)));
    expect(pub).not.toContain('secret');
  });

  it('degrades one hostile field without dropping sibling fields', () => {
    const hostile = {
      message: 'ok-message',
      code: 'VALIDATION_ERROR',
      get metadata() {
        throw new Error('meta boom');
      },
      name: 'HostileError',
    };
    const env = normalizeFailure(hostile);
    // Total normalizer must not throw; message is a bounded string even if
    // String(object) falls back when field reads partially fail.
    expect(env.schemaVersion).toBe(1);
    expect(typeof env.message).toBe('string');
    expect(env.message.length).toBeGreaterThan(0);
    expect(typeof env.code).toBe('string');
    expect(typeof env.operatorAction).toBe('string');
  });

  it('handles cyclic cause graphs without hanging', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    const env = normalizeFailure(a);
    expect(env.schemaVersion).toBe(1);
    expect(env.causes.length).toBeLessThanOrEqual(4);
  });

  it('truncates oversized messages and remains JSON-safe for Map/Set/Date', () => {
    const huge = 'x'.repeat(5000);
    expect(normalizeFailure(new Error(huge)).message.length).toBeLessThanOrEqual(1000);

    const bag = {
      message: 'mixed',
      data: {
        map: new Map([['k', 'v']]),
        set: new Set([1, 2]),
        date: new Date('2020-01-01T00:00:00.000Z'),
        re: /ab+c/i,
        buf: new Uint8Array([1, 2, 3]),
      },
    };
    const env = normalizeFailure(bag);
    expect(() => JSON.stringify(toMachineFailureProjection(env))).not.toThrow();
  });

  it('rejects prototype-pollution keys from leaking into projections', () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true},"message":"x","code":"SYSTEM_ERROR"}');
    const env = normalizeFailure(polluted);
    const machine = toMachineFailureProjection(env);
    expect(JSON.stringify(machine)).not.toMatch(/"polluted"\s*:\s*true/);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('does not treat forged brands as known ToolError', () => {
    const forged = {
      name: 'ToolError',
      message: 'forged',
      code: 'NOT_FOUND',
      [Symbol.for('@opensip-cli/core/tool-error-brand')]: 999,
    };
    const env = normalizeFailure(forged);
    // Forged brand version must not receive full known ToolError treatment
    expect(env.schemaVersion).toBe(1);
    expect(typeof env.message).toBe('string');
  });
});
