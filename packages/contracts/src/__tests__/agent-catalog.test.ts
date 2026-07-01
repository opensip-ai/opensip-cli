import { defineCommand, ToolRegistry, type Tool } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildAgentCatalog } from '../agent-catalog.js';

const noopHandler = (): Promise<{ type: 'text-lines'; lines: string[] }> =>
  Promise.resolve({ type: 'text-lines', lines: [] });

function fixtureTool(over: Partial<Tool> & Pick<Tool, 'metadata'>): Tool {
  return {
    identity: { name: over.metadata.name },
    commands: [],
    commandSpecs: [
      defineCommand({
        name: over.metadata.name,
        description: `${over.metadata.name} primary`,
        commonFlags: ['json'],
        scope: 'project',
        output: 'command-result',
        handler: noopHandler,
      }),
    ],
    ...over,
  };
}

describe('buildAgentCatalog', () => {
  it('returns platform entry points when no registry is supplied', () => {
    const catalog = buildAgentCatalog();
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.entryPoints.map((entry) => entry.command)).toEqual([
      'sessions list',
      'sessions show',
      'agent-catalog',
    ]);
    expect(catalog.commonPatterns.length).toBeGreaterThan(0);
    expect(catalog.notes.length).toBeGreaterThan(0);
  });

  it('derives sorted tool entry points with overlays and excludes internal commands', () => {
    const tools = new ToolRegistry();
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000201',
          name: 'graph',
          version: '0.0.0',
          description: 'graph tool',
        },
      }),
    );
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000202',
          name: 'fitness',
          version: '0.0.0',
          description: 'fitness tool',
        },
        identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
        commandSpecs: [
          defineCommand({
            name: 'fitness',
            description: 'Run fitness',
            commonFlags: ['json'],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
        ],
      }),
    );
    tools.register({
      identity: { name: 'hidden-worker' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000203',
        name: 'hidden-worker',
        version: '0.0.0',
        description: 'internal only',
      },
      commands: [],
      commandSpecs: [
        defineCommand({
          name: 'hidden-worker-run-worker',
          description: 'internal worker',
          visibility: 'internal',
          commonFlags: [],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'worker-ipc',
          handler: noopHandler,
        }),
      ],
    });

    const catalog = buildAgentCatalog({ tools });
    const commands = catalog.entryPoints.map((entry) => entry.command);

    expect(commands).toContain('fitness');
    expect(commands).toContain('graph');
    expect(commands).not.toContain('hidden-worker-run-worker');
    expect(commands.indexOf('fitness')).toBeLessThan(commands.indexOf('graph'));
    expect(catalog.entryPoints.find((entry) => entry.command === 'fitness')?.tier).toBe('tool');
    expect(catalog.entryPoints.find((entry) => entry.command === 'fitness')?.examples?.[0]).toMatch(
      /agent-fast/,
    );
  });

  it('honours the internalCommands denylist', () => {
    const tools = new ToolRegistry();
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000204',
          name: 'alpha',
          version: '0.0.0',
          description: 'alpha tool',
        },
      }),
    );

    const catalog = buildAgentCatalog({
      tools,
      internalCommands: new Set(['alpha']),
    });

    expect(catalog.entryPoints.map((entry) => entry.command)).not.toContain('alpha');
  });

  it('does not synthesize --json examples for primaries that do not declare json', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'mcp' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000205',
        name: 'mcp',
        version: '0.0.0',
        description: 'mcp tool',
      },
      commands: [],
      commandSpecs: [
        defineCommand({
          name: 'mcp',
          description: 'Serve MCP over stdio',
          commonFlags: ['cwd'],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'mcp-stdio',
          handler: noopHandler,
        }),
      ],
    });

    const catalog = buildAgentCatalog({ tools });
    const mcp = catalog.entryPoints.find((entry) => entry.command === 'mcp');

    expect(mcp?.examples).toEqual(['opensip mcp']);
    expect(mcp?.description).toMatch(/Raw-stream transport/);
  });
});
