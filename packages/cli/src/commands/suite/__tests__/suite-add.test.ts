import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    identity: { name: 'fitness' },
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

  it('refuses a reserved suite name before touching the config file (ADR-0159)', () => {
    expect(() =>
      addSuiteStep({
        suite: 'audit',
        tool: 'fitness',
        command: 'fit',
        argPairs: [],
        tools: [fixtureTool()],
        projectRoot: tmp,
      }),
    ).toThrow(/reserved for the built-in audit suite/);

    expect(existsSync(join(tmp, 'opensip-cli.config.yml'))).toBe(false);
  });

  it.each([
    ['a non-map suites block', 'suites:\n  - existing\n'],
    ['a non-map named suite', 'suites:\n  security: existing\n'],
  ])('refuses to replace %s', (_label, content) => {
    const configPath = join(tmp, 'opensip-cli.config.yml');
    writeFileSync(configPath, content, 'utf8');

    expect(() =>
      addSuiteStep({
        suite: 'security',
        tool: 'fitness',
        command: 'fit',
        argPairs: [],
        tools: [fixtureTool()],
        projectRoot: tmp,
      }),
    ).toThrow(/Cannot edit/);
    expect(readFileSync(configPath, 'utf8')).toBe(content);
  });

  it('recognizes a semantically identical authored step regardless of key order', () => {
    const configPath = join(tmp, 'opensip-cli.config.yml');
    const content = [
      'suites:',
      '  security:',
      '    steps:',
      '      - command: fit',
      '        args:',
      '          count: 3',
      '          recipe: security',
      '        name: fitness',
      `        tool: ${TOOL_ID}`,
      '',
    ].join('\n');
    writeFileSync(configPath, content, 'utf8');

    const result = addSuiteStep({
      suite: 'security',
      tool: 'fitness',
      command: 'fit',
      argPairs: ['recipe=security', 'count=3'],
      tools: [fixtureTool()],
      projectRoot: tmp,
    });

    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(content);
  });

  it('treats signed zero as the same numeric suite argument', () => {
    const configPath = join(tmp, 'opensip-cli.config.yml');
    const content = [
      'suites:',
      '  security:',
      '    steps:',
      `      - tool: ${TOOL_ID}`,
      '        name: fitness',
      '        command: fit',
      '        args:',
      '          count: 0',
      '',
    ].join('\n');
    writeFileSync(configPath, content, 'utf8');

    const result = addSuiteStep({
      suite: 'security',
      tool: 'fitness',
      command: 'fit',
      argPairs: ['count=-0'],
      tools: [fixtureTool()],
      projectRoot: tmp,
    });

    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(content);
  });
});
