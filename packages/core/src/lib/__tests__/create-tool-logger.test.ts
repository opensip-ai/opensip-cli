import { describe, expect, it, vi } from 'vitest';

import { createToolLogger } from '../create-tool-logger.js';
import { LoggerImpl } from '../logger.js';
import { RunScope, runWithScopeSync } from '../run-scope.js';

describe('createToolLogger', () => {
  it('stamps module and preserves evt on object entries', () => {
    const base = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    };
    const log = createToolLogger('mytool:cli', base);
    log.info({ evt: 'mytool.run.start', extra: 1 });
    expect(base.info).toHaveBeenCalledWith({
      module: 'mytool:cli',
      evt: 'mytool.run.start',
      extra: 1,
    });
  });

  it('does not let caller module override the helper module', () => {
    const base = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const log = createToolLogger('fixed:module', base);
    log.info({ evt: 'x', module: 'other' });
    expect(base.info).toHaveBeenCalledWith({ module: 'fixed:module', evt: 'x' });
  });

  it('supports string message entries', () => {
    const base = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    const log = createToolLogger('simulation:scenario', base);
    log.warn('hello', { evt: 'simulation.scenario.warn', scenarioId: 's1' });
    expect(base.warn).toHaveBeenCalledWith({
      module: 'simulation:scenario',
      msg: 'hello',
      evt: 'simulation.scenario.warn',
      scenarioId: 's1',
    });
  });

  it('uses scope logger under ALS when no base is supplied', () => {
    const scopeLogger = new LoggerImpl({ level: 'debug' });
    const scope = new RunScope({ logger: scopeLogger });
    const writes: Record<string, unknown>[] = [];
    const spy = vi.spyOn(scopeLogger, 'info').mockImplementation((entry) => {
      writes.push(typeof entry === 'string' ? { msg: entry } : entry);
    });
    runWithScopeSync(scope, () => {
      createToolLogger('fitness:cli').info({ evt: 'fit.run.start' });
    });
    expect(writes[0]).toMatchObject({ module: 'fitness:cli', evt: 'fit.run.start' });
    spy.mockRestore();
  });
});
