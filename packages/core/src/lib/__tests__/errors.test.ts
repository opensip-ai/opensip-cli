import { beforeEach, describe, it, expect, vi } from 'vitest';

import { LanguageRegistry } from '../../languages/registry.js';
import { coreSystemErrorCatalog } from '../../lib/error-definition.js';
import {
  ToolError,
  ValidationError,
  NotFoundError,
  SystemError,
  TimeoutError,
  NetworkError,
  ConfigurationError,
  PluginIncompatibleError,
  UnknownCapabilityDomainError,
  CapabilitySchemaMismatchError,
  canonicalToolErrorCode,
  toolErrorFromCanonicalCode,
  createToolError,
  isToolErrorLike,
  normalizeToolErrorDefinition,
  sanitizeErrorMetadata,
  ok,
  err,
  tryCatch,
  tryCatchAsync,
  resetLegacyOptionBagWarnings,
} from '../../lib/errors.js';
import { RunScope, runWithScope } from '../../lib/run-scope.js';
import { ToolRegistry } from '../../tools/registry.js';

import type { Result } from '../../lib/errors.js';
import type { Logger } from '../../lib/logger.js';

describe('ToolError', () => {
  it('sets message, code, and name', () => {
    const err = new ToolError('something broke', 'CUSTOM_CODE');
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('CUSTOM_CODE');
    expect(err.name).toBe('ToolError');
    expect(err.definition.code).toBe('CORE.SYSTEM.UNKNOWN_FAILURE');
  });

  it('is an instance of Error', () => {
    const err = new ToolError('fail', 'E');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ToolError);
  });

  it('supports cause chaining via options', () => {
    const cause = new Error('root cause');
    const err = new ToolError('wrapper', 'WRAP', { cause });
    expect(err.cause).toBe(cause);
  });

  it('has a stack trace', () => {
    const err = new ToolError('traced', 'T');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('traced');
  });

  it('preserves bounded metadata and strips secrets', () => {
    const err = new ToolError('x', 'VALIDATION_ERROR', {
      metadata: {
        check: 'demo',
        password: 'secret',
        nested: { token: 'nope', ok: 1 },
      },
    });
    expect(err.metadata).toEqual({ check: 'demo', nested: { ok: 1 } });
    expect(err.definition.kind).toBe('validation');
  });

  it('supports definition-first construction', () => {
    const def = coreSystemErrorCatalog.require('NOT_FOUND');
    const err = createToolError(def, 'missing recipe');
    expect(err.code).toBe('NOT_FOUND');
    // Constructor copies through the hostile-input validator instead of
    // retaining a caller-owned mutable object.
    expect(err.definition).toStrictEqual(def);
    expect(err.definition).not.toBe(def);
    expect(Object.isFrozen(err.definition)).toBe(true);
    expect(isToolErrorLike(err)).toBe(true);
  });

  it('sanitizeErrorMetadata is total on hostile input', () => {
    const hostile = {
      get boom() {
        throw new Error('nope');
      },
    };
    expect(sanitizeErrorMetadata(hostile)).toEqual({ boom: '[Accessor]' });
  });

  it('is total on revoked Proxy metadata and definition inputs', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(sanitizeErrorMetadata({ nested: revoked.proxy })).toEqual({
      nested: '[HostileObject]',
    });
    expect(normalizeToolErrorDefinition(revoked.proxy)).toBeUndefined();
    expect(isToolErrorLike(revoked.proxy)).toBe(false);
  });

  it('rejects a forged brand whose code and definition axes disagree', () => {
    const forged = Object.create(ToolError.prototype) as ToolError;
    Object.defineProperties(forged, {
      message: { value: 'forged' },
      code: { value: 'NOT_FOUND' },
      definition: { value: coreSystemErrorCatalog.require('NETWORK_ERROR') },
      [Symbol.for('@opensip-cli/core/tool-error-brand')]: { value: 1 },
    });
    expect(isToolErrorLike(forged)).toBe(false);
  });
});

describe('ValidationError', () => {
  it('defaults code to VALIDATION_ERROR', () => {
    const err = new ValidationError('bad input');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('bad input');
  });

  it('allows custom code via options', () => {
    const err = new ValidationError('bad', { code: 'SCHEMA_FAIL' });
    expect(err.code).toBe('SCHEMA_FAIL');
  });

  it('is an instance of ToolError and Error', () => {
    const err = new ValidationError('v');
    expect(err).toBeInstanceOf(ToolError);
    expect(err).toBeInstanceOf(Error);
  });

  it('supports cause chaining', () => {
    const cause = new TypeError('type issue');
    const err = new ValidationError('invalid', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('NotFoundError', () => {
  it('defaults code to NOT_FOUND', () => {
    const err = new NotFoundError('missing item');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('NotFoundError');
    expect(err.message).toBe('missing item');
  });

  it('allows custom code via options', () => {
    const err = new NotFoundError('gone', { code: 'DELETED' });
    expect(err.code).toBe('DELETED');
  });

  it('is an instance of ToolError', () => {
    expect(new NotFoundError('x')).toBeInstanceOf(ToolError);
  });
});

describe('SystemError', () => {
  it('defaults code to SYSTEM_ERROR', () => {
    const err = new SystemError('disk full');
    expect(err.code).toBe('SYSTEM_ERROR');
    expect(err.name).toBe('SystemError');
    expect(err.message).toBe('disk full');
  });

  it('allows custom code via options', () => {
    const err = new SystemError('crash', { code: 'OOM' });
    expect(err.code).toBe('OOM');
  });

  it('is an instance of ToolError', () => {
    expect(new SystemError('x')).toBeInstanceOf(ToolError);
  });

  it('supports cause chaining', () => {
    const cause = new Error('underlying');
    const err = new SystemError('wrapper', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('TimeoutError', () => {
  it('defaults code to TIMEOUT', () => {
    const err = new TimeoutError('timed out');
    expect(err.code).toBe('TIMEOUT');
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toBe('timed out');
  });

  it('stores timeoutMs when given a number', () => {
    const err = new TimeoutError('slow', 5000);
    expect(err.timeoutMs).toBe(5000);
    expect(err.code).toBe('TIMEOUT');
  });

  it('timeoutMs is undefined when given options instead of number', () => {
    const err = new TimeoutError('slow', { code: 'CUSTOM_TIMEOUT' });
    expect(err.timeoutMs).toBeUndefined();
    expect(err.code).toBe('CUSTOM_TIMEOUT');
  });

  it('timeoutMs is undefined when no second argument', () => {
    const err = new TimeoutError('plain timeout');
    expect(err.timeoutMs).toBeUndefined();
  });

  it('is an instance of ToolError', () => {
    expect(new TimeoutError('x')).toBeInstanceOf(ToolError);
  });

  it('supports cause chaining via options', () => {
    const cause = new Error('network');
    const err = new TimeoutError('timed out', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('NetworkError', () => {
  it('defaults code to NETWORK_ERROR', () => {
    const e = new NetworkError('connection refused');
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.name).toBe('NetworkError');
    expect(e.message).toBe('connection refused');
  });

  it('stores statusCode', () => {
    const e = new NetworkError('server error', { statusCode: 500 });
    expect(e.statusCode).toBe(500);
  });

  it('is an instance of ToolError', () => {
    expect(new NetworkError('x')).toBeInstanceOf(ToolError);
  });
});

describe('ConfigurationError', () => {
  it('defaults code to CONFIGURATION_ERROR', () => {
    const e = new ConfigurationError('bad config');
    expect(e.code).toBe('CONFIGURATION_ERROR');
    expect(e.name).toBe('ConfigurationError');
  });

  it('is an instance of ToolError', () => {
    expect(new ConfigurationError('x')).toBeInstanceOf(ToolError);
  });
});

describe('PluginIncompatibleError (release 2.8.0)', () => {
  it('defaults code to PLUGIN_INCOMPATIBLE and carries the diagnostic', () => {
    const e = new PluginIncompatibleError('tool x is incompatible', {
      diagnostic: 'epoch mismatch',
    });
    expect(e.code).toBe('PLUGIN_INCOMPATIBLE');
    expect(e.name).toBe('PluginIncompatibleError');
    expect(e.diagnostic).toBe('epoch mismatch');
  });

  it('is an instance of ToolError (so the exit-code map can route it)', () => {
    expect(new PluginIncompatibleError('x')).toBeInstanceOf(ToolError);
  });

  it('diagnostic is undefined when not supplied', () => {
    expect(new PluginIncompatibleError('x').diagnostic).toBeUndefined();
  });
});

describe('Result pattern', () => {
  it('ok() creates a success result', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it('err() creates a failure result', () => {
    const error = new ValidationError('bad');
    const result = err(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(error);
    }
  });

  it('Result type narrows correctly', () => {
    const result: Result<number> = ok(10);
    if (result.ok) {
      const val: number = result.value;
      expect(val).toBe(10);
    }
  });

  it('tryCatch returns ok on success', () => {
    const result = tryCatch(() => 42);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it('tryCatch returns err on throw', () => {
    const result = tryCatch(() => {
      throw new Error('boom');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('boom');
  });

  it('tryCatchAsync returns ok on success', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- arrow signature must be `() => Promise<T>` to match tryCatchAsync
    const result = await tryCatchAsync(async () => 'hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('hello');
  });

  it('tryCatchAsync returns err on rejection', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- arrow signature must be `() => Promise<T>` to match tryCatchAsync
    const result = await tryCatchAsync(async () => {
      throw new Error('async boom');
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('async boom');
  });

  it('tryCatchAsync wraps non-Error throws', async () => {
    /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/only-throw-error -- arrow must match `() => Promise<T>`; intentionally throwing a non-Error to verify wrapping */
    const result = await tryCatchAsync(async () => {
      throw 'string error';
    });
    /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/only-throw-error */
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('string error');
  });
});

describe('definition-backed subcodes keep family exit classes', () => {
  it('does not demote PluginIncompatibleError detail codes to UNKNOWN_FAILURE', () => {
    const denied = new PluginIncompatibleError('denied', {
      code: 'PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS',
    });
    expect(denied.code).toBe('PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS');
    expect(denied.definition.exitClass).toBe('plugin-incompatible');
    expect(denied.definition.code).toBe('PLUGIN_INCOMPATIBLE');
  });

  it('does not demote ConfigurationError recovery subcodes to UNKNOWN_FAILURE', () => {
    // The UNREGISTERED legacy literal on purpose — the point is the family fallback, which is
    // what keeps a third-party code under a mapped head from becoming an operator-only fatal.
    // The production recovery site moved to CORE.RUNTIME_RECOVERY.REQUIRED in Plan 01 and is
    // covered by its own catalog test; this one guards the path that has no catalog entry.
    const err = new ConfigurationError('recovery required', {
      code: 'CONFIGURATION.RECOVERY_REQUIRED',
    });
    expect(err.code).toBe('CONFIGURATION.RECOVERY_REQUIRED');
    expect(err.definition.exitClass).toBe('configuration');
    expect(err.definition.code).toBe('CONFIGURATION_ERROR');
  });
});

describe('canonicalToolErrorCode', () => {
  it('maps each typed subclass to its canonical exit-class code', () => {
    expect(canonicalToolErrorCode(new NotFoundError('x'))).toBe('NOT_FOUND');
    expect(canonicalToolErrorCode(new ConfigurationError('x'))).toBe('CONFIGURATION_ERROR');
    expect(canonicalToolErrorCode(new ValidationError('x'))).toBe('VALIDATION_ERROR');
    expect(canonicalToolErrorCode(new NetworkError('x'))).toBe('NETWORK_ERROR');
    expect(canonicalToolErrorCode(new PluginIncompatibleError('x'))).toBe('PLUGIN_INCOMPATIBLE');
    expect(canonicalToolErrorCode(new TimeoutError('x'))).toBe('TIMEOUT');
    expect(canonicalToolErrorCode(new SystemError('x'))).toBe('SYSTEM_ERROR');
    expect(canonicalToolErrorCode(new ToolError('x', 'CUSTOM'))).toBe('SYSTEM_ERROR');
  });

  it('collapses deeper subclasses to their canonical parent bucket', () => {
    // A subcode-carrying ConfigurationError (e.g. the gate baseline-missing fault)
    // still maps to the CONFIGURATION_ERROR bucket — the carry is keyed on the
    // instanceof class, not the (open) subcode.
    const gate = new ConfigurationError('no baseline', {
      code: 'CONFIGURATION.GATE.BASELINE_MISSING',
    });
    expect(canonicalToolErrorCode(gate)).toBe('CONFIGURATION_ERROR');
    expect(
      canonicalToolErrorCode(
        new UnknownCapabilityDomainError('x', { domainId: 'd', knownDomains: [] }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      canonicalToolErrorCode(
        new CapabilitySchemaMismatchError('x', {
          domainId: 'd',
          ownerToolId: 't',
          diagnostic: 'why',
        }),
      ),
    ).toBe('VALIDATION_ERROR');
  });
});

describe('toolErrorFromCanonicalCode', () => {
  it('rebuilds the matching subclass for each canonical code (round-trips canonicalToolErrorCode)', () => {
    const codes = [
      'NOT_FOUND',
      'CONFIGURATION_ERROR',
      'VALIDATION_ERROR',
      'NETWORK_ERROR',
      'PLUGIN_INCOMPATIBLE',
      'TIMEOUT',
      'SYSTEM_ERROR',
    ] as const;
    for (const code of codes) {
      const rebuilt = toolErrorFromCanonicalCode(code, 'msg');
      expect(rebuilt).toBeInstanceOf(ToolError);
      // The rebuilt instance round-trips back to the SAME canonical bucket.
      expect(canonicalToolErrorCode(rebuilt!)).toBe(code);
    }
    expect(toolErrorFromCanonicalCode('CONFIGURATION_ERROR', 'm')).toBeInstanceOf(
      ConfigurationError,
    );
    expect(toolErrorFromCanonicalCode('NOT_FOUND', 'm')).toBeInstanceOf(NotFoundError);
  });

  it('preserves a supplied subcode on the rebuilt instance', () => {
    const rebuilt = toolErrorFromCanonicalCode('CONFIGURATION_ERROR', 'no baseline', {
      code: 'CONFIGURATION.GATE.BASELINE_MISSING',
    });
    expect(rebuilt).toBeInstanceOf(ConfigurationError);
    expect(rebuilt?.code).toBe('CONFIGURATION.GATE.BASELINE_MISSING');
    expect(rebuilt?.message).toBe('no baseline');
  });

  it('returns undefined for an unrecognized code (caller falls through to its default)', () => {
    expect(toolErrorFromCanonicalCode('NOT_A_REAL_CODE', 'm')).toBeUndefined();
    expect(toolErrorFromCanonicalCode('CONFIGURATION.GATE.BASELINE_MISSING', 'm')).toBeUndefined();
  });
});

describe('legacy option-bag warning (Plan 01 Task 1.3)', () => {
  beforeEach(() => {
    resetLegacyOptionBagWarnings();
  });

  it('warns once per code and key-set, not once per construction', async () => {
    // These constructions sit on hot paths — a per-file walk can raise thousands — and an
    // unbounded warn stream is indistinguishable from noise, which is how a migration signal
    // gets ignored rather than acted on.
    const warn = vi.fn();
    const scope = new RunScope({
      languages: new LanguageRegistry(),
      tools: new ToolRegistry(),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as unknown as Logger,
    });
    const built: ToolError[] = [];
    await runWithScope(scope, () => {
      for (let i = 0; i < 5; i++) {
        built.push(
          new ToolError('x', 'SYSTEM_ERROR', { operation: 'resolve', loader: 'project-config' }),
        );
      }
      return Promise.resolve();
    });
    expect(built).toHaveLength(5);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      evt: 'core.error.legacy_option_bag',
      keys: ['loader', 'operation'],
    });
  });

  it('still preserves the legacy values it warned about', () => {
    // Warning is not deletion: the field stays until the last caller migrates, so nothing
    // that was being captured for triage is silently dropped in the meantime.
    const error = new ToolError('x', 'SYSTEM_ERROR', { operation: 'resolve' });
    expect(error.legacyCompatibility?.operation).toBe('resolve');
  });

  it('does not warn when only documented options are used', async () => {
    const warn = vi.fn();
    const scope = new RunScope({
      languages: new LanguageRegistry(),
      tools: new ToolRegistry(),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as unknown as Logger,
    });
    let built: ToolError | undefined;
    await runWithScope(scope, () => {
      built = new ToolError('x', 'SYSTEM_ERROR', { metadata: { a: 1 }, stderrTail: 'tail' });
      return Promise.resolve();
    });
    expect(built?.legacyCompatibility).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
