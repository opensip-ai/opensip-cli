import { describe, expect, it } from 'vitest';

import { PluginIncompatibleError } from '../../lib/errors.js';
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
      extensionPoints: {
        initialize: bagInit,
        config: { namespace: 'x', schema: {} },
      },
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

    expect((scope as RunScope & { x?: { ready: boolean } }).x).toEqual({
      ready: true,
    });
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

    expect((scope as RunScope & { x?: { ready: boolean } }).x).toEqual({
      ready: true,
    });
    expect(disposeCount).toBe(1);
  });

  it('rejects null/array/non-object contributions', () => {
    for (const bad of [null, [1], 'x', 1] as const) {
      const tool = {
        identity: { name: 'bad' },
        metadata: { id: 'b', name: 'b', version: '0', description: 'b' },
        commands: [{ name: 'b', description: 'b' }],
        extensionPoints: { contributeScope: () => bad as never },
      } as Tool;
      expect(() => applyToolContributeScope(new RunScope(), tool)).toThrow(PluginIncompatibleError);
    }
  });

  it('rejects forbidden and prototype-shadow keys', () => {
    for (const key of ['constructor', '__proto__', 'prototype', 'dispose']) {
      const tool = {
        identity: { name: 'bad' },
        metadata: { id: 'b', name: 'b', version: '0', description: 'b' },
        commands: [{ name: 'b', description: 'b' }],
        extensionPoints: {
          contributeScope: () => ({ [key]: { hijack: true } }),
        },
      } as Tool;
      expect(() => applyToolContributeScope(new RunScope(), tool)).toThrow(
        /forbidden scope key|overwrite scope key/,
      );
    }
  });

  it('rejects host slot overwrite and cross-tool collision', () => {
    const scope = new RunScope();
    const first = {
      identity: { name: 'a' },
      metadata: { id: 'a', name: 'a', version: '0', description: 'a' },
      commands: [{ name: 'a', description: 'a' }],
      extensionPoints: { contributeScope: () => ({ shared: { owner: 'a' } }) },
    } as Tool;
    applyToolContributeScope(scope, first);

    expect(() =>
      applyToolContributeScope(scope, {
        ...first,
        metadata: { ...first.metadata, id: 'b', name: 'b' },
        extensionPoints: { contributeScope: () => ({ logger: {} }) },
      } as Tool),
    ).toThrow(/overwrite scope key 'logger'/);

    expect(() =>
      applyToolContributeScope(scope, {
        ...first,
        metadata: { ...first.metadata, id: 'c', name: 'c' },
        extensionPoints: { contributeScope: () => ({ shared: { owner: 'c' } }) },
      } as Tool),
    ).toThrow(/overwrite scope key 'shared'/);
  });

  it('installs valid disjoint slots from two tools', () => {
    const scope = new RunScope();
    applyToolContributeScope(scope, {
      identity: { name: 'a' },
      metadata: { id: 'a', name: 'a', version: '0', description: 'a' },
      commands: [{ name: 'a', description: 'a' }],
      extensionPoints: { contributeScope: () => ({ alpha: { v: 1 } }) },
    } as Tool);
    applyToolContributeScope(scope, {
      identity: { name: 'b' },
      metadata: { id: 'b', name: 'b', version: '0', description: 'b' },
      commands: [{ name: 'b', description: 'b' }],
      extensionPoints: { contributeScope: () => ({ beta: { v: 2 } }) },
    } as Tool);
    expect((scope as RunScope & { alpha: { v: number }; beta: { v: number } }).alpha.v).toBe(1);
    expect((scope as RunScope & { alpha: { v: number }; beta: { v: number } }).beta.v).toBe(2);
  });
});
