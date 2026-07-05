/**
 * CommandOutcome exit parity: for JSON-producing command paths, the serialized
 * outer `exitCode` must match the child process exit code agents observe.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

import type { CommandOutcome, SignalEnvelope } from '@opensip-cli/contracts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const YAGNI_FIXTURE = join(
  HERE,
  '../../../yagni/engine/src/__tests__/fixtures/unused-config-surface/pkg',
);
const FITNESS_STABLE_ID = 'afd68bd3-ff3c-4935-a5b6-76d8fc7a5224';
const GRAPH_STABLE_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';

const cli = distRunner();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tmpProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `opensip-outcome-parity-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeBaseProject(root: string, source: string, extraConfig = ''): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"parity-fixture","type":"module"}\n', 'utf8');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022"}}\n', 'utf8');
  writeFileSync(join(root, 'src', 'index.ts'), source, 'utf8');
  writeFileSync(
    join(root, 'opensip-cli.config.yml'),
    [
      'schemaVersion: 1',
      'targets:',
      '  backend:',
      '    description: Parity fixture',
      '    languages: [typescript]',
      '    concerns: [backend]',
      '    include:',
      "      - 'src/**/*.ts'",
      extraConfig.trimEnd(),
      '',
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
    'utf8',
  );
}

function writeYagniFixture(failOnWarnings: number): string {
  const root = tmpProject(`yagni-${String(failOnWarnings)}`);
  cpSync(YAGNI_FIXTURE, root, { recursive: true });
  writeFileSync(
    join(root, 'opensip-cli.config.yml'),
    [
      'schemaVersion: 1',
      'targets:',
      '  backend:',
      '    description: YAGNI parity fixture',
      '    languages: [typescript]',
      '    concerns: [backend]',
      '    include:',
      "      - 'src/**/*.ts'",
      'yagni:',
      `  failOnWarnings: ${String(failOnWarnings)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function parseOutcome(stdout: string): CommandOutcome {
  return JSON.parse(stdout) as CommandOutcome;
}

function parseOutcomeStream(stdout: string): CommandOutcome[] {
  const outcomes: CommandOutcome[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < stdout.length; i += 1) {
    const ch = stdout[i];
    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
      } else if (/\S/.test(ch ?? '')) {
        throw new SyntaxError(`Unexpected non-JSON token ${JSON.stringify(ch)} at ${String(i)}`);
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (depth === 0) {
      outcomes.push(JSON.parse(stdout.slice(start, i + 1)) as CommandOutcome);
      start = -1;
    }
  }
  if (start >= 0) throw new SyntaxError('Unterminated JSON document in stdout');
  return outcomes;
}

function runOutcome(args: readonly string[], cwd: string): CommandOutcome {
  const result = cli.run(args, { cwd, timeout: 90_000 });
  const outcome = parseOutcome(result.stdout);
  expect(outcome.exitCode).toBe(result.exitCode);
  return outcome;
}

function envelope(outcome: CommandOutcome): SignalEnvelope {
  expect(outcome.envelope).toBeDefined();
  return outcome.envelope!;
}

describe('CommandOutcome.exitCode parity', () => {
  it('matches the process exit for fit passing and failing JSON runs', () => {
    const failing = tmpProject('fit-fail');
    writeBaseProject(
      failing,
      'export function greet(name: string): void {\n  console.log(name);\n}\n',
    );
    const failingOutcome = runOutcome(['fit', '--json', '--check', 'no-console-log'], failing);
    expect(envelope(failingOutcome).verdict.passed).toBe(false);

    const passing = tmpProject('fit-pass');
    writeBaseProject(passing, 'export function greet(name: string): string {\n  return name;\n}\n');
    const passingOutcome = runOutcome(['fit', '--json', '--check', 'no-console-log'], passing);
    expect(envelope(passingOutcome).verdict.passed).toBe(true);
  });

  it('matches the process exit for graph passing and failing JSON runs', () => {
    const failing = tmpProject('graph-fail');
    writeBaseProject(
      failing,
      [
        'export function a(): number { return b(); }',
        'export function b(): number { return c(); }',
        'export function c(): number { return a(); }',
        '',
      ].join('\n'),
      ['graph:', '  severityOverrides:', "    'graph:cycle': error", ''].join('\n'),
    );
    const failingOutcome = runOutcome(['graph', '--json', '--recipe', 'agent-risk'], failing);
    expect(envelope(failingOutcome).verdict.passed).toBe(false);

    const passing = tmpProject('graph-pass');
    writeBaseProject(
      passing,
      [
        'export function a(): number { return 1; }',
        'export function b(): number { return a(); }',
        'export function c(): number { return b(); }',
        '',
      ].join('\n'),
    );
    const passingOutcome = runOutcome(['graph', '--json', '--recipe', 'agent-risk'], passing);
    expect(envelope(passingOutcome).verdict.passed).toBe(true);
  });

  it('matches the process exit for YAGNI passing and failing JSON runs', () => {
    const failing = writeYagniFixture(1);
    const failingOutcome = runOutcome(['yagni', '--json'], failing);
    expect(envelope(failingOutcome).verdict.passed).toBe(false);

    const passing = tmpProject('yagni-pass');
    writeBaseProject(
      passing,
      'export function used(value: string): string {\n  return value.trim();\n}\n',
      'yagni:\n  failOnWarnings: 1\n',
    );
    const passingOutcome = runOutcome(['yagni', '--json'], passing);
    expect(envelope(passingOutcome).verdict.passed).toBe(true);
  });

  it('matches the process exit for a JSON suite with one failing step', () => {
    const root = tmpProject('suite');
    writeBaseProject(
      root,
      'export function greet(name: string): void {\n  console.log(name);\n}\n',
      [
        'suites:',
        '  parity:',
        '    steps:',
        `      - tool: ${FITNESS_STABLE_ID}`,
        '        name: fitness',
        '        command: fitness',
        '        args:',
        '          check: no-console-log',
        `      - tool: ${GRAPH_STABLE_ID}`,
        '        name: graph',
        '        command: graph',
        '        args:',
        '          recipe: agent-risk',
        '',
      ].join('\n'),
    );

    const result = cli.run(['suite', 'run', 'parity', '--json'], { cwd: root, timeout: 90_000 });
    const outcomes = parseOutcomeStream(result.stdout);
    const outcome = outcomes.at(-1);
    expect(outcome).toBeDefined();
    const finalOutcome = outcome!;
    expect(finalOutcome.exitCode).toBe(result.exitCode);
    const data = finalOutcome.data as {
      exitCode?: number;
      steps?: readonly { exitCode: number }[];
    };
    expect(data.exitCode).toBe(finalOutcome.exitCode);
    expect(data.steps?.map((step) => step.exitCode)).toContain(1);
  });

  it('pins the graph gate-compare degraded override exit', () => {
    const root = tmpProject('graph-gate');
    writeBaseProject(
      root,
      [
        'export function a(): number { return 1; }',
        'export function b(): number { return a(); }',
        '',
      ].join('\n'),
      ['graph:', '  severityOverrides:', "    'graph:cycle': error", ''].join('\n'),
    );
    const save = cli.run(['graph', '--gate-save'], { cwd: root, timeout: 90_000 });
    expect(save.exitCode).toBe(0);

    writeFileSync(
      join(root, 'src', 'index.ts'),
      [
        'export function a(): number { return b(); }',
        'export function b(): number { return c(); }',
        'export function c(): number { return a(); }',
        '',
      ].join('\n'),
      'utf8',
    );

    const compare = cli.run(['graph', '--gate-compare'], { cwd: root, timeout: 90_000 });
    expect(compare.exitCode).toBe(1);
  });
});
