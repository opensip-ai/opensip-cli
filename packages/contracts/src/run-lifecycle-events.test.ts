import { describe, expect, it, vi } from 'vitest';

import {
  configLifecycleEvent,
  deliveryLifecycleEvent,
  emitAnalysisLifecycleEvent,
  runLifecycleEvent,
  unitLifecycleEvent,
} from './run-lifecycle-events.js';

import type { ToolCliContext } from '@opensip-cli/core';

function stubCli() {
  const diagnostics = { event: vi.fn() };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    cli: {
      scope: { diagnostics },
      logger,
    } as unknown as ToolCliContext,
    diagnostics,
    logger,
  };
}

describe('analysis lifecycle events', () => {
  it('uses bounded three-part event names', () => {
    const records = [
      runLifecycleEvent('analysis.run.started'),
      unitLifecycleEvent('analysis.unit.completed', { unit: 'rule', skipped: undefined }),
      deliveryLifecycleEvent('analysis.delivery.failed', { reason: 'network' }),
      configLifecycleEvent('analysis.config.read', { namespace: 'graph' }),
    ];

    for (const record of records) {
      expect(record.event.split('.')).toHaveLength(3);
      expect(record.metadata).not.toHaveProperty('skipped');
    }
  });

  it('emits through diagnostics and logger when present', () => {
    const { cli, diagnostics, logger } = stubCli();

    emitAnalysisLifecycleEvent(
      cli,
      deliveryLifecycleEvent('analysis.delivery.started', { tool: 'graph' }),
    );

    expect(diagnostics.event).toHaveBeenCalledWith(
      'deliver',
      'debug',
      'analysis.delivery.started',
      { tool: 'graph' },
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'analysis.delivery.started',
        module: 'contracts:analysis-run',
        tool: 'graph',
      }),
    );
  });

  it('routes config and run events to the correct diagnostic phases', () => {
    const { cli, diagnostics } = stubCli();

    emitAnalysisLifecycleEvent(cli, configLifecycleEvent('analysis.config.rejected'));
    emitAnalysisLifecycleEvent(cli, configLifecycleEvent('analysis.config.defaulted'));
    emitAnalysisLifecycleEvent(cli, runLifecycleEvent('analysis.run.failed'));

    expect(diagnostics.event).toHaveBeenNthCalledWith(
      1,
      'error',
      'debug',
      'analysis.config.rejected',
      {},
    );
    expect(diagnostics.event).toHaveBeenNthCalledWith(
      2,
      'load',
      'debug',
      'analysis.config.defaulted',
      {},
    );
    expect(diagnostics.event).toHaveBeenNthCalledWith(
      3,
      'execute',
      'debug',
      'analysis.run.failed',
      {},
    );
    expect(() =>
      emitAnalysisLifecycleEvent({} as ToolCliContext, runLifecycleEvent('analysis.run.completed')),
    ).not.toThrow();
  });
});
