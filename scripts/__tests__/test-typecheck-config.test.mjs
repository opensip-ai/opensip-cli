import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const GENERATOR = join(REPO_ROOT, 'scripts', 'build-test-tsconfigs.mjs');

function readConfig(relativeDir) {
  const p = join(REPO_ROOT, relativeDir, 'tsconfig.test.json');
  assert.ok(existsSync(p), `expected generated config at ${relativeDir}/tsconfig.test.json`);
  // JSONC: strip the leading "//" banner key form by parsing after removing it.
  const raw = readFileSync(p, 'utf8');
  return { raw, json: JSON.parse(raw) };
}

test('generated per-package test configs are in sync (--check passes)', () => {
  // Throws (non-zero exit) if any config is missing or stale.
  execFileSync('node', [GENERATOR, '--check'], { cwd: REPO_ROOT, stdio: 'pipe' });
});

test('a representative config extends the package tsconfig, re-includes tests, no-emit', () => {
  const { json } = readConfig('packages/core');
  assert.equal(json.extends, './tsconfig.json');
  assert.equal(json.compilerOptions.noEmit, true);
  assert.equal(json.compilerOptions.rootDir, 'src');
  assert.ok(
    json.include.includes('src/**/*.test.ts') && json.include.includes('src/**/__tests__/**/*.ts'),
    'must re-include test sources the production build excludes',
  );
  assert.ok(
    json.exclude.includes('**/__fixtures__/**') &&
      json.exclude.includes('**/__tests__/fixtures/**'),
    'must exclude synthetic fixture corpora',
  );
});

test('browser-environment suites get DOM libs their production build omits', () => {
  for (const pkg of ['packages/cli-ui', 'packages/dashboard']) {
    const { json } = readConfig(pkg);
    assert.deepEqual(
      json.compilerOptions.lib,
      ['ES2022', 'DOM', 'DOM.Iterable'],
      `${pkg} test config must enable DOM libs`,
    );
  }
});

test('--check fails on drift and recovers after regeneration', () => {
  const target = join(REPO_ROOT, 'packages', 'core', 'tsconfig.test.json');
  const original = readFileSync(target, 'utf8');
  after(() => writeFileSync(target, original));

  writeFileSync(target, JSON.stringify({ extends: './tsconfig.json' }, null, 2) + '\n');
  assert.throws(
    () => execFileSync('node', [GENERATOR, '--check'], { cwd: REPO_ROOT, stdio: 'pipe' }),
    'a drifted config must fail --check',
  );

  execFileSync('node', [GENERATOR], { cwd: REPO_ROOT, stdio: 'pipe' });
  execFileSync('node', [GENERATOR, '--check'], { cwd: REPO_ROOT, stdio: 'pipe' });
  assert.equal(readFileSync(target, 'utf8'), original, 'regeneration must restore the config');
});
