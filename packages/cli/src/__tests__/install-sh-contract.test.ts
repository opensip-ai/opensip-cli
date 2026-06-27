/**
 * Contract test: the public curl|sh installer (`scripts/install.sh`) stays in
 * lockstep with the live CLI surface.
 *
 * install.sh runs a post-install smoke test that scaffolds a throwaway project
 * (`init … --json`) and opens the data store (`sessions list --json`). If a
 * future change renames or drops a flag the installer depends on, a real user's
 * very first run breaks — yet nothing else in CI exercises install.sh (it is a
 * website-hosted shell script, not a workspace package). This test locks BOTH
 * directions, the same philosophy as `release-package-order-contract.test.ts`:
 *
 *   1. install.sh STILL invokes its smoke commands with the expected flags — so
 *      the installer cannot silently stop testing the install (forces a
 *      conscious update here if the installer's smoke surface changes).
 *   2. Those exact commands STILL succeed against the freshly built CLI — so the
 *      CLI cannot silently drop a flag the installer needs.
 *
 * Spawning the built binary requires `pnpm build` first (the CI test step runs
 * after Build), exactly like the sibling e2e suites.
 *
 * Sits beside the other repo-file contract tests and resolves the repo root the
 * same way (walk up to pnpm-workspace.yaml).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

function findRepoRoot(start: string): string {
  let dir = start;
  let prev = '';
  while (dir !== prev) {
    try {
      readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
      return dir;
    } catch {
      // not the root — keep walking up
    }
    prev = dir;
    dir = dirname(dir);
  }
  throw new Error(`could not locate repo root (pnpm-workspace.yaml) from ${start}`);
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
const INSTALL_SH = readFileSync(join(REPO_ROOT, 'scripts/install.sh'), 'utf8');

const cli = distRunner();

/** Parse a `--json` envelope from CLI stdout and assert it is a clean `ok`. */
function expectOkEnvelope(stdout: string): void {
  const env = JSON.parse(stdout) as { status?: string; exitCode?: number };
  expect(env.status).toBe('ok');
  expect(env.exitCode).toBe(0);
}

describe('install.sh ⇄ CLI surface contract', () => {
  // ---- direction 1: the installer still smoke-tests with the expected flags --
  describe('installer smoke commands reference current flags', () => {
    it('init smoke step uses --cwd, --language, and --json', () => {
      // A single `init` invocation carrying all three flags (line ~176).
      expect(INSTALL_SH).toMatch(/\binit\b[^\n]*--cwd[^\n]*--language[^\n]*--json/);
    });

    it('data-store smoke step is `sessions list --json`', () => {
      expect(INSTALL_SH).toMatch(/sessions list --json/);
    });
  });

  // ---- direction 2: those commands still work against the built CLI ---------
  describe('installer smoke commands succeed against the built CLI', () => {
    let dir = '';

    beforeAll(() => {
      // Fail loudly with an actionable message if the build is missing, rather
      // than surfacing an opaque spawn error.
      const { exitCode } = cli.run(['--version']);
      expect(
        exitCode,
        'packages/cli/dist/index.js must be built before this test (pnpm build)',
      ).toBe(0);
    });

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = '';
    });

    it('init --cwd <tmp> --language typescript --json → ok (the install smoke test)', () => {
      dir = mkdtempSync(join(tmpdir(), 'opensip-install-contract-'));
      // Mirrors install.sh: run from any cwd, target the scratch dir via --cwd.
      const { stdout, exitCode } = cli.run([
        'init',
        '--cwd',
        dir,
        '--language',
        'typescript',
        '--json',
      ]);
      expect(exitCode).toBe(0);
      expectOkEnvelope(stdout);
    });

    it('sessions list --json (in the scaffolded dir) → ok (the data-store smoke test)', () => {
      dir = mkdtempSync(join(tmpdir(), 'opensip-install-contract-'));
      const init = cli.run(['init', '--cwd', dir, '--language', 'typescript', '--json']);
      expect(init.exitCode).toBe(0);
      // Mirrors install.sh: `cd "$SMOKE_DIR" && opensip sessions list --json`.
      const { stdout, exitCode } = cli.run(['sessions', 'list', '--json'], {
        cwd: dir,
      });
      expect(exitCode).toBe(0);
      expectOkEnvelope(stdout);
    });
  });
});
