/**
 * worker-datastore — pure gate + denied ambient thunk (ADR-0145).
 */

import { PluginIncompatibleError, SystemError, type Logger } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';
import {
  buildDeniedWorkerDatastoreThunk,
  resolveDatastoreAccess,
  resolveStartupExecutionMode,
} from '../worker-datastore.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const WIRING_INVALID = hostErrorCatalog.require('SYSTEM.HOST.WIRING_INVALID');

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('resolveDatastoreAccess', () => {
  it('selects host-rpc-only when either worker command path and marker agree', () => {
    expect(
      resolveDatastoreAccess('__tool-command-worker', {
        OPENSIP_CLI_IN_TOOL_WORKER: '1',
      }),
    ).toBe('host-rpc-only');
    expect(
      resolveDatastoreAccess('__capability-pack-worker', {
        OPENSIP_CLI_IN_TOOL_WORKER: '1',
      }),
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
      expect((error as SystemError).code).toBe('SYSTEM.HOST.WIRING_INVALID');
    }
  });

  it('fails closed on forged marker without worker command path', () => {
    try {
      resolveDatastoreAccess('fit', { OPENSIP_CLI_IN_TOOL_WORKER: '1' });
      expect.unreachable('expected MODE_MISMATCH');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemError);
      expect((error as SystemError).code).toBe('SYSTEM.HOST.WIRING_INVALID');
    }
  });
});

describe('resolveStartupExecutionMode', () => {
  it('derives each worker authority only from the exact first command and marker pair', () => {
    expect(
      resolveStartupExecutionMode(
        ['__tool-command-worker', '/project/spec.json', '--cwd', '/project'],
        { OPENSIP_CLI_IN_TOOL_WORKER: '1' },
      ),
    ).toBe('external-tool-worker');
    expect(
      resolveStartupExecutionMode(
        ['__capability-pack-worker', '/project/spec.json', '--cwd', '/project'],
        { OPENSIP_CLI_IN_TOOL_WORKER: '1' },
      ),
    ).toBe('capability-pack-worker');
    expect(resolveStartupExecutionMode(['tools', 'list'], {})).toBe('host');
  });

  it('rejects a forged marker before startup discovery', () => {
    expect(() =>
      resolveStartupExecutionMode(['tools', 'list'], {
        OPENSIP_CLI_IN_TOOL_WORKER: '1',
      }),
    ).toThrow(
      expect.objectContaining({
        code: WIRING_INVALID.code,
        definition: WIRING_INVALID,
        metadata: { condition: 'worker-mode-mismatch' },
      }),
    );
  });

  it('rejects the internal command without the host marker', () => {
    expect(() =>
      resolveStartupExecutionMode(['__tool-command-worker', '/project/spec.json'], {}),
    ).toThrow(
      expect.objectContaining({
        code: WIRING_INVALID.code,
        definition: WIRING_INVALID,
        metadata: { condition: 'worker-mode-mismatch' },
      }),
    );
    expect(() =>
      resolveStartupExecutionMode(['__capability-pack-worker', '/project/spec.json'], {}),
    ).toThrow(
      expect.objectContaining({
        code: WIRING_INVALID.code,
        definition: WIRING_INVALID,
        metadata: { condition: 'worker-mode-mismatch' },
      }),
    );
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
      expect((error as PluginIncompatibleError).code).toBe('PLUGIN.WORKER.DATASTORE_DIRECT_ACCESS');
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
