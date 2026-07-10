/**
 * worker-datastore — pure gate + denied ambient thunk (ADR-0145).
 */

import { PluginIncompatibleError, SystemError, type Logger } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDeniedWorkerDatastoreThunk,
  resolveDatastoreAccess,
} from '../worker-datastore.js';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('resolveDatastoreAccess', () => {
  it('selects host-rpc-only when command path and marker both agree', () => {
    expect(
      resolveDatastoreAccess('__tool-command-worker', { OPENSIP_CLI_IN_TOOL_WORKER: '1' }),
    ).toBe('host-rpc-only');
  });

  it('selects local when neither marker is present', () => {
    expect(resolveDatastoreAccess('fit', {})).toBe('local');
    expect(resolveDatastoreAccess('graph list', {})).toBe('local');
  });

  it('fails closed on one-sided worker command without marker', () => {
    try {
      resolveDatastoreAccess('__tool-command-worker', {});
      expect.unreachable('expected MODE_MISMATCH');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemError);
      expect((error as SystemError).code).toBe('SYSTEM.WORKER.MODE_MISMATCH');
    }
  });

  it('fails closed on forged marker without worker command path', () => {
    try {
      resolveDatastoreAccess('fit', { OPENSIP_CLI_IN_TOOL_WORKER: '1' });
      expect.unreachable('expected MODE_MISMATCH');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemError);
      expect((error as SystemError).code).toBe('SYSTEM.WORKER.MODE_MISMATCH');
    }
  });
});

describe('buildDeniedWorkerDatastoreThunk', () => {
  it('emits bounded warning then throws PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS', () => {
    const warn = vi.fn();
    const thunk = buildDeniedWorkerDatastoreThunk({ ...logger, warn });
    expect(() => thunk()).toThrow(PluginIncompatibleError);
    try {
      thunk();
    } catch (error) {
      expect((error as PluginIncompatibleError).code).toBe(
        'PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS',
      );
    }
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.worker.datastore.access_denied',
        code: 'PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS',
        mode: 'host-rpc-only',
      }),
    );
    // No project path / tool id / payload in the log payload.
    const payload = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('path');
    expect(payload).not.toHaveProperty('toolId');
    expect(payload).not.toHaveProperty('cwd');
  });

  it('dispose is a no-op (nothing was opened)', () => {
    const thunk = buildDeniedWorkerDatastoreThunk(logger);
    expect(() => thunk.dispose()).not.toThrow();
  });
});
