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
 * the build must be done first (pnpm --filter=opensip-tools build).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const cli = distRunner();

function runCli(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number } {
  return cli.run(args, { cwd, env });
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
  it('shows the project root with no walked-up suffix when cwd === root', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
    const { stdout, exitCode } = runCli(['fit-list'], testDir);
    expect(exitCode).toBe(0);
    // The default `mini` banner carries the project path inline in its box
    // (the `ℹ Project:` line is suppressed for mini — its box owns the path).
    // So we assert the bare root path, not the `ℹ Project:` prefix.
    expect(stdout).toContain(testDir);
    expect(stdout).not.toContain('found');
  });

  it('shows "(found N levels up)" when run from a subdir', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
    const subdir = join(testDir, 'packages', 'api');
    mkdirSync(subdir, { recursive: true });
    const { stdout, exitCode } = runCli(['fit-list'], subdir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(testDir);
    // The walked-up hint surfaces in the mini box's path line (vs the
    // cwd===root case, which asserts NOT 'found'). Exact wording is
    // unit-tested in cli-ui; here we assert the marker word, which is robust
    // even if a long tmp path wraps inside the box at 80 cols.
    expect(stdout).toContain('found');
  });

  it('suppresses the imperative header for --json', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
    const { stdout } = runCli(['fit-list', '--json'], testDir);
    expect(stdout).not.toContain('ℹ Project:');
  });
});

describe('phantom-scaffold regression (the original bug)', () => {
  it('running fit-list from a subdir uses the parent project root', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
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

  it('project-scoped --json emits a structured bootstrap.error outcome on stdout', () => {
    const { stdout, exitCode } = runCli(['fit-list', '--json'], testDir);
    expect(exitCode).toBe(2);
    // 2.12.0 (§4.7): a pre-handler no-project failure is a structured
    // CommandOutcome (kind 'bootstrap.error'), not a bare `{ error }`.
    const outcome = JSON.parse(stdout) as {
      kind: string;
      status: string;
      errors: { message: string }[];
    };
    expect(outcome.kind).toBe('bootstrap.error');
    expect(outcome.status).toBe('error');
    expect(outcome.errors[0].message).toContain('No opensip-tools.config.yml found');
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
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
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
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
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
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 99\ntargets: {}\n',
      'utf8',
    );
    const { stderr, exitCode } = runCli(['fit-list'], testDir);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('uses a newer schema than your CLI supports');
    expect(stderr).toContain('npm install -g opensip-tools@latest');
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

describe('full Tool-plugin install path (audit P1b)', () => {
  const FIXTURE_TOOL = join(__dirname, 'fixtures', 'tool-plugin');
  const TOOL_PKG = join('@opensip-tools-fixture', 'tool-demo');

  // A throwaway HOME so the user-global install (~/.opensip-tools/...) lands
  // in a temp dir, never the real home. resolveUserPaths() reads homedir().
  function withFreshHome(): { home: string; env: Record<string, string> } {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-e2e-home-')));
    return { home, env: { HOME: home, USERPROFILE: home } };
  }

  function writeProject(): void {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
  }

  it('`plugin add <tool>` installs user-global and the subcommand works in the project', () => {
    writeProject();
    const { home, env } = withFreshHome();
    try {
      const add = runCli(['plugin', 'add', FIXTURE_TOOL, '--json'], testDir, env);
      expect(add.exitCode).toBe(0);
      // 2.12.0: the PluginResult rides under `.data` of the outcome wrapper.
      expect((JSON.parse(add.stdout) as { data: { success?: boolean } }).data.success).toBe(true);
      // Landed in the user-global tool host dir, NOT a fit/sim domain dir,
      // and NO config entry was written (tools auto-discover by marker).
      expect(
        existsSync(join(home, '.opensip-tools', 'plugins', 'tool', 'node_modules', TOOL_PKG)),
      ).toBe(true);
      expect(readFileSync(join(testDir, 'opensip-tools.config.yml'), 'utf8')).not.toContain(
        'tool-demo',
      );

      // Discovered + mounted: top-level help lists the new subcommand …
      expect(runCli(['--help'], testDir, env).stdout).toContain('audit-demo');
      // … and it actually runs.
      const ran = runCli(['audit-demo'], testDir, env);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toContain('audit-demo ran');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('`plugin add <tool> --project` installs project-local (.runtime/) only', () => {
    writeProject();
    const { home, env } = withFreshHome();
    try {
      const add = runCli(['plugin', 'add', FIXTURE_TOOL, '--project', '--json'], testDir, env);
      expect(add.exitCode).toBe(0);
      expect(
        existsSync(
          join(testDir, 'opensip-tools', '.runtime', 'plugins', 'tool', 'node_modules', TOOL_PKG),
        ),
      ).toBe(true);
      // Did NOT install user-global.
      expect(existsSync(join(home, '.opensip-tools', 'plugins', 'tool'))).toBe(false);
      const ran = runCli(['audit-demo'], testDir, env);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toContain('audit-demo ran');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('`plugin list` reports an installed tool plugin under the `tool` domain', () => {
    writeProject();
    const { home, env } = withFreshHome();
    try {
      runCli(['plugin', 'add', FIXTURE_TOOL, '--json'], testDir, env);
      const list = runCli(['plugin', 'list', '--json'], testDir, env);
      expect(list.exitCode).toBe(0);
      const plugins = (
        JSON.parse(list.stdout) as { data: { plugins: { domain: string; namespace: string }[] } }
      ).data.plugins;
      expect(plugins.some((p) => p.domain === 'tool' && p.namespace.includes('tool-demo'))).toBe(
        true,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('no-side-effects', () => {
  it('uninstall --project --dry-run does NOT open the SQLite datastore', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 1\ntargets: {}\n',
      'utf8',
    );
    mkdirSync(join(testDir, 'opensip-tools', 'fit', 'checks'), { recursive: true });
    writeFileSync(join(testDir, 'opensip-tools', 'fit', 'checks', 'my.mjs'), '\n', 'utf8');
    runCli(['uninstall', '--project', '--dry-run', '--yes'], testDir);
    // The catastrophic side effect was the SQLite file. With lazy
    // datastore (Phase 1.3), dry-run never reads cli.datastore so
    // openSqliteBackend's mkdirSync + open never fires.
    expect(existsSync(join(testDir, 'opensip-tools', '.runtime', 'datastore.sqlite'))).toBe(false);
  });

  it('schemaVersion: 99 bailout does NOT open SQLite or initialise logs', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      'schemaVersion: 99\ntargets: {}\n',
      'utf8',
    );
    runCli(['fit-list'], testDir);
    // pre-action-hook exits 2 BEFORE the side-effect block
    // (configureLogger({ logDir }) + setProjectContextForRun). No
    // .runtime/ tree at all.
    expect(existsSync(join(testDir, 'opensip-tools', '.runtime'))).toBe(false);
  });
});
