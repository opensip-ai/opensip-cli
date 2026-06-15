/**
 * The 3.0.0 acceptance test, END-TO-END through the real binary (§1 / §8).
 *
 * This is the executable form of the platform's single acceptance test: "delete
 * the hardcoded import of `fit`, load it as an external package, and have the CLI
 * load it with IDENTICAL behaviour." It runs the actual CLI (`dist/index.js`)
 * TWICE against the same project:
 *
 *   1. **bundled** — `fit` loads via the bundled path (`BUNDLED_TOOL_PACKAGES`).
 *   2. **installed** — `OPENSIP_CLI_SKIP_BUNDLED=fitness` drops `fit` from the
 *      bundled set, so the CLI discovers + loads it through the EXTERNAL plugin
 *      path (`discoverAndRegisterToolPackages`, source `'installed'`) instead.
 *
 * Then it asserts the two are observably identical: the check list, the `--help`
 * surface, the `fit --json` `CommandOutcome` (volatile run-id/timestamps/durations
 * normalized away), and the exit code. Provenance changes only HOW `fit` is
 * admitted (§5.2.1) — never what an admitted `fit` does.
 *
 * The component-level proof lives in `fit-external-load.test.ts` (in-process
 * surface identity); this is the real binary, the real run pipeline, the real
 * check discovery — the GA bar made concrete. Requires the build (it runs
 * `packages/cli/dist/index.js`).
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

const cli = distRunner();
/** Run `fit` through the INSTALLED path: drop it from the bundled set so the CLI
 *  discovers + loads it as an external plugin (the §1 "as if external" lever). */
const AS_INSTALLED = { OPENSIP_CLI_SKIP_BUNDLED: 'fitness' };

let testDir: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-fit-acceptance-')));
  // A minimal but real project: a config + a source file that a universal check
  // flags, so the run produces deterministic findings to compare (not just 0).
  // Also write package.json so this temp dir is treated as an independent project
  // root. This isolates local check discovery (under <project>/opensip-cli/fit/checks/)
  // to *this* tree only and prevents ancestor walks (from the monorepo workspace
  // location of the dist CLI or an "installed" fitness plugin) from picking up the
  // repo's own large set of local-only checks (added for dogfooding / mechanisms).
  // Without this the "bundled" vs "installed" fitness paths can see different check
  // sets, causing the normalized CommandOutcome envelope comparison to fail even
  // though behaviour on the fixture is identical.
  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({ name: 'fit-acceptance-fixture', private: true }, null, 2),
    'utf8',
  );
  writeFileSync(
    join(testDir, 'opensip-cli.config.yml'),
    'schemaVersion: 1\ntargets:\n  src:\n    description: source\n    languages: [typescript]\n    concerns: [backend]\n    include: ["**/*.ts"]\n',
    'utf8',
  );
  writeFileSync(
    join(testDir, 'sample.ts'),
    'export const x = 1; // EXAMPLE_TODO left in source\n',
    'utf8',
  );
  // Ensure the analyzed project declares (empty) local checks dir so discovery
  // for fitness treats it as self-contained and does not augment with monorepo locals.
  mkdirSync(join(testDir, 'opensip-cli/fit/checks'), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Normalize an outcome for comparison: strip the fields that legitimately vary
 * run-to-run (id / clock / timing), and sort every array by content so the
 * parallel scheduler's non-deterministic unit/signal ORDER doesn't matter — the
 * SET of findings is what "identical behaviour" means.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (['runId', 'createdAt', 'durationMs', 'diagnostics', 'id'].includes(k)) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return value;
}

describe('fit acceptance — bundled ≡ installed, through the real binary (§1/§8)', () => {
  it('loads fit through the installed path when dropped from the bundled set (and it runs)', () => {
    const installed = cli.run(['fit', '--json', '--cwd', testDir], {
      cwd: testDir,
      env: AS_INSTALLED,
    });
    const outcome = JSON.parse(installed.stdout) as {
      kind: string;
      status: string;
      envelope?: { tool?: string };
    };
    // fit ran end-to-end via the EXTERNAL plugin path — not bundled.
    expect(outcome.kind).toBe('fit.run');
    expect(outcome.envelope?.tool).toBe('fit');
  });

  it('the check list is identical (fit-list)', () => {
    const bundled = cli.run(['fit-list', '--json', '--cwd', testDir], {
      cwd: testDir,
    });
    const installed = cli.run(['fit-list', '--json', '--cwd', testDir], {
      cwd: testDir,
      env: AS_INSTALLED,
    });
    expect(installed.exitCode).toBe(bundled.exitCode);
    expect(normalize(JSON.parse(installed.stdout))).toEqual(normalize(JSON.parse(bundled.stdout)));
  });

  it('the `fit --json` CommandOutcome is identical (volatile fields normalized) + same exit code', () => {
    const bundled = cli.run(['fit', '--json', '--cwd', testDir], {
      cwd: testDir,
    });
    const installed = cli.run(['fit', '--json', '--cwd', testDir], {
      cwd: testDir,
      env: AS_INSTALLED,
    });

    expect(installed.exitCode).toBe(bundled.exitCode);

    const b = normalize(JSON.parse(bundled.stdout)) as {
      kind: string;
      status: string;
      envelope?: unknown;
    };
    const i = normalize(JSON.parse(installed.stdout)) as {
      kind: string;
      status: string;
      envelope?: unknown;
    };
    expect(i.kind).toBe(b.kind);
    expect(i.status).toBe(b.status);
    // The whole normalized envelope (verdict, units, signals) is byte-identical:
    // the same checks ran on the same files and produced the same findings,
    // regardless of which path loaded fit.
    expect(i.envelope).toEqual(b.envelope);
  }, 180_000);

  it('the `fit --help` surface is identical (names, flags, descriptions)', () => {
    const bundled = cli.run(['fit', '--help'], { cwd: testDir });
    const installed = cli.run(['fit', '--help'], {
      cwd: testDir,
      env: AS_INSTALLED,
    });
    expect(installed.exitCode).toBe(bundled.exitCode);
    expect(installed.stdout).toBe(bundled.stdout);
  });
});
