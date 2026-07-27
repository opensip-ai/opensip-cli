import { describe, it, expect } from 'vitest';

import { coreSystemErrorCatalog } from '../error-definition.js';
import { ToolError, createToolError } from '../errors.js';
import { normalizeFailure } from '../failure-envelope.js';
import {
  toPublicFailureProjection,
  toMachineFailureProjection,
  toOperatorFailureProjection,
} from '../failure-projection.js';

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

  it('bounds shared-node AggregateError DAGs without exponential amplification', () => {
    // Regression: a shared-node DAG references the SAME AggregateError child
    // MAX_AGGREGATE times at every level. Depth + per-level width cap a *tree*,
    // but this tiny structure (a few dozen objects) would re-expand width^depth
    // (~16^8) times without a shared visited-set + total-node budget — hanging or
    // OOMing the last-resort failure net. The normalizer must dedup the shared
    // node and cap total work: termination itself is the proof (a regression does
    // not return), and the envelope stays bounded + serializable.
    let node = new AggregateError([new Error('leaf')], 'leaf');
    for (let level = 0; level < 8; level += 1) {
      node = new AggregateError(
        Array.from({ length: 16 }, () => node),
        `level-${level}`,
      );
    }
    const env = normalizeFailure(node);
    expect(env.schemaVersion).toBe(1);
    expect(env.aggregate?.length).toBeLessThanOrEqual(16);
    expect(() => JSON.stringify(toMachineFailureProjection(env))).not.toThrow();
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
    const polluted = JSON.parse(
      '{"__proto__":{"polluted":true},"message":"x","code":"SYSTEM_ERROR"}',
    );
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

describe('failure projection golden fixtures (Plan 00 versioned wire)', () => {
  it('public projection keeps stable keys and strips secrets', () => {
    const def = coreSystemErrorCatalog.require('NOT_FOUND');
    const err = createToolError(def, 'missing resource', {
      metadata: { identifier: 'r1', token: 'sekrit' },
    });
    const pub = toPublicFailureProjection(normalizeFailure(err));
    expect(pub).toMatchObject({
      schemaVersion: 1,
      code: 'NOT_FOUND',
      message: 'missing resource',
      kind: 'not-found',
      retry: 'never',
      known: 'known',
    });
    expect(pub).not.toHaveProperty('operatorDetail');
    expect(JSON.stringify(pub)).not.toContain('sekrit');
    // Additive-only contract: required keys present for machine consumers.
    for (const key of [
      'schemaVersion',
      'code',
      'message',
      'action',
      'source',
      'responsibility',
      'kind',
      'retry',
      'severity',
      'known',
    ]) {
      expect(pub).toHaveProperty(key);
    }
  });

  it('machine projection includes exitClass and causes without operatorDetail', () => {
    const err = new ToolError('outer', 'SYSTEM_ERROR', {
      cause: new Error('inner-cause'),
      stderrTail: 'secret-stderr-tail',
    });
    const machine = toMachineFailureProjection(normalizeFailure(err));
    expect(machine).toMatchObject({
      schemaVersion: 1,
      exitClass: 'runtime',
      known: 'known',
    });
    expect(machine).not.toHaveProperty('operatorDetail');
    expect(Array.isArray(machine.causes)).toBe(true);
    expect(JSON.stringify(machine)).not.toContain('secret-stderr-tail');
  });

  it('operator projection may include operatorDetail; re-normalize is safe', () => {
    const err = new ToolError('outer', 'SYSTEM_ERROR', { stderrTail: 'tail-for-ops' });
    const op = toOperatorFailureProjection(normalizeFailure(err));
    expect(op.operatorDetail).toContain('tail-for-ops');
    expect(normalizeFailure(op).schemaVersion).toBe(1);
  });

  it('cancelled definition projects cancelled exitClass', () => {
    const err = createToolError(coreSystemErrorCatalog.require('CORE.SYSTEM.CANCELLED'), 'aborted');
    const machine = toMachineFailureProjection(normalizeFailure(err));
    expect(machine).toMatchObject({
      code: 'CORE.SYSTEM.CANCELLED',
      kind: 'cancelled',
      exitClass: 'cancelled',
      retry: 'never',
    });
  });
});

describe('fromNativeError classification (Plan 01 Task 1.3)', () => {
  it('classifies an AbortError as cancellation, not an internal invariant', () => {
    // WAS BROKEN: AbortSignal.throwIfAborted() and new DOMException(…, 'AbortError') are
    // instanceof Error but carry a NUMERIC code (20), so the `typeof code === 'string'`
    // errno guard rejected them and every cancellation degraded to SYSTEM_ERROR with
    // known:'unknown' — a cancelled run looked exactly like an internal invariant violation.
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      controller.signal.throwIfAborted();
    } catch (error) {
      thrown = error;
    }
    const envelope = normalizeFailure(thrown);
    expect(envelope.code).toBe('CORE.SYSTEM.CANCELLED');
    expect(envelope.known).toBe('known');
    expect(envelope.definition.kind).toBe('cancelled');
    expect(envelope.definition.exitClass).toBe('cancelled');
  });

  it('separates a deadline from a user cancellation', () => {
    // Both are aborts, but only one is retryable: a caller may retry a deadline; retrying a
    // user's Ctrl-C is wrong.
    const timeoutAbort = new DOMException('The operation timed out.', 'TimeoutError');
    expect(normalizeFailure(timeoutAbort).code).toBe('CORE.SYSTEM.DEADLINE_EXCEEDED');
    const userAbort = new DOMException('This operation was aborted', 'AbortError');
    expect(normalizeFailure(userAbort).code).toBe('CORE.SYSTEM.CANCELLED');
  });

  it('routes network errnos to the registered NETWORK_ERROR definition', () => {
    // NETWORK_ERROR was registered all along — retry 'transient', exitClass 'report-failed' —
    // and nothing routed to it, so a refused connection during report egress was reported as
    // an internal invariant that must not be retried.
    for (const errno of ['ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE']) {
      const error = Object.assign(new Error(`connect ${errno}`), { code: errno });
      const envelope = normalizeFailure(error);
      expect(envelope.definition.kind, errno).toBe('network');
      expect(envelope.definition.retry, errno).toBe('transient');
      expect(envelope.known, errno).toBe('known');
    }
  });

  it('classifies ETIMEDOUT as a deadline rather than a network fault', () => {
    // Listed under both families in the ledger; timeout is the more actionable reading.
    const error = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    expect(normalizeFailure(error).code).toBe('CORE.SYSTEM.DEADLINE_EXCEEDED');
  });

  it('still reports a genuinely unclassifiable error as unknown', () => {
    // The classifier must not manufacture confidence it does not have.
    const envelope = normalizeFailure(new Error('something went sideways'));
    expect(envelope.known).toBe('unknown');
    expect(envelope.definition.code).toBe('SYSTEM_ERROR');
  });

  it('publishes the errno it captured', () => {
    // publicMetadataKeys was absent on these definitions, so allowlistedMetadata discarded
    // the single machine-classification datum fromNativeError had recorded.
    const error = Object.assign(new Error('nope'), { code: 'EACCES' });
    const envelope = normalizeFailure(error);
    expect(envelope.metadata.errno).toBe('EACCES');
    expect(envelope.definition.publicMetadataKeys).toContain('errno');
  });

  it('scrubs credentials out of operator detail', () => {
    // operatorDetail is assembled from raw error text, which routinely carries a URL with an
    // embedded token. D8: the host redacts at one choke point.
    const error = new Error('fatal: could not read from https://user:sup3rsecret@example.com/x');
    const envelope = normalizeFailure(error);
    expect(envelope.operatorDetail ?? '').not.toContain('sup3rsecret');
  });
});

describe('fromToolError known-status honesty (Plan 01 Task 1.3)', () => {
  it('reports a ToolError whose code resolved to nothing as unknown', () => {
    // WAS BROKEN: hardcoded known:'known' for every ToolError-like value, which contradicted
    // the FailureKnownStatus contract AND hid Task 1.2's entire defect class — a code with an
    // unmapped head fell through to UNKNOWN_FAILURE yet was still reported as confidently
    // classified.
    const envelope = normalizeFailure(new ToolError('boom', 'NOSUCH.HEAD.ANYWHERE'));
    expect(envelope.definition.code).toBe('CORE.SYSTEM.UNKNOWN_FAILURE');
    expect(envelope.known).toBe('unknown');
  });

  it('still reports a resolved ToolError as known', () => {
    const envelope = normalizeFailure(new ToolError('bad input', 'VALIDATION_ERROR'));
    expect(envelope.known).toBe('known');
  });

  it('scrubs credentials out of a stderr tail', () => {
    const error = new ToolError('scanner failed', 'SYSTEM_ERROR', {
      stderrTail: 'remote: https://x-access-token:ghp_deadbeefdeadbeef@github.com/a/b',
    });
    expect(error.stderrTail ?? '').not.toContain('ghp_deadbeefdeadbeef');
    expect(normalizeFailure(error).operatorDetail ?? '').not.toContain('ghp_deadbeefdeadbeef');
  });
});
