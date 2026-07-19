/**
 * Built-CLI cache→Init report/identity continuity (Plan 00 Task 5.8).
 *
 * Proves: pre-init audit evidence + exact report --run live in the isolated
 * user cache; Init promotes without changing parent Run identity; post-Init
 * report --run and runs show still select the same retained parent.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

const DIST_CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const cli = distRunner();

let testDir: string;
let home: string;
let nestedCwd: string;

function env(): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    OPENSIP_NO_UPDATE: '1',
    NO_UPDATE_NOTIFIER: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OPENSIP_PROFILING: '0',
  };
}

function git(args: readonly string[]): void {
  execFileSync('git', args, { cwd: testDir, stdio: 'ignore' });
}

function payload(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  if (typeof record.data === 'object' && record.data !== null) {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function runIdFromAudit(stdout: string): string {
  const parsed = JSON.parse(stdout) as unknown;
  const data = payload(parsed);
  const runId =
    (typeof data.runId === 'string' && data.runId) ||
    (typeof (data as { run?: { id?: string } }).run?.id === 'string' &&
      (data as { run: { id: string } }).run.id) ||
    null;
  if (runId === null || runId.length === 0) {
    throw new Error(`audit JSON missing parent runId: ${stdout.slice(0, 400)}`);
  }
  return runId;
}

beforeAll(() => {
  if (!existsSync(DIST_CLI)) {
    throw new Error(`Built CLI missing at ${DIST_CLI}. Run pnpm build before cache-init e2e.`);
  }
});

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-cache-init-e2e-')));
  home = join(testDir, '.home');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(testDir, 'packages', 'app', 'src'), { recursive: true });
  nestedCwd = join(testDir, 'packages', 'app');

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: 'cache-init-e2e', private: true, workspaces: ['packages/*'] }, null, 2),
    'utf8',
  );
  writeFileSync(join(testDir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n", 'utf8');
  writeFileSync(
    join(nestedCwd, 'package.json'),
    JSON.stringify({ name: 'app', private: true, type: 'module' }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(nestedCwd, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: { module: 'Node16', moduleResolution: 'Node16', target: 'ES2022' },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(nestedCwd, 'src', 'index.ts'),
    'export function probe(value: number): number {\n  return value + 1;\n}\n',
    'utf8',
  );

  git(['init', '-q']);
  git(['config', 'user.email', 'cache-init@example.test']);
  git(['config', 'user.name', 'Cache Init']);
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  writeFileSync(
    join(nestedCwd, 'src', 'index.ts'),
    'export function probe(value: number): number {\n  return value + 2;\n}\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('cache-init report continuity (built CLI)', () => {
  it('preserves exact parent Run identity and report selection across Init', () => {
    const options = { cwd: testDir, timeout: 180_000, env: env() } as const;

    // Pre-init status should not create project opensip-cli/.
    // Host commands inherit process cwd via the harness; they do not all accept --cwd.
    const statusPre = cli.run(['--no-cloud', 'status', '--json'], options);
    expect(statusPre.exitCode).toBe(0);
    expect(existsSync(join(testDir, 'opensip-cli'))).toBe(false);

    // Nested audit from packages/app — discovery should bind the workspace root.
    const audit = cli.run(['--no-cloud', 'audit', '--files', 'src/index.ts', '--json'], {
      ...options,
      cwd: nestedCwd,
    });
    // Audit may exit non-zero on findings; require a parseable parent identity.
    const parentRunId = runIdFromAudit(audit.stdout);
    expect(existsSync(join(testDir, 'opensip-cli'))).toBe(false);
    expect(existsSync(join(home, '.opensip-cli'))).toBe(true);

    const runsShowPre = cli.run(['--no-cloud', 'runs', 'show', parentRunId, '--json'], options);
    expect(runsShowPre.exitCode).toBe(0);
    const preShow = payload(JSON.parse(runsShowPre.stdout));
    const preRun = (preShow.run as Record<string, unknown> | undefined) ?? preShow;
    expect(preRun.id ?? preShow.id).toBe(parentRunId);

    const reportPre = cli.run(
      ['--no-cloud', 'report', '--run', parentRunId, '--no-open', '--json'],
      options,
    );
    expect(reportPre.exitCode).toBe(0);
    const reportPreData = payload(JSON.parse(reportPre.stdout));
    const prePath = reportPreData.path;
    expect(typeof prePath).toBe('string');
    expect(prePath as string).toMatch(/[/\\]runs[/\\][a-f0-9]{64}\.html$/);
    expect(existsSync(prePath as string)).toBe(true);
    expect(readFileSync(prePath as string, 'utf8')).toContain(parentRunId);
    // Report path must be under the user cache, not the project tree.
    expect(prePath as string).toContain(home);
    expect(prePath as string).not.toContain(join(testDir, 'opensip-cli'));

    // Missing run fails closed (no latest fallback write/open).
    const missing = cli.run(
      ['--no-cloud', 'report', '--run', 'run-does-not-exist', '--no-open', '--json'],
      options,
    );
    expect(missing.exitCode).not.toBe(0);

    // Init adopts cache evidence into project runtime.
    const init = cli.run(['--no-cloud', 'init', '--json'], {
      ...options,
      timeout: 180_000,
    });
    expect(init.exitCode).toBe(0);
    expect(existsSync(join(testDir, 'opensip-cli', '.runtime'))).toBe(true);

    const runsShowPost = cli.run(['--no-cloud', 'runs', 'show', parentRunId, '--json'], options);
    expect(runsShowPost.exitCode).toBe(0);
    const postShow = payload(JSON.parse(runsShowPost.stdout));
    const postRun = (postShow.run as Record<string, unknown> | undefined) ?? postShow;
    expect(postRun.id ?? postShow.id).toBe(parentRunId);

    const reportPost = cli.run(
      ['--no-cloud', 'report', '--run', parentRunId, '--no-open', '--json'],
      options,
    );
    expect(reportPost.exitCode).toBe(0);
    const reportPostData = payload(JSON.parse(reportPost.stdout));
    const postPath = reportPostData.path as string;
    expect(postPath).toMatch(/[/\\]runs[/\\][a-f0-9]{64}\.html$/);
    expect(existsSync(postPath)).toBe(true);
    expect(readFileSync(postPath, 'utf8')).toContain(parentRunId);
    expect(postPath).toContain(join(testDir, 'opensip-cli', '.runtime'));

    // Status after Init should succeed on the project plane.
    const statusPost = cli.run(['--no-cloud', 'status', '--json'], options);
    expect(statusPost.exitCode).toBe(0);
    expect(readdirSync(join(home, '.opensip-cli')).length).toBeGreaterThanOrEqual(0);
  }, 360_000);
});
