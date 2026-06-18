import { describe, expect, it } from 'vitest';

import { resolveToolHooks } from '../resolve-tool-hooks.js';

import type { Tool } from '../types.js';

describe('resolveToolHooks', () => {
  it('prefers top-level hooks over extensionPoints during migration', () => {
    const topInit = async () => {};
    const bagInit = async () => {};
    const tool = {
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
      initialize: topInit,
      extensionPoints: { initialize: bagInit },
    } as Tool;

    expect(resolveToolHooks(tool).initialize).toBe(topInit);
  });

  it('reads hooks from extensionPoints when top-level is absent', () => {
    const bagInit = async () => {};
    const tool = {
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
      extensionPoints: { initialize: bagInit, config: { namespace: 'x', schema: {} as never } },
    } as Tool;

    const hooks = resolveToolHooks(tool);
    expect(hooks.initialize).toBe(bagInit);
    expect(hooks.config?.namespace).toBe('x');
  });
});