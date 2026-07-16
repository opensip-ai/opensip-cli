/**
 * Bounded acceptance proof for the canonical audit command through the built CLI.
 * The JSON parse is load-bearing: any embedded fit/graph/yagni document before
 * or after the parent suite outcome makes JSON.parse fail immediately.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

const DIST_CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const cli = distRunner();
const SENTINEL = 'audit-acceptance-secret-must-not-leak';
const GRAPH_TOOL_ID = '3873f1c2-02a9-4719-930a-bca74b62b706';

let testDir: string;

const auditEnv = (): Record<string, string> => ({
  HOME: join(testDir, '.home'),
  XDG_CONFIG_HOME: join(testDir, '.home', '.config'),
  OPENSIP_NO_UPDATE: '1',
  NO_UPDATE_NOTIFIER: '1',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OPENSIP_PROFILING: '0',
  AUDIT_ACCEPTANCE_SENTINEL: SENTINEL,
});

function normalizedSuiteData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedSuiteData);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['durationMs', 'runId', 'suiteRunId'].includes(key))
      .map(([key, item]) => [key, normalizedSuiteData(item)]),
  );
}

function git(args: readonly string[]): void {
  execFileSync('git', args, { cwd: testDir, stdio: 'ignore' });
}

function writeConfig(extraLines: readonly string[] = []): void {
  writeFileSync(
    join(testDir, 'opensip-cli.config.yml'),
    [
      'schemaVersion: 1',
      'targets:',
      '  src:',
      '    description: source',
      '    languages: [typescript]',
      '    concerns: [backend]',
      '    include: ["src/**/*.ts"]',
      ...extraLines,
      '',
    ].join('\n'),
    'utf8',
  );
}

beforeAll(() => {
  if (!existsSync(DIST_CLI)) {
    throw new Error(`Built CLI missing at ${DIST_CLI}. Run pnpm build before audit acceptance.`);
  }
});

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-audit-acceptance-')));
  mkdirSync(join(testDir, '.home'), { recursive: true });
  mkdirSync(join(testDir, 'src'), { recursive: true });
  mkdirSync(join(testDir, 'opensip-cli/fit/checks'), { recursive: true });
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: 'audit-acceptance-fixture', private: true }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(testDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'Node16',
          moduleResolution: 'Node16',
          target: 'ES2022',
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeConfig();
  writeFileSync(
    join(testDir, 'src/change.ts'),
    [
      'export function changed(value: number): number {',
      '  return value + 1;',
      '}',
      'export function caller(): number {',
      '  return changed(1);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  git(['init', '-q']);
  git(['config', 'user.email', 'audit-acceptance@example.test']);
  git(['config', 'user.name', 'Audit Acceptance']);
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  writeFileSync(
    join(testDir, 'src/change.ts'),
    [
      'export function changed(value: number): number {',
      '  return value + 2;',
      '}',
      'export function caller(): number {',
      '  return changed(1);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('audit acceptance through built CLI', () => {
  it('emits exactly one parent JSON document with no embedded step output', () => {
    const result = cli.run(
      ['--no-cloud', 'audit', '--files', 'src/change.ts', '--json', '--cwd', testDir],
      {
        cwd: testDir,
        timeout: 120_000,
        env: auditEnv(),
      },
    );

    const parsed = JSON.parse(result.stdout) as {
      readonly kind?: string;
      readonly exitCode?: number;
      readonly data?: {
        readonly type?: string;
        readonly suite?: string;
        readonly runId?: string;
        readonly steps?: readonly unknown[];
      };
    };
    expect(parsed.kind).toBe('suite-run');
    expect(parsed.data).toMatchObject({ type: 'suite-run', suite: 'audit' });
    expect(parsed.data?.steps).toHaveLength(3);
    expect(result.exitCode).toBe(parsed.exitCode);
    expect(result.stdout).not.toMatch(/"kind"\s*:\s*"(?:fit|graph|yagni)\./u);
    expect(result.stdout).not.toContain('\u001B');
    expect(result.stdout).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain(SENTINEL);
  }, 180_000);

  it('matches the real built-in suite domain result through both public entry points', () => {
    const options = {
      cwd: testDir,
      timeout: 120_000,
      env: auditEnv(),
    } as const;
    const direct = cli.run(
      ['--no-cloud', 'audit', '--files', 'src/change.ts', '--json', '--cwd', testDir],
      options,
    );
    const generic = cli.run(
      [
        '--no-cloud',
        'suite',
        'run',
        'audit',
        '--files',
        'src/change.ts',
        '--json',
        '--cwd',
        testDir,
      ],
      options,
    );
    const directOutcome = JSON.parse(direct.stdout) as {
      readonly exitCode: number;
      readonly data: {
        readonly runId?: string;
        readonly steps?: readonly unknown[];
      };
    };
    const genericOutcome = JSON.parse(generic.stdout) as {
      readonly exitCode: number;
      readonly data: {
        readonly runId?: string;
        readonly steps?: readonly unknown[];
      };
    };

    expect(direct.exitCode).toBe(generic.exitCode);
    expect(directOutcome.exitCode).toBe(genericOutcome.exitCode);
    expect(directOutcome.data.runId).toMatch(/^RUN_/u);
    expect(genericOutcome.data.runId).toMatch(/^RUN_/u);
    expect(directOutcome.data.steps).toHaveLength(3);
    expect(genericOutcome.data.steps).toHaveLength(3);
    expect(normalizedSuiteData(directOutcome.data)).toEqual(
      normalizedSuiteData(genericOutcome.data),
    );
  }, 240_000);

  it('matches the curated suite through both public entry points in explicit full mode', () => {
    const options = {
      cwd: testDir,
      timeout: 120_000,
      env: auditEnv(),
    } as const;
    const direct = cli.run(['--no-cloud', 'audit', '--full', '--json', '--cwd', testDir], options);
    const generic = cli.run(
      ['--no-cloud', 'suite', 'run', 'audit', '--full', '--json', '--cwd', testDir],
      options,
    );
    const directOutcome = JSON.parse(direct.stdout) as {
      readonly exitCode: number;
      readonly data: { readonly steps?: readonly unknown[] };
    };
    const genericOutcome = JSON.parse(generic.stdout) as {
      readonly exitCode: number;
      readonly data: { readonly steps?: readonly unknown[] };
    };

    expect(direct.exitCode).toBe(generic.exitCode);
    expect(directOutcome.exitCode).toBe(genericOutcome.exitCode);
    expect(directOutcome.data.steps).toHaveLength(3);
    expect(genericOutcome.data.steps).toHaveLength(3);
    expect(normalizedSuiteData(directOutcome.data)).toEqual(
      normalizedSuiteData(genericOutcome.data),
    );
  }, 240_000);

  it('rejects a configured suites.audit at document validation for both spellings (ADR-0159)', () => {
    // ADR-0159 amended ADR-0155: the reserved suite name can no longer exist
    // in a valid config document, so instead of the old divergence (root audit
    // curated, suite run audit overridden) BOTH spellings fail identically at
    // config load with an actionable rename hint.
    writeConfig([
      'suites:',
      '  audit:',
      '    description: configured collision fixture',
      '    steps:',
      `      - tool: ${GRAPH_TOOL_ID}`,
      '        name: configured-graph-only',
      '        command: impact',
      '        args: {}',
    ]);
    const options = {
      cwd: testDir,
      timeout: 120_000,
      env: auditEnv(),
    } as const;
    const direct = cli.run(
      ['--no-cloud', 'audit', '--files', 'src/change.ts', '--json', '--cwd', testDir],
      options,
    );
    const generic = cli.run(
      [
        '--no-cloud',
        'suite',
        'run',
        'audit',
        '--files',
        'src/change.ts',
        '--json',
        '--cwd',
        testDir,
      ],
      options,
    );

    for (const outcome of [direct, generic]) {
      expect(outcome.exitCode).toBe(2);
      const parsed = JSON.parse(outcome.stdout) as {
        readonly kind: string;
        readonly errors: readonly { readonly message: string; readonly code: string }[];
      };
      expect(parsed.kind).toBe('command.error');
      expect(parsed.errors[0]?.code).toBe('CONFIGURATION_ERROR');
      expect(parsed.errors[0]?.message).toContain(
        "Suite name 'audit' is reserved for the built-in audit suite",
      );
      expect(parsed.errors[0]?.message).toContain('opensip suite run audit-custom');
    }
  }, 240_000);
});
