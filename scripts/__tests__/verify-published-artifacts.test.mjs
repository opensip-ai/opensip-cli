import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  classifyPublishedArtifactPath,
  collectPublishedArtifactProblems,
} from '../lib/release-governance-surface.mjs';
import {
  forbiddenPackHooks,
  parsePacklist,
  scanBuiltTree,
  verifyPackage,
} from '../verify-published-artifacts.mjs';

test('classifyPublishedArtifactPath rejects test/fixture/coverage paths', () => {
  const forbidden = {
    'dist/__tests__/x.test.js': 'test-directory',
    'dist/__fixtures__/corpus/a.ts': 'fixture-directory',
    'dist/foo.test.js': 'test-file',
    'dist/foo.test.d.ts': 'test-file',
    'dist/foo.test.js.map': 'test-file',
    'dist/foo.spec.ts': 'test-file',
    'coverage/lcov.info': 'coverage',
    'dist\\__tests__\\x.js': 'test-directory', // Windows separators
    '/abs/path.js': 'absolute-path',
    'C:/x.js': 'absolute-path',
    'dist/../escape.js': 'path-traversal',
    'has\0nul.js': 'nul-in-path',
  };
  for (const [path, reason] of Object.entries(forbidden)) {
    assert.equal(classifyPublishedArtifactPath(path), reason, `${path} -> ${reason}`);
  }
});

test('classifyPublishedArtifactPath allows runtime artifacts (incl test-like names)', () => {
  for (const ok of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/index.js.map',
    'dist/contest.js', // contains "test" but not ".test."
    'dist/latest.js',
    'dist/manifest.js',
    'package.json',
    'README.md',
    'dist/framework/define-check.js',
  ]) {
    assert.equal(classifyPublishedArtifactPath(ok), null, `${ok} should be allowed`);
  }
});

test('collectPublishedArtifactProblems reports only forbidden entries with package + reason', () => {
  const problems = collectPublishedArtifactProblems(
    '@opensip-cli/demo',
    ['dist/index.js', 'dist/__tests__/a.test.js', 'dist/b.spec.js'],
    'packlist',
  );
  assert.equal(problems.length, 2);
  assert.match(problems[0], /@opensip-cli\/demo: forbidden packlist artifact \(test-directory\)/);
  assert.match(problems[1], /test-file/);
});

test('forbiddenPackHooks detects prepack/prepare/postpack only', () => {
  assert.deepEqual(forbiddenPackHooks({ scripts: { build: 'tsc', prepack: 'x' } }), ['prepack']);
  assert.deepEqual(forbiddenPackHooks({ scripts: { prepare: 'a', postpack: 'b', build: 'tsc' } }), [
    'prepare',
    'postpack',
  ]);
  assert.deepEqual(forbiddenPackHooks({ scripts: { build: 'tsc', test: 'vitest' } }), []);
  assert.deepEqual(forbiddenPackHooks({}), []);
});

test('parsePacklist parses files[].path and rejects malformed input', () => {
  assert.deepEqual(parsePacklist('{"files":[{"path":"dist/index.js"},{"path":"package.json"}]}'), [
    'dist/index.js',
    'package.json',
  ]);
  assert.throws(() => parsePacklist('not json'), /malformed pack JSON/);
  assert.throws(() => parsePacklist('{"name":"x"}'), /missing files\[\]/);
  assert.throws(() => parsePacklist('{"files":[{"nope":1}]}'), /missing path/);
});

test('verifyPackage: clean dist + clean packlist has no problems', () => {
  const root = mkdtempSync(join(tmpdir(), 'vpa-clean-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pkgDir = join(root, 'packages', 'demo');
  mkdirSync(join(pkgDir, 'dist', 'framework'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@x/demo', scripts: { build: 'tsc' } }),
  );
  writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {};');
  writeFileSync(join(pkgDir, 'dist', 'framework', 'contest.js'), 'export {};');

  const runner = () => ({
    status: 0,
    stdout: '{"files":[{"path":"dist/index.js"},{"path":"package.json"}]}',
  });
  const { problems, builtCount, packedCount } = verifyPackage(
    { name: '@x/demo', dir: 'packages/demo', filter: '@x/demo' },
    { runner, repoRoot: root },
  );
  assert.deepEqual(problems, []);
  assert.equal(builtCount, 2);
  assert.equal(packedCount, 2);
});

test('verifyPackage: flags a forbidden dist artifact and a forbidden packlist entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'vpa-dirty-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pkgDir = join(root, 'packages', 'demo');
  mkdirSync(join(pkgDir, 'dist', '__tests__'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@x/demo', scripts: { build: 'tsc' } }),
  );
  writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {};');
  writeFileSync(join(pkgDir, 'dist', '__tests__', 'a.test.js'), 'export {};');

  const runner = () => ({
    status: 0,
    stdout: '{"files":[{"path":"dist/index.js"},{"path":"dist/b.spec.js"}]}',
  });
  const { problems } = verifyPackage(
    { name: '@x/demo', dir: 'packages/demo', filter: '@x/demo' },
    { runner, repoRoot: root },
  );
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => /forbidden dist artifact \(test-directory\)/.test(p)));
  assert.ok(problems.some((p) => /forbidden packlist artifact \(test-file\)/.test(p)));
});

test('verifyPackage: rejects a pack lifecycle hook WITHOUT spawning pnpm', () => {
  const root = mkdtempSync(join(tmpdir(), 'vpa-hook-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pkgDir = join(root, 'packages', 'demo');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@x/demo', scripts: { build: 'tsc', prepack: 'rm -rf /' } }),
  );
  writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {};');

  let spawned = false;
  const runner = () => {
    spawned = true;
    return { status: 0, stdout: '{"files":[]}' };
  };
  const { problems } = verifyPackage(
    { name: '@x/demo', dir: 'packages/demo', filter: '@x/demo' },
    { runner, repoRoot: root },
  );
  assert.equal(spawned, false, 'must not spawn pnpm on a hooked manifest');
  assert.ok(problems.some((p) => /forbidden pack hook\(s\): prepack/.test(p)));
});

test('verifyPackage: missing package.json is a hard failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'vpa-nomanifest-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pkgDir = join(root, 'packages', 'demo');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {};');

  const { problems } = verifyPackage(
    { name: '@x/demo', dir: 'packages/demo', filter: '@x/demo' },
    { runner: () => ({ status: 0, stdout: '{"files":[]}' }), repoRoot: root },
  );
  assert.ok(problems.some((p) => /package\.json missing/.test(p)));
});

test('verifyPackage: diagnostics report the path but never echo file contents (no secret leak)', () => {
  const secret = 'S3CR3T-SENTINEL-do-not-echo';
  const root = mkdtempSync(join(tmpdir(), 'vpa-secret-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pkgDir = join(root, 'packages', 'demo');
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@x/demo', scripts: { build: 'tsc' } }),
  );
  // A forbidden dist artifact whose CONTENTS embed a secret. The scanner records
  // only the path, so the secret must never surface in a diagnostic.
  writeFileSync(join(pkgDir, 'dist', 'leaky.test.js'), `export const token = '${secret}';`);

  const runner = () => ({
    status: 0,
    stdout: `{"files":[{"path":"dist/index.js"},{"path":"dist/creds.spec.js"}]}`,
  });
  const { problems } = verifyPackage(
    { name: '@x/demo', dir: 'packages/demo', filter: '@x/demo' },
    { runner, repoRoot: root },
  );
  assert.ok(
    problems.some((p) => /forbidden dist artifact \(test-file\).*leaky\.test\.js/.test(p)),
    'reports the offending path',
  );
  assert.ok(!problems.some((p) => p.includes(secret)), 'must not echo the forbidden file contents');
});

test('verifyPackage: missing dist is a hard failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'vpa-nodist-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  const pkgDir = join(root, 'packages', 'demo');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@x/demo', scripts: {} }));

  const { problems } = verifyPackage(
    { name: '@x/demo', dir: 'packages/demo', filter: '@x/demo' },
    { runner: () => ({ status: 0, stdout: '{"files":[]}' }), repoRoot: root },
  );
  assert.ok(problems.some((p) => /dist\/ is absent/.test(p)));
});

test('scanBuiltTree returns package-relative POSIX paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'vpa-scan-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist', 'nested'), { recursive: true });
  writeFileSync(join(root, 'dist', 'index.js'), '');
  writeFileSync(join(root, 'dist', 'nested', 'a.js'), '');
  // Production verifyPackage passes a realpath'd root; mirror that (macOS tmp is a symlink).
  const realRoot = realpathSync(root);
  const files = scanBuiltTree(realRoot, join(realRoot, 'dist')).sort();
  assert.deepEqual(files, ['dist/index.js', 'dist/nested/a.js']);
});
