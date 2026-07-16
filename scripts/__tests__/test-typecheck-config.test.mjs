import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const GENERATOR = join(REPO_ROOT, 'scripts', 'build-test-tsconfigs.mjs');
const ROOT_TSCONFIG = join(REPO_ROOT, 'tsconfig.json');
const TSC = join(REPO_ROOT, 'node_modules', '.bin', 'tsc');

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
  for (const glob of [
    'src/**/*.test.ts',
    'src/**/*.test.tsx',
    'src/**/*.spec.ts',
    'src/**/*.spec.tsx',
    'src/**/__tests__/**/*.ts',
    'src/**/__tests__/**/*.tsx',
  ]) {
    assert.ok(json.include.includes(glob), `must re-include ${glob} the production build excludes`);
  }
  assert.ok(
    json.exclude.includes('**/__fixtures__/**') &&
      json.exclude.includes('**/__tests__/fixtures/**'),
    'must exclude synthetic fixture corpora',
  );
});

test('the resolved test project keeps strict + noEmit and admits only test sources', () => {
  // --showConfig resolves `extends` + include/exclude globs into a concrete
  // program, so this audits the EFFECTIVE contract, not just the on-disk JSON.
  const showConfig = execFileSync(
    TSC,
    ['-p', join(REPO_ROOT, 'packages', 'core', 'tsconfig.test.json'), '--showConfig'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const resolved = JSON.parse(showConfig);
  assert.equal(resolved.compilerOptions.strict, true, 'test project must stay strict');
  assert.equal(resolved.compilerOptions.noEmit, true, 'test project must not emit');
  const files = resolved.files ?? [];
  assert.ok(files.length > 0, 'the include globs must resolve to concrete test files');
  assert.ok(
    files.some((f) => /\.test\.ts$/.test(f)),
    'a representative .test.ts source is compiled',
  );
  assert.ok(
    files.some((f) => /__tests__\//.test(f)),
    'ordinary __tests__ helpers are compiled',
  );
  assert.ok(!files.some((f) => /__fixtures__\//.test(f)), 'synthetic fixture corpora are excluded');
  assert.ok(!files.some((f) => /\/dist\//.test(f)), 'emitted output is excluded');
});

test('the test-typecheck lane catches a semantic type error (the lane is live, not a no-op)', () => {
  // Contained under the OS tmp dir — NOT `packages/*` — so a workspace-manifest
  // reader in a sibling test file cannot observe a transient probe package.
  // `types: []` frees the isolated project from resolving the repo's @types/node.
  const probeRoot = mkdtempSync(join(tmpdir(), 'tsc-test-liveness-'));
  after(() => rmSync(probeRoot, { recursive: true, force: true }));

  writeFileSync(
    join(probeRoot, 'tsconfig.test.json'),
    JSON.stringify(
      {
        extends: ROOT_TSCONFIG, // inherit the REAL strict compiler settings
        compilerOptions: { noEmit: true, rootDir: 'src', types: [] },
        include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
        exclude: ['node_modules', 'dist', '**/__fixtures__/**'],
      },
      null,
      2,
    ),
  );
  mkdirSync(join(probeRoot, 'src', '__tests__'), { recursive: true });
  const testFile = join(probeRoot, 'src', '__tests__', 'probe.test.ts');
  const config = join(probeRoot, 'tsconfig.test.json');
  const runTsc = () =>
    execFileSync(TSC, ['-p', config, '--noEmit', '--pretty', 'false'], {
      cwd: probeRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });

  // 1) A deliberate assignability error must be surfaced.
  writeFileSync(testFile, 'const n: number = "not a number";\nexport { n };\n');
  let failure;
  try {
    runTsc();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, 'a test file with a type error must fail the test typecheck');
  const out = String(failure.stdout ?? '') + String(failure.stderr ?? '');
  assert.match(out, /error TS2322/, 'reports the specific assignability error');

  // 2) The same lane must pass once the error is fixed — proving it is a real
  //    semantic check, not a config that fails (or passes) unconditionally.
  writeFileSync(testFile, 'const n: number = 42;\nexport { n };\n');
  assert.doesNotThrow(runTsc, 'a well-typed test file must pass the test typecheck');
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
