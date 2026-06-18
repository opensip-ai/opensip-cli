import { describe, expect, it } from 'vitest';

import { resolveToolHooks } from '../resolve-tool-hooks.js';

import type { Tool } from '../types.js';

async function bagInit(): Promise<void> {
  await Promise.resolve();
}

describe('resolveToolHooks', () => {
  it('reads hooks from extensionPoints only', () => {
    const tool = {
      metadata: { id: 'x', name: 'x', version: '0', description: 'x' },
      commands: [{ name: 'x', description: 'x' }],
      extensionPoints: { initialize: bagInit, config: { namespace: 'x', schema: {} } },
    } as Tool;

    const hooks = resolveToolHooks(tool);
    expect(hooks.initialize).toBe(bagInit);
    expect(hooks.config?.namespace).toBe('x');
  });
});
