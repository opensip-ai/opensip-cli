/**
 * @fileoverview Tests for `createScenarioLogger`.
 *
 * The scenario logger wraps the shared core logger with `evt:
 * simulation.scenario.<level>` tags and a stable `scenarioId` field. We
 * spy on each level (info/warn/error/debug) to confirm the wiring.
 */

import { logger as coreLogger } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { createScenarioLogger } from '../scenario-logger.js';

const silent = (): void => {
  // Mock implementation — drops log output during the test.
  return;
};

describe('createScenarioLogger', () => {
  it('forwards info() with scenarioId + simulation.scenario.info evt tag', () => {
    const spy = vi.spyOn(coreLogger, 'info').mockImplementation(silent);
    try {
      const log = createScenarioLogger('sid-info');
      log.info('hello', { extra: 1 });
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg.evt).toBe('simulation.scenario.info');
      expect(arg.scenarioId).toBe('sid-info');
      expect(arg.msg).toBe('hello');
      expect(arg.extra).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('forwards warn() with the right tag', () => {
    const spy = vi.spyOn(coreLogger, 'warn').mockImplementation(silent);
    try {
      const log = createScenarioLogger('sid-warn');
      log.warn('careful');
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg.evt).toBe('simulation.scenario.warn');
      expect(arg.scenarioId).toBe('sid-warn');
    } finally {
      spy.mockRestore();
    }
  });

  it('forwards error() with the err field when an Error is supplied', () => {
    const spy = vi.spyOn(coreLogger, 'error').mockImplementation(silent);
    try {
      const log = createScenarioLogger('sid-err');
      const err = new Error('boom');
      log.error('failed', { err });
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg.evt).toBe('simulation.scenario.error');
      expect(arg.err).toBe(err);
      expect(arg.scenarioId).toBe('sid-err');
    } finally {
      spy.mockRestore();
    }
  });

  it('error() handles a non-Error err in data (no instanceof match)', () => {
    const spy = vi.spyOn(coreLogger, 'error').mockImplementation(silent);
    try {
      const log = createScenarioLogger('sid-err2');
      // data.err is a non-Error string. The logger projects err via
      // `instanceof` (yielding undefined), then spreads `...data` which
      // overwrites with the original string. We assert the scenarioId
      // is correct and the call was made — the err-projection branch
      // is the load-bearing behavior here.
      log.error('failed', { err: 'string-not-error', other: 1 });
      const arg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg.scenarioId).toBe('sid-err2');
      expect(arg.evt).toBe('simulation.scenario.error');
      expect(arg.other).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('error() handles missing data argument', () => {
    const spy = vi.spyOn(coreLogger, 'error').mockImplementation(silent);
    try {
      const log = createScenarioLogger('sid-err3');
      log.error('failed');
      const arg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg.evt).toBe('simulation.scenario.error');
      expect(arg.err).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('forwards debug() with the right tag', () => {
    const spy = vi.spyOn(coreLogger, 'debug').mockImplementation(silent);
    try {
      const log = createScenarioLogger('sid-debug');
      log.debug('details', { a: 'b' });
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(arg.evt).toBe('simulation.scenario.debug');
      expect(arg.scenarioId).toBe('sid-debug');
      expect(arg.a).toBe('b');
    } finally {
      spy.mockRestore();
    }
  });
});
