import { describe, expect, it } from 'vitest';

import { RunScope } from '../../lib/run-scope.js';
import { applyToolContributeScope, resolveToolHooks } from '../resolve-tool-hooks.js';

import type { Tool } from '../types.js';

async function bagInit(): Promise<void> {
  await Promise.resolve();
}

describe('resolveToolHooks', () => {
  it('reads hooks from extensionPoints only', () => {
    const tool = {
      identity: { name: 'test-tool' },
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
      extensionPoints: { initialize: bagInit, config: { namespace: 'x', schema: {} } },
    } as Tool;

    const hooks = resolveToolHooks(tool);
    expect(hooks.initialize).toBe(bagInit);
    expect(hooks.config?.namespace).toBe('x');
  });

  it('returns empty hook slots when the tool has no extensionPoints bag', () => {
    const tool = {
      identity: { name: 'test-tool' },
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
    } as Tool;

    expect(resolveToolHooks(tool)).toEqual({
      initialize: undefined,
      contributeScope: undefined,
      collectReportData: undefined,
      sessionReplay: undefined,
      config: undefined,
      capabilityRegistrars: undefined,
      fingerprintStrategy: undefined,
      scaffoldExamples: undefined,
      stableExampleIds: undefined,
      scaffoldConfigBlock: undefined,
    });
  });
});

describe('applyToolContributeScope', () => {
  it('leaves the scope untouched when no contribution is supplied', () => {
    const scope = new RunScope();
    const tool = {
      identity: { name: 'test-tool' },
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
      extensionPoints: {},
    } as Tool;

    applyToolContributeScope(scope, tool);

    expect((scope as RunScope & { x?: unknown }).x).toBeUndefined();
  });

  it('installs a plain scope contribution', () => {
    const scope = new RunScope();
    const tool = {
      identity: { name: 'test-tool' },
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
      extensionPoints: { contributeScope: () => ({ x: { ready: true } }) },
    } as Tool;

    applyToolContributeScope(scope, tool);

    expect((scope as RunScope & { x?: { ready: boolean } }).x).toEqual({ ready: true });
  });

  it('installs a wrapped contribution and registers its disposer', () => {
    const scope = new RunScope();
    let disposeCount = 0;
    const tool = {
      identity: { name: 'test-tool' },
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
      extensionPoints: {
        contributeScope: () => ({
          contribution: { x: { ready: true } },
          onDispose: () => {
            disposeCount += 1;
          },
        }),
      },
    } as Tool;

    applyToolContributeScope(scope, tool);
    scope.dispose();
    scope.dispose();

    expect((scope as RunScope & { x?: { ready: boolean } }).x).toEqual({ ready: true });
    expect(disposeCount).toBe(1);
  });
});
