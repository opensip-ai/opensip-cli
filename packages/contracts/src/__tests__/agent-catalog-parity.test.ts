import { defineCommand, ToolRegistry, ValidationError, type Tool } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  assertAgentCatalogOverlayKeys,
  buildAgentCatalog,
  type AgentCatalog,
} from '../agent-catalog.js';

const noopHandler = (): { type: 'text-lines'; lines: string[] } => ({
  type: 'text-lines',
  lines: [],
});

function fixtureTool(
  name: string,
  opts: {
    readonly aliases?: readonly string[];
    readonly layoutKey?: string;
    readonly primaryName?: string;
  } = {},
): Tool {
  const primaryName = opts.primaryName ?? name;
  return {
    identity: {
      name,
      ...(opts.aliases === undefined ? {} : { aliases: opts.aliases }),
      ...(opts.layoutKey === undefined ? {} : { layoutKey: opts.layoutKey }),
    },
    metadata: {
      id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, '0')}`,
      name,
      version: '0.0.0',
      description: `${name} fixture`,
    },
    commands: [],
    commandSpecs: [
      defineCommand({
        name: primaryName,
        description: `${primaryName} primary`,
        commonFlags: ['json'],
        scope: 'project',
        output: 'command-result',
        handler: noopHandler,
      }),
    ],
  };
}

function collectExamples(catalog: AgentCatalog): readonly string[] {
  return [
    ...catalog.entryPoints.flatMap((entry) => entry.examples),
    ...catalog.commonPatterns.map((pattern) => pattern.example),
  ];
}

describe('agent-catalog parity contract', () => {
  it('throws ValidationError when a curated overlay key cannot match a tool name or alias', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('alpha'));

    expect(() =>
      assertAgentCatalogOverlayKeys(tools, new Set(), {
        beta: { description: 'stale overlay' },
      }),
    ).toThrow(ValidationError);

    try {
      assertAgentCatalogOverlayKeys(tools, new Set(), {
        beta: { description: 'stale overlay' },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('AGENT_CATALOG.STALE_TOOL_OVERLAY');
    }
  });

  it('accepts a curated overlay key that matches a documented alias or layout key', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('simulation', { aliases: ['sim'], layoutKey: 'sim' }));

    expect(() =>
      assertAgentCatalogOverlayKeys(tools, new Set(), {
        sim: { examples: ['opensip sim --json'] },
      }),
    ).not.toThrow();

    const catalog = buildAgentCatalog({ tools });
    expect(catalog.entryPoints.find((entry) => entry.command === 'simulation')?.examples).toEqual([
      'opensip sim --json',
      'opensip sim --recipe default --json',
    ]);
  });

  it('keeps catalog examples well-formed for machine consumers', () => {
    const catalog = buildAgentCatalog();
    for (const example of collectExamples(catalog)) {
      expect(example).toMatch(/^opensip\s/);
      expect(example).not.toMatch(/\s{2,}/);
      expect(example).not.toContain('opensip audit');
    }
  });
});
