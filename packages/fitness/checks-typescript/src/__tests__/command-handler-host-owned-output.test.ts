/**
 * @fileoverview Behaviour tests for the command-handler-host-owned-output
 * seam-discipline check: a tool command handler must let the host own rendering
 * and exit (no direct stdout/console/process.exit) unless it declares
 * output:'raw-stream'.
 */
import { runCheckOnFixture, type FixtureFile } from '@opensip-cli/test-support';
import { describe, expect, it } from 'vitest';

import { analyzeCommandHandlerHostOwnedOutput } from '../checks/architecture/command-handler-host-owned-output.js';
import { checks } from '../index.js';

const TOOL_PATH = 'src/audit-sec.ts';

function check() {
  const c = checks.find((x) => x.config.slug === 'command-handler-host-owned-output');
  if (!c) throw new Error('check not found: command-handler-host-owned-output');
  return c;
}

async function findingsFor(file: FixtureFile): Promise<number> {
  const run = await runCheckOnFixture(check(), { files: [file] });
  return run.findings.length;
}

function spec(output: string, handlerBody: string, rawStreamReason?: string): string {
  const reason = rawStreamReason ? `  rawStreamReason: '${rawStreamReason}',\n` : '';
  return [
    "import { defineCommand } from '@opensip-cli/core';",
    'export const s = defineCommand({',
    "  name: 'audit-sec',",
    "  description: 'Run',",
    "  commonFlags: ['cwd'],",
    "  scope: 'project',",
    `  output: '${output}',`,
    reason,
    '  handler: async (opts, cli) => {',
    handlerBody,
    '  },',
    '});',
  ].join('\n');
}

describe('analyzeCommandHandlerHostOwnedOutput (AST)', () => {
  it('flags process.stdout.write inside a command-result handler', () => {
    const v = analyzeCommandHandlerHostOwnedOutput(
      spec('command-result', "    process.stdout.write('x');\n    return cli;"),
      TOOL_PATH,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.message).toContain('process.stdout.write');
  });

  it('flags console.log and process.exit inside a signal-envelope handler', () => {
    const v = analyzeCommandHandlerHostOwnedOutput(
      spec('signal-envelope', "    console.log('x');\n    process.exit(1);"),
      TOOL_PATH,
    );
    expect(v).toHaveLength(2);
  });

  it('does NOT flag a handler that routes through the cli context', () => {
    const v = analyzeCommandHandlerHostOwnedOutput(
      spec('command-result', '    cli.setExitCode(0);\n    return { passed: true };'),
      TOOL_PATH,
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag stdout when the command declares output:raw-stream (escape hatch)', () => {
    const v = analyzeCommandHandlerHostOwnedOutput(
      spec('raw-stream', "    process.stdout.write('x');", 'file-export'),
      TOOL_PATH,
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag process.exit outside any command handler', () => {
    const v = analyzeCommandHandlerHostOwnedOutput(
      [
        'export function worker(): void {',
        '  process.stdout.write("ipc");',
        '  process.exit(0);',
        '}',
      ].join('\n'),
      TOOL_PATH,
    );
    expect(v).toEqual([]);
  });

  it('flags stdout in an inline callback nested inside the handler body', () => {
    const v = analyzeCommandHandlerHostOwnedOutput(
      spec('command-result', '    [1].forEach(() => process.stdout.write("x"));\n    return cli;'),
      TOOL_PATH,
    );
    expect(v).toHaveLength(1);
  });
});

describe('command-handler-host-owned-output (gate)', () => {
  it('flags a command-result handler writing to stdout', async () => {
    expect(
      await findingsFor({
        path: TOOL_PATH,
        content: spec('command-result', "    process.stdout.write('x');\n    return cli;"),
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('does NOT flag a raw-stream handler writing to stdout', async () => {
    expect(
      await findingsFor({
        path: TOOL_PATH,
        content: spec('raw-stream', "    process.stdout.write('x');", 'worker-ipc'),
      }),
    ).toBe(0);
  });
});
