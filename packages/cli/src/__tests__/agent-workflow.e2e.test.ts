/**
 * End-to-end agent edit-loop against the built CLI (spec §7).
 *
 * Requires `packages/cli/dist/index.js` — run `pnpm build` first.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

const DIST_CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const cli = distRunner();

let testDir: string;

beforeAll(() => {
  if (!existsSync(DIST_CLI)) {
    throw new Error(
      `Built CLI missing at ${DIST_CLI}. Run pnpm build before agent-workflow e2e tests.`,
    );
  }
});

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-agent-workflow-'));
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: 'agent-workflow-fixture', private: true }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(testDir, 'opensip-cli.config.yml'),
    [
      'schemaVersion: 1',
      'targets:',
      '  src:',
      '    description: source',
      '    languages: [typescript]',
      '    concerns: [backend]',
      '    include: ["**/*.ts"]',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(testDir, 'sample.ts'),
    'export const x = 1; // EXAMPLE_TODO left in source\n',
    'utf8',
  );
  mkdirSync(join(testDir, 'opensip-cli/fit/checks'), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function parseStdout(stdout: string): unknown {
  return JSON.parse(stdout) as unknown;
}

function outcomeData(stdout: string): Record<string, unknown> {
  const parsed = parseStdout(stdout) as { data?: Record<string, unknown> };
  return parsed.data ?? parsed;
}

describe('agent workflow e2e', () => {
  it('agent-catalog --json surfaces agent recipes and read-latest workflow', () => {
    const { stdout, exitCode } = cli.run(['agent-catalog', '--json'], { cwd: testDir });
    expect(exitCode).toBe(0);
    const data = outcomeData(stdout) as {
      catalog: {
        commonPatterns: { name: string }[];
        notes: string[];
        entryPoints: { command: string }[];
      };
    };
    expect(data.catalog.commonPatterns.some((p) => p.name.includes('read-latest'))).toBe(true);
    expect(data.catalog.notes.some((n) => n.includes('agent-fast'))).toBe(true);
    expect(data.catalog.entryPoints.map((e) => e.command)).toContain('fitness');
    const commands = data.catalog.entryPoints.map((e) => e.command).join(' ');
    expect(commands).not.toMatch(/-run-worker|-shard-worker|-equivalence-check/);
  });

  it('fit --recipe agent-fast --json --filter errors-only --top 20 returns filtered counts', () => {
    const { stdout, exitCode } = cli.run(
      ['fit', '--recipe', 'agent-fast', '--json', '--filter', 'errors-only', '--top', '20'],
      { cwd: testDir, timeout: 120_000 },
    );
    expect(exitCode).toBe(0);
    const data = outcomeData(stdout);
    expect(data.filtersApplied).toBeDefined();
    expect(data.originalSignalCount).toBeTypeOf('number');
    expect(data.returnedSignalCount).toBeTypeOf('number');
    expect(data.envelope).toBeDefined();
  });

  it('sessions show latest replays with the same filter shape', () => {
    cli.run(['fit', '--recipe', 'agent-fast', '--json'], { cwd: testDir, timeout: 120_000 });
    const { stdout, exitCode } = cli.run(
      [
        'sessions',
        'show',
        'latest',
        '--tool',
        'fit',
        '--json',
        '--filter',
        'errors-only',
        '--filter',
        'top:20',
      ],
      { cwd: testDir },
    );
    expect(exitCode).toBe(0);
    const data = outcomeData(stdout);
    expect(data.filtersApplied).toBeDefined();
    expect(data.originalSignalCount).toBeTypeOf('number');
    expect(data.returnedSignalCount).toBeTypeOf('number');
  });

  it('fit --json --raw --filter errors-only returns unwrapped payload', () => {
    const { stdout, exitCode } = cli.run(['fit', '--json', '--raw', '--filter', 'errors-only'], {
      cwd: testDir,
      timeout: 120_000,
    });
    expect(exitCode).toBe(0);
    const parsed = parseStdout(stdout) as { type?: string; filtersApplied?: string[] };
    expect(parsed.type).toBe('agent-filtered');
    expect(parsed.filtersApplied).toBeDefined();
  });

  it('graph impact --changed outside git returns exit 2', () => {
    const { exitCode } = cli.run(['graph', 'impact', '--changed', '--json'], { cwd: testDir });
    expect(exitCode).toBe(2);
  });

  it('fit --changed warns in non-git dir without crashing', () => {
    const { exitCode, stderr } = cli.run(['fit', '--changed', '--json', '--recipe', 'agent-fast'], {
      cwd: testDir,
      timeout: 120_000,
    });
    expect(exitCode).toBe(0);
    expect(stderr + cli.run(['fit', '--changed', '--json'], { cwd: testDir }).stderr).toBeTruthy();
  });
});
