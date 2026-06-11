/**
 * fit env-precedence acceptance test, END-TO-END through the real binary
 * (ADR-0023, Phase 4).
 *
 * The single observable claim: the declared env bindings
 * OPENSIP_FIT_FAIL_ON_ERRORS / OPENSIP_FIT_FAIL_ON_WARNINGS actually change the
 * `fit` gate (and therefore the process exit code) WITHOUT editing
 * opensip-tools.config.yml. Before Phase 4 these were resolved into
 * `scope.toolConfig` but no-ops at runtime — the gate read the re-parsed
 * `signalersConfig.fitness.*`. These tests run the real CLI against the same
 * project with and without the env var and assert the exit code flips, proving
 * env > file > defaults is the live runtime source of truth.
 *
 * Requires the build (it runs `packages/cli/dist/index.js`).
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { distRunner } from './harness/cli-acceptance.js';

const cli = distRunner();

let testDir: string;

/** Write the project config with explicit gate thresholds in the FILE. */
function writeConfig(failOnErrors: number, failOnWarnings: number): void {
  writeFileSync(
    join(testDir, 'opensip-tools.config.yml'),
    [
      'schemaVersion: 1',
      'fitness:',
      `  failOnErrors: ${String(failOnErrors)}`,
      `  failOnWarnings: ${String(failOnWarnings)}`,
      'targets:',
      '  src:',
      '    description: source',
      '    languages: [typescript]',
      '    concerns: [backend, config]',
      '    include: ["**/*.ts"]',
      '',
    ].join('\n'),
    'utf8',
  );
}

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'opensip-fit-env-prec-')));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('fit gate env precedence — through the real binary (ADR-0023, Phase 4)', () => {
  it('OPENSIP_FIT_FAIL_ON_ERRORS=0 makes an error-emitting run exit 0, with no config edit', () => {
    // File says fail-on-errors:1. A single error-level check (env-secret-exposure
    // fires on JSON.stringify(process.env)) makes the gate fail by default.
    writeConfig(/* failOnErrors */ 1, /* failOnWarnings */ 0);
    writeFileSync(
      join(testDir, 'leak.ts'),
      'export const dump = () => JSON.stringify(process.env);\n',
      'utf8',
    );

    // Baseline: the gate fails (non-zero exit) — the error finding trips failOnErrors:1.
    const failing = cli.run(['fit', '--check', 'env-secret-exposure', '--cwd', testDir], {
      cwd: testDir,
    });
    expect(failing.exitCode).not.toBe(0);

    // Same project, same config file — only the env var changes. The gate must
    // now pass (exit 0): env (0 = never fail on errors) overrides the file (1).
    const passing = cli.run(['fit', '--check', 'env-secret-exposure', '--cwd', testDir], {
      cwd: testDir,
      env: { OPENSIP_FIT_FAIL_ON_ERRORS: '0' },
    });
    expect(passing.exitCode).toBe(0);
  });

  it('OPENSIP_FIT_FAIL_ON_WARNINGS=1 flips a warning-only run from exit 0 to non-zero, with no config edit', () => {
    // File says fail-on-warnings:0 → a warning-only run passes by default.
    writeConfig(/* failOnErrors */ 1, /* failOnWarnings */ 0);
    writeFileSync(
      join(testDir, 'note.ts'),
      'export const x = 1; // TODO finish this later\n',
      'utf8',
    );

    // Baseline: the warning-only run passes (exit 0) — failOnWarnings:0.
    const passing = cli.run(['fit', '--check', 'no-todo-comments', '--cwd', testDir], {
      cwd: testDir,
    });
    expect(passing.exitCode).toBe(0);

    // Same project, same config — env OPENSIP_FIT_FAIL_ON_WARNINGS=1 makes the
    // gate fail on the warning (env overrides the file's 0).
    const failing = cli.run(['fit', '--check', 'no-todo-comments', '--cwd', testDir], {
      cwd: testDir,
      env: { OPENSIP_FIT_FAIL_ON_WARNINGS: '1' },
    });
    expect(failing.exitCode).not.toBe(0);
  });
});
