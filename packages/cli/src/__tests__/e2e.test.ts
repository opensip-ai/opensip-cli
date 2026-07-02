/**
 * End-to-end tests for the opensip-cli CLI.
 *
 * These tests exercise the actual CLI binary (packages/cli/dist/index.js)
 * against a small fixture project. The build must be done before running
 * these tests (pnpm --filter=opensip-cli build).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, afterEach, beforeEach } from 'vitest';

import { distRunner, CLI_PKG_VERSION } from './harness/cli-acceptance.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
// __dirname = packages/cli/src/__tests__/ → CLI binary is at packages/cli/dist/index.js
const FIXTURE = join(__dirname, 'fixtures/sample-project');

const cli = distRunner();

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
    rmSync(join(FIXTURE, 'opensip-cli', '.runtime'), {
      recursive: true,
      force: true,
    });
  });

  it('--help shows usage information', () => {
    const { stdout, exitCode } = cli.run(['--help'], { cwd: FIXTURE });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Commands:');
    expect(stdout).toContain('fit');
  });

  it('--version shows the version string', () => {
    const { stdout, exitCode } = cli.run(['--version'], { cwd: FIXTURE });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(CLI_PKG_VERSION);
  });

  // Per-tool --version (decorateToolPrimary): `opensip <tool> --version` prints
  // the TOOL's own version (`<verb> <semver>`), distinct from `opensip
  // --version` (the CLI). The host guarantees this uniformly on every primary.
  const VERSION_LABEL: Record<string, string> = {
    fit: 'fitness',
    sim: 'simulation',
    graph: 'graph',
  };

  it.each(['fit', 'graph', 'sim'])('%s --version prints the tool version', (tool) => {
    const { stdout, exitCode } = cli.run([tool, '--version'], {
      cwd: FIXTURE,
    });
    expect(exitCode).toBe(0);
    const label = VERSION_LABEL[tool] ?? tool;
    expect(stdout.trim()).toMatch(new RegExp(`^${label} \\d+\\.\\d+\\.\\d+`));
  });

  // The guaranteed baseline flags are present uniformly on every tool primary.
  it.each(['fit', 'graph', 'sim'])('%s --help lists the guaranteed baseline flags', (tool) => {
    const { stdout, exitCode } = cli.run([tool, '--help'], { cwd: FIXTURE });
    expect(exitCode).toBe(0);
    for (const flag of ['--cwd', '--json', '--config', '--quiet', '--verbose', '--version']) {
      expect(stdout, `${tool} --help must list ${flag}`).toContain(flag);
    }
  });

  describe('fit', () => {
    it('runs successfully with --json', () => {
      const { stdout, exitCode } = cli.run(['fit', '--json'], { cwd: FIXTURE });
      // 2.12.0 (§5.5): --json is a CommandOutcome wrapper; the (unchanged) signal
      // envelope rides under `.envelope`. Consumers read `.envelope` not the top level.
      const outcome = JSON.parse(stdout);
      expect(outcome.kind).toBe('fit.run');
      expect(outcome.status).toBe('ok');
      const output = outcome.envelope;
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
      const { stdout, exitCode } = cli.run(['fit', '--list'], { cwd: FIXTURE });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Available Fitness Checks');
    });

    it('--recipes shows available recipes', () => {
      const { stdout, exitCode } = cli.run(['fit', '--recipes'], {
        cwd: FIXTURE,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Available Recipes');
    });

    it('--list --json outputs valid JSON', () => {
      const { stdout, exitCode } = cli.run(['fit', '--list', '--json'], {
        cwd: FIXTURE,
      });
      expect(exitCode).toBe(0);
      // 2.12.0: a CommandResult rides under `.data` of the outcome wrapper.
      const output = JSON.parse(stdout).data;
      expect(output.type).toBe('list-checks');
      expect(Array.isArray(output.checks)).toBe(true);
      expect(output.totalCount).toBeGreaterThan(0);
    });

    it('--recipes --json outputs valid JSON', () => {
      const { stdout, exitCode } = cli.run(['fit', '--recipes', '--json'], {
        cwd: FIXTURE,
      });
      expect(exitCode).toBe(0);
      const output = JSON.parse(stdout).data;
      expect(output.type).toBe('list-recipes');
      expect(Array.isArray(output.recipes)).toBe(true);
    });

    it('--check runs a single check', () => {
      const { stdout } = cli.run(['fit', '--json', '--check', 'no-console-log'], { cwd: FIXTURE });
      const output = JSON.parse(stdout).envelope;
      expect(output.tool).toBe('fit');
      expect(output.verdict).toBeDefined();
      // --check must narrow to exactly one check (unit), not the full default recipe.
      expect(output.verdict.summary.total).toBe(1);
      expect(output.units).toHaveLength(1);
      expect(output.units[0].slug).toBe('no-console-log');
    });

    it('--recipe quick-smoke runs without error', () => {
      const { stdout } = cli.run(['fit', '--json', '--recipe', 'quick-smoke'], {
        cwd: FIXTURE,
      });
      const output = JSON.parse(stdout).envelope;
      expect(output.tool).toBe('fit');
      expect(output.verdict).toBeDefined();
      expect(output.verdict.summary.total).toBeGreaterThan(0);
    });

    it('--json summary fields have expected types', () => {
      const { stdout } = cli.run(['fit', '--json', '--recipe', 'quick-smoke'], {
        cwd: FIXTURE,
      });
      const output = JSON.parse(stdout).envelope;
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
      const { stdout, exitCode } = cli.run(['fit', '--json', '--recipe', 'nonexistent-recipe'], {
        cwd: FIXTURE,
      });
      expect(exitCode).toBe(2);
      // 2.12.0 (§5.5): a failed --json run is a status:'error' outcome carrying a
      // structured `errors[].message` (retires the bare `{ error }` shape).
      const outcome = JSON.parse(stdout);
      expect(outcome.status).toBe('error');
      expect(outcome.errors[0].message).toContain('nonexistent-recipe');
    });

    it('fails with exit 2 when no config is found', () => {
      const tempDir = join(
        tmpdir(),
        `opensip-e2e-noconfig-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tempDir, { recursive: true });
      try {
        const { stdout, exitCode } = cli.run(['fit', '--json'], {
          cwd: tempDir,
        });
        expect(exitCode).toBe(2);
        // 2.12.0 (§4.7): no-project --json is a structured bootstrap.error outcome.
        const outcome = JSON.parse(stdout);
        expect(outcome.kind).toBe('bootstrap.error');
        expect(outcome.errors[0].message).toContain('No opensip-cli.config.yml found');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('runs with synthesized config in a TypeScript project before init', () => {
      const tempDir = join(
        tmpdir(),
        `opensip-e2e-noinit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      try {
        writeFileSync(join(tempDir, 'package.json'), '{"type":"module"}\n', 'utf8');
        writeFileSync(join(tempDir, 'tsconfig.json'), '{"compilerOptions":{}}\n', 'utf8');
        writeFileSync(join(tempDir, 'src', 'a.ts'), 'export const x = 1;\nconsole.log(x);\n');

        const fakeHome = join(tempDir, '.home');
        const { stdout, stderr, exitCode } = cli.run(
          ['fit', '--json', '--check', 'no-console-log'],
          {
            cwd: tempDir,
            env: { HOME: fakeHome },
          },
        );
        expect([0, 1]).toContain(exitCode);
        const outcome = JSON.parse(stdout);
        expect(outcome.kind).toBe('fit.run');
        expect(outcome.status).toBe('ok');
        expect(outcome.envelope.verdict.summary.total).toBe(1);
        expect(stderr).not.toContain('opensip init');
        expect(existsSync(join(tempDir, 'opensip-cli'))).toBe(false);
        expect(existsSync(join(fakeHome, '.opensip-cli', 'cache', 'ephemeral'))).toBe(true);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('respects --config flag with an explicit path', () => {
      const tempDir = join(
        tmpdir(),
        `opensip-e2e-explicit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(join(tempDir, 'nested'), { recursive: true });
      try {
        // Seed the fixture's config into a non-default location
        const configSrc = readFileSync(join(FIXTURE, 'opensip-cli.config.yml'), 'utf8');
        const configPath = join(tempDir, 'nested', 'custom.yml');
        writeFileSync(configPath, configSrc);
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        writeFileSync(join(tempDir, 'src', 'a.ts'), 'export const x = 1\n');

        const { stdout, exitCode } = cli.run(
          ['fit', '--json', '--check', 'no-console-log', '--config', 'nested/custom.yml'],
          { cwd: tempDir },
        );
        expect(exitCode).toBe(0);
        const output = JSON.parse(stdout).envelope;
        expect(output.tool).toBe('fit');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('ignores package.json#opensip-cli.configPath pointer', () => {
      const tempDir = join(
        tmpdir(),
        `opensip-e2e-pkgjson-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(join(tempDir, '.config'), { recursive: true });
      try {
        // Invalid on purpose: if the package.json pointer were still honored,
        // pre-action config validation would fail before fit runs.
        writeFileSync(join(tempDir, '.config', 'opensip-cli.config.yml'), 'targets:\n  bad:\n');
        writeFileSync(
          join(tempDir, 'package.json'),
          JSON.stringify({
            name: 'pkg-pointer-test',
            'opensip-cli': { configPath: '.config/opensip-cli.config.yml' },
          }),
        );
        mkdirSync(join(tempDir, 'src'), { recursive: true });
        writeFileSync(join(tempDir, 'src', 'a.ts'), 'export const x = 1\n');

        const { stdout, stderr, exitCode } = cli.run(
          ['fit', '--json', '--check', 'no-console-log'],
          {
            cwd: tempDir,
          },
        );
        expect([0, 1]).toContain(exitCode);
        const outcome = JSON.parse(stdout);
        expect(outcome.kind).toBe('fit.run');
        expect(outcome.status).toBe('ok');
        expect(`${stdout}\n${stderr}`).not.toContain('.config/opensip-cli.config.yml');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('sim', () => {
    it('fails closed with exit 2 when no scenarios are registered (audit P1c)', () => {
      // No user-authored scenarios in the e2e env, so the default recipe
      // matches zero scenarios. "Empty work is not success": a run that
      // simulated nothing must NOT report as a pass (exit 0) — that would
      // mask a misconfig/missing-dep as a green CI run. It is a
      // configuration/unavailable condition (exit 2), distinct from an
      // actual scenario failure (exit 1).
      const { exitCode } = cli.run(['sim'], { cwd: FIXTURE });
      expect(exitCode).toBe(2);
    });

    it('exits 2 when given an unknown recipe name', () => {
      const { exitCode } = cli.run(['sim', '--recipe', 'nonexistent'], {
        cwd: FIXTURE,
      });
      expect(exitCode).toBe(2);
    });
  });

  describe('graph', () => {
    it('rejects an invalid --resolution value with CONFIGURATION_ERROR (exit 2)', () => {
      // Regression for the 2.11.0 command-plane migration: `--resolution`'s
      // value validation moved from an in-handler `ValidationError` (→ exit 2)
      // to a declarative Commander `choices`. Commander's default choices
      // failure exits 1, silently dropping the documented usage-error code.
      // The root program's `.exitOverride()` + `handleParseError` re-map
      // invalid-argument-value to CONFIGURATION_ERROR (2), restoring 2.10.0
      // parity. Asserting `=== 2` end-to-end closes that loop. The error line
      // is Commander's (the one sanctioned surface delta).
      const { exitCode, stderr } = cli.run(['graph', '--resolution', 'bogus'], {
        cwd: FIXTURE,
      });
      expect(exitCode).toBe(2);
      expect(stderr).toContain("argument 'bogus' is invalid");
    });
  });

  describe('sessions list', () => {
    it('runs without crashing', () => {
      const { exitCode } = cli.run(['sessions', 'list'], { cwd: FIXTURE });
      expect(exitCode).toBe(0);
    });

    // host-owned-run-timing Phase 9 (§11 #5/#6): a REAL fit run through the
    // actual binary persists a StoredSession whose lifecycle timing is stamped
    // by the host RunTimer (the tool supplies none), with host-side overhead on
    // a sibling metrics record — proven end-to-end, not just at the unit level.
    it('a real fit run persists a host-stamped StoredSession (new timing fields + host metrics)', () => {
      // This test is STATE-DEPENDENT: the session written by the first invocation
      // must survive to the second (`sessions list`). The shared in-tree fixture
      // is wiped by `beforeEach` AND used concurrently by tool-initialize-lifecycle
      // .test.ts, so under parallel workers a wipe/write could clobber the DB
      // across the fit→list window. Run against an ISOLATED temp copy so the
      // round-trip is deterministic.
      const proj = mkdtempSync(join(tmpdir(), 'opensip-e2e-session-'));
      try {
        cpSync(FIXTURE, proj, { recursive: true });
        rmSync(join(proj, 'opensip-cli', '.runtime'), {
          recursive: true,
          force: true,
        });

        // Human path (no --json) persists the session via the host run plane.
        const fit = cli.run(['fit', '--check', 'no-eval'], { cwd: proj });
        expect([0, 1]).toContain(fit.exitCode);

        const { stdout, exitCode } = cli.run(['sessions', 'list', '--json'], {
          cwd: proj,
        });
        expect(exitCode).toBe(0);
        const outcome = JSON.parse(stdout) as {
          data?: { sessions?: Record<string, unknown>[] };
        };
        const sessions = outcome.data?.sessions ?? [];
        expect(sessions.length).toBeGreaterThanOrEqual(1);

        const s = sessions[0];
        expect(s.tool).toBe('fitness');
        // Host-stamped lifecycle timing (the tool never supplies these).
        expect(typeof s.startedAt).toBe('string');
        expect(typeof s.completedAt).toBe('string');
        expect(typeof s.durationMs).toBe('number');
        expect(s.durationMs as number).toBeGreaterThanOrEqual(0);
        // The legacy single `timestamp` field is gone (split into startedAt/completedAt).
        expect(s).not.toHaveProperty('timestamp');
        // Sibling host-metrics record is hydrated onto the session, separate from
        // the canonical durationMs (host write cost lives in persistMs).
        const hostMetrics = s.hostMetrics as Record<string, unknown> | undefined;
        expect(hostMetrics).toBeDefined();
        expect(typeof hostMetrics?.persistMs).toBe('number');
      } finally {
        rmSync(proj, { recursive: true, force: true });
      }
    });
  });

  describe('<tool> plugin list', () => {
    it('shows fit pack information (domain-bound under the fit primary)', () => {
      // The top-level `plugin` group was retired — pack ops mount under each
      // pack-supporting tool primary (`opensip fit plugin …`).
      const { stdout, exitCode } = cli.run(['fit', 'plugin', 'list'], {
        cwd: FIXTURE,
      });
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Installed Plugins');
    });

    it('has no top-level `plugin` command', () => {
      const { exitCode } = cli.run(['plugin', 'list'], { cwd: FIXTURE });
      expect(exitCode).not.toBe(0);
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
      tempDir = join(
        tmpdir(),
        `opensip-e2e-init-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tempDir, { recursive: true });

      const { exitCode } = cli.run(['init', '--language', 'typescript'], {
        cwd: tempDir,
      });
      expect(exitCode).toBe(0);

      expect(existsSync(join(tempDir, 'opensip-cli.config.yml'))).toBe(true);
      expect(existsSync(join(tempDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs'))).toBe(
        true,
      );
      expect(existsSync(join(tempDir, 'opensip-cli', 'fit', 'recipes', 'example-recipe.mjs'))).toBe(
        true,
      );
      expect(
        existsSync(join(tempDir, 'opensip-cli', 'sim', 'scenarios', 'example-scenario.mjs')),
      ).toBe(true);
      expect(existsSync(join(tempDir, 'opensip-cli', 'sim', 'recipes', 'example-recipe.mjs'))).toBe(
        true,
      );
      expect(existsSync(join(tempDir, '.gitignore'))).toBe(true);

      const sim = cli.run(['sim', '--recipe', 'example', '--json'], {
        cwd: tempDir,
        timeout: 120_000,
      });
      expect(sim.exitCode).toBe(0);
      const outcome = JSON.parse(sim.stdout) as {
        kind?: string;
        envelope?: {
          recipe?: string;
          units?: { slug?: string }[];
        };
      };
      expect(outcome.kind).toBe('sim.run');
      expect(outcome.envelope?.recipe).toBe('example');
      expect(outcome.envelope?.units?.[0]?.slug).toBe('example-scenario');
    });

    it('reports already-initialized state on second run', () => {
      tempDir = join(
        tmpdir(),
        `opensip-e2e-init2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tempDir, { recursive: true });

      // First run creates the layout.
      cli.run(['init', '--language', 'typescript'], { cwd: tempDir });
      const configPath = join(tempDir, 'opensip-cli.config.yml');
      const configBefore = readFileSync(configPath, 'utf8');
      const examplePath = join(tempDir, 'opensip-cli', 'fit', 'checks', 'example-check.mjs');
      const exampleBefore = readFileSync(examplePath, 'utf8');
      // Second run refreshes managed guidance and exits 0 without rewriting
      // config or scaffold examples.
      const { stdout, exitCode } = cli.run(['init', '--language', 'typescript', '--json'], {
        cwd: tempDir,
      });
      expect(exitCode).toBe(0);
      // 2.12.0: the InitResult rides under `.data` of the outcome wrapper.
      const output = JSON.parse(stdout).data;
      expect(output.created).toBe(false);
      expect(output.refreshed).toBe(true);
      expect(output.state).toBe('fully-initialized');
      expect(output.partialStateError).toBeUndefined();
      expect(output.agentGuidance?.targets?.length).toBeGreaterThan(0);
      expect(readFileSync(configPath, 'utf8')).toBe(configBefore);
      expect(readFileSync(examplePath, 'utf8')).toBe(exampleBefore);
    });

    it('exits 2 with a prompt when language is ambiguous and --language not passed', () => {
      tempDir = join(
        tmpdir(),
        `opensip-e2e-init3-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(tempDir, { recursive: true });

      const { exitCode } = cli.run(['init', '--json'], { cwd: tempDir });
      expect(exitCode).toBe(2);
      // Nothing should have been written.
      expect(existsSync(join(tempDir, 'opensip-cli.config.yml'))).toBe(false);
    });
  });

  describe('output cleanliness', () => {
    it('NO_COLOR=1 disables ANSI escape sequences', () => {
      const { stdout } = cli.run(['--help'], { cwd: FIXTURE });
      // ANSI escape sequences start with ESC (0x1b)

      const hasAnsi = stdout.includes('[');
      expect(hasAnsi).toBe(false);
    });

    it('--list output has no ANSI escape sequences', () => {
      const { stdout } = cli.run(['fit', '--list'], { cwd: FIXTURE });

      const hasAnsi = stdout.includes('[');
      expect(hasAnsi).toBe(false);
    });
  });
});
