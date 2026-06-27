import { ConfigurationError, LoggerImpl, RunScope, runWithScopeSync } from '@opensip-cli/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDatastoreLockContext,
  createStateLockEventBridge,
  resolveStateLockPolicy,
} from '../state-lock-policy.js';

describe('resolveStateLockPolicy', () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function setEnv(name: string, value: string | undefined): void {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  it('uses local default wait when CI is unset', () => {
    setEnv('CI', undefined);
    setEnv('OPENSIP_STATE_LOCK_WAIT_MS', undefined);
    expect(resolveStateLockPolicy().waitMs).toBe(30_000);
  });

  it('uses CI default wait when CI is set', () => {
    setEnv('CI', 'true');
    setEnv('OPENSIP_STATE_LOCK_WAIT_MS', undefined);
    expect(resolveStateLockPolicy().waitMs).toBe(5000);
  });

  it('rejects invalid wait override', () => {
    setEnv('OPENSIP_STATE_LOCK_WAIT_MS', 'nope');
    expect(() => resolveStateLockPolicy()).toThrow(ConfigurationError);
  });

  it('honours explicit stale-lock overrides', () => {
    setEnv('OPENSIP_STATE_LOCK_STALE_MS', '120000');
    expect(resolveStateLockPolicy().staleMs).toBe(120_000);
  });

  it('treats CI=false and CI=0 as non-CI for default wait timing', () => {
    setEnv('OPENSIP_STATE_LOCK_WAIT_MS', undefined);
    setEnv('CI', 'false');
    expect(resolveStateLockPolicy().waitMs).toBe(30_000);
    setEnv('CI', '0');
    expect(resolveStateLockPolicy().waitMs).toBe(30_000);
    setEnv('CI', '');
    expect(resolveStateLockPolicy().waitMs).toBe(30_000);
  });

  it('rejects invalid stale-lock overrides', () => {
    setEnv('OPENSIP_STATE_LOCK_STALE_MS', '-1');
    expect(() => resolveStateLockPolicy()).toThrow(ConfigurationError);
  });
});

describe('buildDatastoreLockContext', () => {
  const logger = new LoggerImpl({ level: 'error' });

  it('records the resolved command label and cwd basename in lock metadata', () => {
    const ctx = buildDatastoreLockContext(logger, { commandName: 'fit', cwd: '/projects/demo' });
    expect(ctx.command).toBe('fit');
    expect(ctx.cwdBasename).toBe('demo');
  });

  it('leaves the command undefined when no label is supplied', () => {
    const ctx = buildDatastoreLockContext(logger, { cwd: '/projects/demo' });
    expect(ctx.command).toBeUndefined();
  });

  it('defaults the cwd basename to process.cwd() when cwd is omitted', () => {
    const ctx = buildDatastoreLockContext(logger);
    expect(ctx.cwdBasename).toBeTruthy();
  });
});

describe('createStateLockEventBridge', () => {
  it('logs acquire.timeout as a warning on the diagnostics persist phase', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    const scope = new RunScope({ logger: new LoggerImpl({ level: 'error' }), runId: 'run-lock' });
    const bridge = createStateLockEventBridge(logger);

    runWithScopeSync(scope, () => {
      bridge({
        kind: 'acquire.timeout',
        lockPath: 'demo.lock',
        resource: 'datastore',
        operation: 'datastore.open',
        waitMs: 5000,
        ownerPid: 42,
        ownerHostname: 'host',
      });
    });

    const timeout = scope.diagnostics
      .snapshot()
      .events.find((e) => e.message === 'state.lock.acquire.timeout');
    expect(timeout?.level).toBe('warn');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'state.lock.acquire.timeout' }),
    );
  });

  it('logs non-timeout lock events at info severity', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    const bridge = createStateLockEventBridge(logger);
    bridge({
      kind: 'acquire.start',
      lockPath: 'demo.lock',
      resource: 'artifact',
      operation: 'artifact.write',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ evt: 'state.lock.acquire.start' }),
    );
  });
});
