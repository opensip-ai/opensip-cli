/**
 * @fileoverview ADR-0169 — bound nested workspace test concurrency.
 *
 * A repository-wide test run has two schedulers: Turbo starts package tasks,
 * then each package's Vitest process starts file workers (and many CLI tests
 * fork real child processes). Leaving both schedulers at their independent
 * defaults can multiply host parallelism and turn resource starvation into
 * false timeout failures. Keep the aggregate lane bounded without retries,
 * skips, or wider timeouts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

const WORKSPACE_TEST_SCRIPTS = ['test', 'test:coverage', 'test:coverage:fresh'];

test('workspace test scripts bound both Turbo tasks and Vitest workers', () => {
  for (const scriptName of WORKSPACE_TEST_SCRIPTS) {
    const command = manifest.scripts?.[scriptName];
    assert.equal(typeof command, 'string', `scripts.${scriptName} must exist`);
    assert.match(command, /\bturbo run test\b/, `${scriptName} must run workspace tests`);
    assert.match(
      command,
      /--concurrency=25%(?:\s|$)/,
      `${scriptName} must leave host capacity for child processes`,
    );
    assert.match(
      command,
      /(?:^|\s)--\s[\s\S]*--maxWorkers=2\b/,
      `${scriptName} must cap each package's Vitest worker pool`,
    );
  }
});

test('coverage scripts also bound coverage remapping work', () => {
  for (const scriptName of ['test:coverage', 'test:coverage:fresh']) {
    const command = manifest.scripts[scriptName];
    assert.match(command, /(?:^|\s)--coverage(?:\s|$)/, `${scriptName} must enable coverage`);
    assert.match(
      command,
      /--coverage\.processingConcurrency=2\b/,
      `${scriptName} must cap concurrent coverage remapping`,
    );
  }

  assert.match(
    manifest.scripts['test:coverage:fresh'],
    /(?:^|\s)--force(?:\s|$)/,
    'the main/release coverage lane must bypass Turbo cache',
  );
});
