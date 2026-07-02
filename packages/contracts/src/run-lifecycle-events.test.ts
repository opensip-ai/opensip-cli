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
});
