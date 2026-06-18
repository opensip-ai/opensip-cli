import { describe, expect, it, vi } from 'vitest';

import { defineCommand } from '../command-spec.js';
import { defineTool } from '../define-tool.js';
import { resolveToolCommandNames } from '../derive-commands-from-specs.js';

const noopHandler = vi.fn(async (): Promise<void> => {
  await Promise.resolve();
});

describe('defineTool', () => {
  it('derives commands[] from commandSpecs', () => {
    const tool = defineTool({
      metadata: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'demo',
        version: '0.0.0',
        description: 'demo tool',
      },
      commandSpecs: [
        defineCommand({
          name: 'demo-run',
          description: 'Run demo',
          commonFlags: ['json', 'cwd'],
          scope: 'project',
          output: 'signal-envelope',
          handler: noopHandler,
        }),
        defineCommand({
          name: 'demo-list',
          description: 'List demo',
          commonFlags: ['json', 'cwd'],
          scope: 'project',
          output: 'command-result',
          handler: noopHandler,
        }),
      ],
      extensionPoints: {
        initialize: noopHandler,
      },
    });

    expect(resolveToolCommandNames(tool)).toEqual(['demo-run', 'demo-list']);
    expect(tool.commands.map((c) => c.name)).toEqual(['demo-run', 'demo-list']);
    expect(tool.extensionPoints?.initialize).toBeTypeOf('function');
    expect(tool.contributeScope).toBeUndefined();
  });
});
