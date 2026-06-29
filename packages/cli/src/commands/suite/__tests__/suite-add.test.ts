import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineCommand, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { addSuiteStep } from '../suite-add.js';

const TOOL_ID = '00000000-0000-4000-8000-000000000321';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'suite-add-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fixtureTool(): Tool {
  return {
    metadata: {
      id: TOOL_ID,
      name: 'fitness',
      version: '0.0.0',
      description: 'fixture',
    },
    commands: [{ name: 'fit', description: 'fixture' }],
    commandSpecs: [
      defineCommand<unknown, ToolCliContext>({
        name: 'fit',
        description: 'fixture',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () => ({ type: 'help' }),
      }),
    ],
  };
}

describe('addSuiteStep', () => {
  it('writes canonical UUID-addressed suite steps and is idempotent', () => {
    const first = addSuiteStep({
      suite: 'security',
      tool: 'fitness',
      command: 'fit',
      argPairs: ['recipe=security', 'gateCompare=true', 'count=3'],
      tools: [fixtureTool()],
      projectRoot: tmp,
    });
    const second = addSuiteStep({
      suite: 'security',
      tool: 'fitness',
      command: 'fit',
      argPairs: ['recipe=security', 'gateCompare=true', 'count=3'],
      tools: [fixtureTool()],
      projectRoot: tmp,
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    const doc = parse(readFileSync(join(tmp, 'opensip-cli.config.yml'), 'utf8')) as {
      suites: {
        security: {
          steps: readonly [
            {
              tool: string;
              name: string;
              command: string;
              args: Record<string, unknown>;
            },
          ];
        };
      };
    };
    expect(doc.suites.security.steps).toHaveLength(1);
    expect(doc.suites.security.steps[0]).toEqual({
      tool: TOOL_ID,
      name: 'fitness',
      command: 'fit',
      args: { recipe: 'security', gateCompare: true, count: 3 },
    });
  });
});
