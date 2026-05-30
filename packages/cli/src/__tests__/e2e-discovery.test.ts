/**
 * End-to-end validation for project-discovery-and-lifecycle.
 *
 * Exercises the CLI binary against tmp project layouts to verify:
 *  - Project: header from subdir + at root.
 *  - Phantom-scaffold regression: running from a subdir uses the
 *    parent root, NOT a new .runtime/ in the subdir.
 *  - "No project found" error for project-scoped commands.
 *  - Init scaffolds fresh + refuses inside existing project.
 *  - Uninstall safe default + --purge.
 *  - schemaVersion: 99 surfaces the upgrade-CLI message.
 *  - No-side-effects: --dry-run uninstall doesn't create .runtime/.
 *
 * These tests run the actual binary (`packages/cli/dist/index.js`), so
 * the build must be done first (pnpm --filter=@opensip-tools/cli build).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CLI = join(__dirname, '../../dist/index.js');

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString() ?? '',
      stderr: typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

let testDir: string;

beforeEach(() => {
  // realpath: macOS tmpdir() returns /var/folders/... but resolves to
  // /private/var/folders/... via symlink. The CLI's discovery resolves
  // paths to canonical form, so assertions on its output must too.
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-e2e-discovery-')));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('Project: header', () => {
  it('emits "Project: <root>" with no walked-up suffix when cwd === root', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const { stdout, exitCode } = runCli(['fit-list'], testDir);
    expect(exitCode).toBe(0);
    // The project line is now rendered by the App shell's ProjectHeader,
    // under the banner — no longer the literal first line of stdout.
    expect(stdout).toContain(`ℹ Project: ${testDir}`);
    expect(stdout).not.toContain('found');
  });

  it('emits "(found N levels up)" when run from a subdir', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const subdir = join(testDir, 'packages', 'api');
    mkdirSync(subdir, { recursive: true });
    const { stdout, exitCode } = runCli(['fit-list'], subdir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`ℹ Project: ${testDir}`);
    // The walked-up suffix surfaces (vs the cwd===root case, which asserts
    // NOT 'found'). Exact "(found N levels up)" wording is unit-tested in
    // cli-ui formatProjectHeader; here it may wrap at 80 cols on long tmp
    // paths, so we assert the marker word rather than the contiguous phrase.
    expect(stdout).toContain('found');
  });

  it('suppresses the imperative header for --json', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const { stdout } = runCli(['fit-list', '--json'], testDir);
    expect(stdout).not.toContain('ℹ Project:');
  });
});

describe('phantom-scaffold regression (the original bug)', () => {
  it('running fit-list from a subdir uses the parent project root', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const subdir = join(testDir, 'packages', 'api');
    mkdirSync(subdir, { recursive: true });
    runCli(['fit-list'], subdir);
    // .runtime/ should appear at the project root, NOT at the subdir.
    expect(existsSync(join(testDir, 'opensip-tools', '.runtime'))).toBe(true);
    expect(existsSync(join(subdir, 'opensip-tools'))).toBe(false);
  });
});

describe('no project found', () => {
  it('project-scoped command errors exit 2 with the structured message', () => {
    const { stderr, exitCode } = runCli(['fit-list'], testDir);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('No opensip-tools project found');
    expect(stderr).toContain('opensip-tools init');
  });

  it('project-scoped --json emits the error as JSON on stdout', () => {
    const { stdout, exitCode } = runCli(['fit-list', '--json'], testDir);
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(stdout) as { error: string };
    expect(parsed.error).toContain('No opensip-tools.config.yml found');
  });
});

describe('init from a fresh tmpdir', () => {
  it('scaffolds with schemaVersion: 1 in the config', () => {
    const { exitCode } = runCli(['init', '--language', 'typescript'], testDir);
    expect(exitCode).toBe(0);
    const cfg = readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8');
    expect(cfg).toMatch(/^schemaVersion: 1$/m);
  });
});

describe('init refusal inside existing project', () => {
  it('refuses with exit 2 + three-option message when run from a subdir', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    mkdirSync(join(testDir, 'opensip-tools', 'fit', 'checks'), { recursive: true });
    const subdir = join(testDir, 'packages', 'api');
    mkdirSync(subdir, { recursive: true });
    const { stdout, stderr, exitCode } = runCli(['init'], subdir);
    expect(exitCode).toBe(2);
    const out = stdout + stderr;
    expect(out).toContain('already inside an opensip-tools project');
    expect(out).toContain(testDir);
    expect(out).toContain('opensip-tools init --keep --cwd');
    expect(out).toContain('opensip-tools init --remove --cwd');
    expect(out).toContain('opensip-tools init --cwd .');
  });
});

describe('uninstall safe default + --purge', () => {
  beforeEach(() => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    mkdirSync(join(testDir, 'opensip-tools', 'fit', 'checks'), { recursive: true });
    writeFileSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'my.mjs'), '\n', 'utf8');
    mkdirSync(join(testDir, 'opensip-tools', '.runtime', 'logs'), { recursive: true });
    writeFileSync(join(testDir, 'opensip-tools', '.runtime', 'logs', 'run.jsonl'), '{}\n', 'utf8');
  });

  it('default removes ONLY .runtime/; preserves user content + config', () => {
    const { stdout, exitCode } = runCli(['uninstall', '--project', '--yes'], testDir);
    expect(exitCode).toBe(0);
    expect(existsSync(join(testDir, 'opensip-tools', '.runtime'))).toBe(false);
    expect(existsSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'my.mjs'))).toBe(true);
    expect(existsSync(join(testDir, 'opensip-tools.config.yml'))).toBe(true);
    expect(stdout).toContain('These will be KEPT');
  });

  it('--purge removes EVERYTHING with the git-status warning', () => {
    const { stdout, exitCode } = runCli(['uninstall', '--project', '--purge', '--yes'], testDir);
    expect(exitCode).toBe(0);
    expect(existsSync(join(testDir, 'opensip-tools'))).toBe(false);
    expect(existsSync(join(testDir, 'opensip-tools.config.yml'))).toBe(false);
    expect(stdout).toContain('⚠ This removes EVERYTHING');
    expect(stdout).toContain('git status');
  });
});

describe('schema-version skew', () => {
  it('schemaVersion: 99 exits 2 with "Update your CLI" message (not migrate)', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 99\ntargets: {}\n', 'utf8');
    const { stderr, exitCode } = runCli(['fit-list'], testDir);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('uses a newer schema than your CLI supports');
    expect(stderr).toContain('npm install -g @opensip-tools/cli@latest');
    // Critical: must NOT say "migrate" — direction was previously wrong.
    expect(stderr.toLowerCase()).not.toContain('opensip-tools migrate');
  });

  it('config missing schemaVersion works as v1 silently', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'targets: {}\n', 'utf8');
    const { stderr, exitCode } = runCli(['fit-list'], testDir);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('newer schema');
  });
});

describe('no-side-effects', () => {
  it('uninstall --project --dry-run does NOT open the SQLite datastore', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    mkdirSync(join(testDir, 'opensip-tools', 'fit', 'checks'), { recursive: true });
    writeFileSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'my.mjs'), '\n', 'utf8');
    runCli(['uninstall', '--project', '--dry-run', '--yes'], testDir);
    // The catastrophic side effect was the SQLite file. With lazy
    // datastore (Phase 1.3), dry-run never reads cli.datastore so
    // openSqliteBackend's mkdirSync + open never fires.
    expect(existsSync(join(testDir, 'opensip-tools', '.runtime', 'datastore.sqlite'))).toBe(false);
  });

  it('schemaVersion: 99 bailout does NOT open SQLite or initialise logs', () => {
    writeFileSync(join(testDir, 'opensip-tools.config.yml'), 'schemaVersion: 99\ntargets: {}\n', 'utf8');
    runCli(['fit-list'], testDir);
    // pre-action-hook exits 2 BEFORE the side-effect block
    // (configureLogger({ logDir }) + setProjectContextForRun). No
    // .runtime/ tree at all.
    expect(existsSync(join(testDir, 'opensip-tools', '.runtime'))).toBe(false);
  });
});
