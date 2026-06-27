import { ConfigurationError, LoggerImpl } from '@opensip-cli/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildDatastoreLockContext, resolveStateLockPolicy } from '../state-lock-policy.js';

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
});
