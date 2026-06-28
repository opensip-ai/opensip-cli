import { describe, it, expect } from 'vitest';

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
  ok,
  err,
  tryCatch,
  tryCatchAsync,
} from '../../lib/errors.js';

import type { Result } from '../../lib/errors.js';

describe('ToolError', () => {
  it('sets message, code, and name', () => {
    const err = new ToolError('something broke', 'CUSTOM_CODE');
    expect(err.message).toBe('something broke');
    expect(err.code).toBe('CUSTOM_CODE');
    expect(err.name).toBe('ToolError');
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
