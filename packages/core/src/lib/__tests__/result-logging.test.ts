import { afterEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '../errors.js';
import { logger } from '../logger.js';
import { matchLog, unwrapOrLog } from '../result-logging.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unwrapOrLog', () => {
  it('returns the success value and logs nothing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(unwrapOrLog(ok(42), -1, { evt: 'demo.ok' })).toBe(42);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('returns the fallback and logs at warn by default on failure', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const boom = new Error('boom');

    expect(unwrapOrLog(err(boom), 'fallback', { evt: 'demo.failed', id: 7 })).toBe('fallback');

    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.evt).toBe('demo.failed');
    expect(payload.id).toBe(7);
    expect(payload.message).toBe('boom');
    expect(payload.err).toBe(boom);
  });

  it('honors an explicit level and never leaks the level control field into context', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    expect(
      unwrapOrLog(err(new Error('nope')), null, { evt: 'demo.failed', level: 'error' }),
    ).toBeNull();

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    const payload = error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('level');
    expect(payload.evt).toBe('demo.failed');
  });

  it('formats non-Error failures into a readable message', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    unwrapOrLog(err('plain string failure'), 0, { evt: 'demo.failed' });

    const payload = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.message).toBe('plain string failure');
  });
});

describe('matchLog', () => {
  it('runs onOk without logging for success', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const result = matchLog(
      ok({ name: 'ada' }),
      (u) => u.name,
      () => 'unknown',
      { evt: 'user.ok' },
    );

    expect(result).toBe('ada');
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs before running onErr for failure', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const seen: unknown[] = [];
    const boom = new Error('down');

    const result = matchLog(
      err(boom),
      () => 'ok',
      (e) => {
        // onErr must run *after* the log so the failure is always observable.
        expect(warn).toHaveBeenCalledTimes(1);
        seen.push(e);
        return 'recovered';
      },
      { evt: 'user.failed' },
    );

    expect(result).toBe('recovered');
    expect(seen).toEqual([boom]);
    expect((warn.mock.calls[0]?.[0] as Record<string, unknown>).evt).toBe('user.failed');
  });
});
