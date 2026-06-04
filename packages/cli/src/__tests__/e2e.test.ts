/**
 * End-to-end tests for the opensip-tools CLI.
 *
 * These tests exercise the actual CLI binary (packages/cli/dist/index.js)
 * against a small fixture project. The build must be done before running
 * these tests (pnpm --filter=opensip-tools build).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, afterEach, beforeEach } from 'vitest';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// __dirname = packages/cli/src/__tests__/ → CLI binary is at packages/cli/dist/index.js
const CLI = join(__dirname, '../../dist/index.js');
const FIXTURE = join(__dirname, 'fixtures/sample-project');

// Read version from the CLI package's package.json so this test doesn't
// drift when the version bumps. Source + test now read from the same
// place — fixes the assertion-vs-source drift that shipped 0.2.0 with
// the --version test still pinned to '0.1.0'.
const CLI_PKG_VERSION: string = (() => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };
  return pkg.version;
})();

/** Run the CLI binary with the given arguments and return stdout + exitCode. */
function run(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd: FIXTURE,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

/** Run the CLI in a specific working directory. */
function runIn(cwd: string, ...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CLI e2e', () => {
  // v2: each fixture's .runtime/datastore.sqlite is gitignored and may
  // carry stale schema state from previous test runs (or from
  // mid-migration development). Wipe before every test so migrations
  // apply cleanly against a fresh DB. Cheap; tests already round-trip
  // through the CLI's own writes.
  beforeEach(() => {
    rmSync(join(FIXTURE, 'opensip-tools', '.runtime'), { recursive: true, force: true });
  });

  it('--help shows usage information', () => {
    const { stdout, exitCode } = run('--help');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Commands:');
    expect(stdout).toContain('fit');
  });

  it('--version shows the version string', () => {
    const { stdout, exitCode } = run('--version');
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(CLI_PKG_VERSION);
  });

  describe('fit', () => {
    it('runs successfully with --json', () => {
      const { stdout, exitCode } = run('fit', '--json');
      // Parse as JSON — should not throw. ADR-0011: --json is the signal envelope.
      const output = JSON.parse(stdout);
      expect(output.schemaVersion).toBe(2);
      expect(output.tool).toBe('fit');
      expect(output.verdict).toBeDefined();
      expect(typeof output.verdict.summary.total).toBe('number');
      expect(typeof output.verdict.summary.passed).toBe('number');
      expect(typeof output.verdict.summary.failed).toBe('number');
      expect(Array.isArray(output.signals)).toBe(true);
      // Exit code depends on whether shouldFail is set; just verify it parsed
      expect([0, 1]).toContain(exitCode);
    });

    it('--list shows available checks', () => {
      const { stdout, exitCode } = run('fit', '--list');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Available Fitness Checks');
    });

    it('--recipes shows available recipes', () => {
      const { stdout, exitCode } = run('fit', '--recipes');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Available Recipes');
    });

    it('--list --json outputs valid JSON', () => {
      const { stdout, exitCode } = run('fit', '--list', '--json');
      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.type).toBe('list-checks');
      expect(Array.isArray(output.checks)).toBe(true);
      expect(output.totalCount).toBeGreaterThan(0);
    });

    it('--recipes --json outputs valid JSON', () => {
      const { stdout, exitCode } = run('fit', '--recipes', '--json');
      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout);
      expect(output.type).toBe('list-recipes');
      expect(Array.isArray(output.recipes)).toBe(true);
    });

    it('--check runs a single check', () => {
      const { stdout } = run('fit', '--json', '--check', 'no-console-log');
      const output = JSON.parse(stdout);
      expect(output.tool).toBe('fit');
      expect(output.verdict).toBeDefined();
      // --check must narrow to exactly one check (unit), not the full default recipe.
      expect(output.verdict.summary.total).toBe(1);
      expect(output.units).toHaveLength(1);
      expect(output.units[0].slug).toBe('no-console-log');
    });

    it('--recipe quick-smoke runs without error', () => {
      const { stdout } = run('fit', '--json', '--recipe', 'quick-smoke');
      const output = JSON.parse(stdout);
      expect(output.tool).toBe('fit');
      expect(output.verdict).toBeDefined();
      expect(output.verdict.summary.total).toBeGreaterThan(0);
    });

    it('--json summary fields have expected types', () => {
      const { stdout } = run('fit', '--json', '--recipe', 'quick-smoke');
      const output = JSON.parse(stdout);
      expect(typeof output.createdAt).toBe('string');
      expect(typeof output.verdict.score).toBe('number');
      expect(typeof output.verdict.passed).toBe('boolean');
      expect(Array.isArray(output.signals)).toBe(true);
      expect(Array.isArray(output.units)).toBe(true);
    });

    it('unknown recipe produces error JSON', () => {
      // Regression for 2026-05-25 audit: recipe-not-found must route to
      // CONFIGURATION_ERROR (2), not CHECK_NOT_FOUND (3). Asserting `=== 2`
      // (vs. `not.toBe(0)`) closes the loop on that fix end-to-end.
      const { stdout, exitCode } = run('fit', '--json', '--recipe', 'nonexistent-recipe');
      expect(exitCode).toBe(2);
      const output = JSON.parse(stdout);
      expect(output.error).toBeDefined();
      expect(output.error).toContain('nonexistent-recipe');
    });

    it('fails with exit 2 when no config is found', () => {
      const tempDir = join(tmpdir(), `opensip-e2e-noconfig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tempDir, { recursive: true });
      try {
        const { stdout, exitCode } = runIn(tempDir, 'fit', '--json');
        expect(exitCode).toBe(2);
        const output = JSON.parse(stdout);
        expect(output.error).toContain('No opensip-tools.config.yml found');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('respects --config flag with an explicit path', () => {
      const tempDir = join(tmpdir(), `opensip-e2e-explicit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(tempDir, 'nested'), { recursive: true });
      try {
        // Seed the fixture's config into a non-default location
        const configSrc = readFileSync(join(FIXTURE, 'opensip-tools.config.yml'), 'utf8');
        const configPath = join(tempDir, 'nested', 'custom.yml');
        writeFileSync(configPath, configSrc);
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        writeFileSync(join(tempDir, 'src', 'a.ts'), 'export const x = 1\n');

        const { stdout, exitCode } = runIn(tempDir, 'fit', '--json', '--check', 'no-console-log', '--config', 'nested/custom.yml');
        expect(exitCode).toBe(0);
        const output = JSON.parse(stdout);
        expect(output.tool).toBe('fit');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('respects package.json#opensip-tools.configPath pointer', () => {
      const tempDir = join(tmpdir(), `opensip-e2e-pkgjson-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(tempDir, '.config'), { recursive: true });
      try {
        const configSrc = readFileSync(join(FIXTURE, 'opensip-tools.config.yml'), 'utf8');
        writeFileSync(join(tempDir, '.config', 'opensip-tools.config.yml'), configSrc);
        writeFileSync(
          join(tempDir, 'package.json'),
          JSON.stringify({
            name: 'pkg-pointer-test',
            'opensip-tools': { configPath: '.config/opensip-tools.config.yml' },
          }),
        );
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        writeFileSync(join(tempDir, 'src', 'a.ts'), 'export const x = 1\n');

        const { stdout, exitCode } = runIn(tempDir, 'fit', '--json', '--check', 'no-console-log');
        expect(exitCode).toBe(0);
        const output = JSON.parse(stdout);
        expect(output.tool).toBe('fit');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('sim', () => {
    it('runs the built-in default recipe with no scenarios registered', () => {
      // No user-authored scenarios in the e2e env, so the default recipe
      // matches zero scenarios and exits cleanly. Since Phase 4 (ADR-0011)
      // the sim view is the shared envelope-derived table; with zero units
      // it renders the shared run-summary line ("0 Passed, 0 Failed ...").
      const { stdout, exitCode } = run('sim');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('0 Passed, 0 Failed');
    });

    it('exits 2 when given an unknown recipe name', () => {
      const { exitCode } = run('sim', '--recipe', 'nonexistent');
      expect(exitCode).toBe(2);
    });
  });

  describe('sessions list', () => {
    it('runs without crashing', () => {
      const { exitCode } = run('sessions', 'list');
      expect(exitCode).toBe(0);
    });
  });

  describe('plugin list', () => {
    it('shows plugin information', () => {
      const { stdout, exitCode } = run('plugin', 'list');
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Installed Plugins');
    });
  });

  describe('init', () => {
    let tempDir: string;

    afterEach(() => {
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('creates config + example files for an explicit --language', () => {
      tempDir = join(tmpdir(), `opensip-e2e-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tempDir, { recursive: true });

      const { exitCode } = runIn(tempDir, 'init', '--language', 'typescript');
      expect(exitCode).toBe(0);

      expect(existsSync(join(tempDir, 'opensip-tools.config.yml'))).toBe(true);
      expect(existsSync(join(tempDir, 'opensip-tools', 'fit', 'checks', 'example-check.mjs'))).toBe(true);
      expect(existsSync(join(tempDir, 'opensip-tools', 'fit', 'recipes', 'example-recipe.mjs'))).toBe(true);
      expect(existsSync(join(tempDir, 'opensip-tools', 'sim', 'scenarios', 'example-scenario.mjs'))).toBe(true);
      expect(existsSync(join(tempDir, '.gitignore'))).toBe(true);
    });

    it('reports already-initialized state on second run', () => {
      tempDir = join(tmpdir(), `opensip-e2e-init2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tempDir, { recursive: true });

      // First run creates the layout.
      runIn(tempDir, 'init', '--language', 'typescript');
      // Second run refuses with exit 2 and surfaces a partialStateError
      // pointing at --keep / --remove.
      const { stdout, exitCode } = runIn(tempDir, 'init', '--language', 'typescript', '--json');
      expect(exitCode).toBe(2);
      const output = JSON.parse(stdout);
      expect(output.created).toBe(false);
      expect(output.state).toBe('fully-initialized');
      expect(output.partialStateError?.state).toBe('fully-initialized');
    });

    it('exits 2 with a prompt when language is ambiguous and --language not passed', () => {
      tempDir = join(tmpdir(), `opensip-e2e-init3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(tempDir, { recursive: true });

      const { exitCode } = runIn(tempDir, 'init', '--json');
      expect(exitCode).toBe(2);
      // Nothing should have been written.
      expect(existsSync(join(tempDir, 'opensip-tools.config.yml'))).toBe(false);
    });
  });

  describe('output cleanliness', () => {
    it('NO_COLOR=1 disables ANSI escape sequences', () => {
      const { stdout } = run('--help');
      // ANSI escape sequences start with ESC (0x1b)
       
      const hasAnsi = stdout.includes('[');
      expect(hasAnsi).toBe(false);
    });

    it('--list output has no ANSI escape sequences', () => {
      const { stdout } = run('fit', '--list');
       
      const hasAnsi = stdout.includes('[');
      expect(hasAnsi).toBe(false);
    });
  });
});
