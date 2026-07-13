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
      'audit',
      'suite run',
      'sessions list',
      'sessions show',
      'agent-catalog',
      'policy status',
      'policy explain',
      'policy audit',
    ]);
    expect(catalog.commonPatterns.length).toBeGreaterThan(0);
    expect(
      catalog.commonPatterns.some((pattern) => pattern.description.includes('review_change')),
    ).toBe(true);
    expect(JSON.stringify(catalog)).toContain('MCP review_change');
    expect(JSON.stringify(catalog)).toContain('opensip audit --json');
    expect(JSON.stringify(catalog)).toContain('opensip audit --files src/server.ts --json');
    expect(JSON.stringify(catalog)).toContain('opensip suite run security --json');
    expect(JSON.stringify(catalog)).toContain('opensip policy explain installed-tool:audit-sec');
    expect(catalog.outputShapes.reviewBrief).toMatch(/reviewBrief|version: 1/);
    expect(catalog.outputShapes.reviewBrief).toContain(
      'scope?: { mode, source, ref?, changedFiles?, notice? }',
    );
    expect(catalog.outputShapes.reviewBrief).toContain('runId?');
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

  it('includes project context only when target conventions are present and describes non-json command output', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'plain' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000206',
        name: 'plain',
        version: '0.0.0',
        description: 'plain tool',
      },
      commands: [],
      commandSpecs: [
        defineCommand({
          name: 'plain',
          description: 'Run plain output',
          commonFlags: ['cwd'],
          scope: 'project',
          output: 'command-result',
          handler: noopHandler,
        }),
      ],
    });

    expect(
      buildAgentCatalog({
        projectContext: { targetConventions: [] },
      }).projectContext,
    ).toBeUndefined();

    const catalog = buildAgentCatalog({
      tools,
      projectContext: {
        targetConventions: [
          {
            target: 'src',
            entrypointCount: 0,
            alwaysUsedCount: 1,
            usedExportCount: 0,
          },
        ],
      },
    });

    const plain = catalog.entryPoints.find((entry) => entry.command === 'plain');
    expect(plain?.examples).toEqual(['opensip plain']);
    expect(plain?.description).toContain('does not declare --json');
    expect(catalog.projectContext?.targetConventions).toHaveLength(1);
  });
});
