import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readPackageManifestFacts } from './manifest-facts.js';
import { MAX_WORKSPACE_AUTHORED_PATTERNS } from './workspace-patterns.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-codebase-manifest-'));
  roots.push(root);
  return root;
}

function packageAt(root: string, relativeRoot: string, value: unknown): string {
  const packageRoot = relativeRoot === '.' ? root : join(root, relativeRoot);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify(value));
  return packageRoot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('readPackageManifestFacts', () => {
  it('qualifies authored workspace truncation even when every omitted entry is a duplicate', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: 'root',
      workspaces: Array.from({ length: MAX_WORKSPACE_AUTHORED_PATTERNS + 1 }, () => 'packages/*'),
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.workspacePatterns).toEqual(['packages/*']);
    expect(result.facts.reasonCodes).toContain('manifest-workspace-cap-reached');
    expect(result.facts.reasonCodes).not.toContain('workspace-pattern-invalid');
  });

  it('projects bounded package, workspace, export, bin, and safe script facts', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: '@example/root',
      private: true,
      packageManager: 'pnpm@11.10.0',
      workspaces: ['packages/z', 'packages/a', 'packages/a'],
      exports: {
        './z': './dist/z.js',
        '.': './dist/index.js',
        './a': './dist/a.js',
      },
      bin: { zed: './z.js', alpha: './a.js' },
      scripts: {
        test: 'pnpm vitest run',
        'test:unit': 'vitest run src',
        release: 'npm publish',
        lint: 'eslint . && echo unsafe',
        codegen: 'node tools/codegen.js --token=secret',
      },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts).toMatchObject({
      name: '@example/root',
      root: '.',
      private: true,
      packageManager: 'pnpm@11.10.0',
      exports: ['.', './a', './z'],
      exportMapKeys: ['.', './a', './z'],
      bins: ['alpha', 'zed'],
      workspacePatterns: ['packages/a', 'packages/z'],
      reasonCodes: ['manifest-script-unsafe'],
    });
    expect(result.facts.verificationCommands).toEqual([
      {
        tier: 'focused',
        cwd: '.',
        argv: ['vitest', 'run', 'src'],
        basis: 'manifest-script:test:unit',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('echo unsafe');
    expect(JSON.stringify(result)).not.toContain('--token=secret');
    expect(Object.isFrozen(result.facts)).toBe(true);
    expect(Object.isFrozen(result.facts.verificationCommands)).toBe(true);
  });

  it('retains direct safe argv without exposing package-manager lifecycle hooks', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: '@example/root',
      packageManager: 'pnpm@11.10.0',
      scripts: {
        pretest: 'rm -rf important',
        test: 'vitest run',
        posttest: 'curl https://attacker.invalid',
      },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.verificationCommands).toEqual([
      {
        tier: 'full',
        cwd: '.',
        argv: ['vitest', 'run'],
        basis: 'manifest-script:test',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('important');
    expect(JSON.stringify(result)).not.toContain('attacker.invalid');

    const deduplicatedProject = tempRoot();
    const deduplicatedRoot = packageAt(deduplicatedProject, '.', {
      name: '@example/deduplicated',
      packageManager: 'pnpm@11.10.0',
      scripts: { test: 'pnpm test' },
    });
    const deduplicated = readPackageManifestFacts({
      packageRoot: deduplicatedRoot,
      projectRoot: deduplicatedProject,
    });
    expect(deduplicated.ok).toBe(true);
    if (!deduplicated.ok) return;
    expect(deduplicated.facts.verificationCommands).toEqual([]);
    expect(deduplicated.facts.reasonCodes).toContain('manifest-script-unsafe');
  });

  it('represents a string exports target without inventing an object export map', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, 'packages/leaf', {
      name: 'leaf',
      exports: './index.js',
      bin: './cli.js',
      workspaces: { packages: ['children/*'] },
      scripts: { build: 'tsc', 'test:focused': 'vitest run focused.test.ts' },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.root).toBe('packages/leaf');
    expect(result.facts.exports).toEqual(['.']);
    expect(result.facts.exportMapKeys).toBeUndefined();
    expect(result.facts.bins).toEqual(['leaf']);
    expect(result.facts.workspacePatterns).toEqual(['children/*']);
    expect(result.facts.verificationCommands.map((command) => command.tier)).toEqual([
      'package',
      'focused',
    ]);
  });

  it('projects a conditional root exports object as the package root', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: 'conditional-root',
      exports: { import: './index.mjs', require: './index.cjs' },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.exports).toEqual(['.']);
    expect(result.facts.exportMapKeys).toBeUndefined();
    expect(result.facts.reasonCodes).toEqual([]);
  });

  it('caps scripts and reports the cap without retaining omitted script text', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: 'root',
      scripts: { test: 'vitest', build: 'tsc', lint: 'eslint .' },
    });

    const result = readPackageManifestFacts({
      packageRoot,
      projectRoot: root,
      maxScripts: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.verificationCommands).toHaveLength(1);
    expect(result.facts.verificationCommands[0]?.basis).toBe('manifest-script:build');
    expect(result.facts.reasonCodes).toContain('manifest-script-cap-reached');
  });

  it('rejects destructive or arbitrary executables even when the script name is allowlisted', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: 'root',
      scripts: {
        test: 'rm -rf .',
        build: 'node tools/build.js',
        lint: 'eslint .',
      },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.verificationCommands).toEqual([
      {
        tier: 'full',
        cwd: '.',
        argv: ['eslint', '.'],
        basis: 'manifest-script:lint',
      },
    ]);
    expect(result.facts.reasonCodes).toContain('manifest-script-unsafe');
    expect(JSON.stringify(result)).not.toContain('rm');
    expect(JSON.stringify(result)).not.toContain('tools/build.js');
  });

  it('rejects package-manager hops and paths that can escape the project', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: 'root',
      scripts: {
        test: 'pnpm lint',
        lint: 'npm run build',
        build: 'vitest --config=../../outside.ts',
        typecheck: 'tsc --project /tmp/external.json',
      },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.verificationCommands).toEqual([]);
    expect(result.facts.reasonCodes).toContain('manifest-script-unsafe');
    expect(JSON.stringify(result)).not.toContain('outside.ts');
    expect(JSON.stringify(result)).not.toContain('external.json');
  });

  it('rejects mutating, watch, interactive, coverage, and update flags', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: 'root',
      scripts: {
        test: 'vitest --watch',
        'test:update': 'jest -u',
        lint: 'eslint --fix .',
        build: 'tsc -w',
        typecheck: 'vitest run --coverage',
        codegen: 'ruff --fix .',
      },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.verificationCommands).toEqual([]);
    expect(result.facts.reasonCodes).toContain('manifest-script-unsafe');
  });

  it('caps every repeated manifest field and rejects unsafe argv tokens', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: '@scope',
      exports: Object.fromEntries(
        Array.from({ length: 300 }, (_, index) => [`./entry-${String(index)}`, true]),
      ),
      bin: Object.fromEntries(
        Array.from({ length: 140 }, (_, index) => [`bin-${String(index)}`, './cli.js']),
      ),
      workspaces: Array.from({ length: 140 }, (_, index) => `packages/${String(index)}`),
      scripts: {
        test: 'echo "quoted"',
        build: Array.from({ length: 40 }, () => 'word').join(' '),
        [`test:${'x'.repeat(200)}`]: 'vitest run',
        lint: `eslint ${'x'.repeat(257)}`,
      },
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts.exports).toHaveLength(256);
    expect(result.facts.exportMapKeys).toHaveLength(300);
    expect(result.facts.bins).toHaveLength(128);
    expect(result.facts.workspacePatterns).toHaveLength(128);
    expect(result.facts.verificationCommands).toEqual([]);
    expect(result.facts.reasonCodes).toEqual([
      'manifest-bin-cap-reached',
      'manifest-export-cap-reached',
      'manifest-script-invalid',
      'manifest-script-unsafe',
      'manifest-workspace-cap-reached',
    ]);
  });

  it('omits malformed optional projections instead of coercing them', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, '.', {
      name: '@scope',
      exports: 42,
      bin: true,
      workspaces: 'packages/*',
      scripts: ['test'],
    });

    const result = readPackageManifestFacts({ packageRoot, projectRoot: root });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts).toMatchObject({
      exports: [],
      bins: [],
      workspacePatterns: [],
      verificationCommands: [],
    });
  });

  it('rejects an unsafe serialized package-root path at the manifest boundary', () => {
    const root = tempRoot();
    const packageRoot = packageAt(root, 'bad\nroot', { name: 'unsafe-root' });

    expect(readPackageManifestFacts({ packageRoot, projectRoot: root })).toEqual({
      ok: false,
      reason: 'path-invalid',
    });
  });

  it('fails closed with fixed reasons for invalid, missing, oversized, and cancelled reads', () => {
    const root = tempRoot();
    const missing = join(root, 'missing');
    mkdirSync(missing);
    expect(readPackageManifestFacts({ packageRoot: '', projectRoot: root })).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(readPackageManifestFacts({ packageRoot: missing, projectRoot: root })).toEqual({
      ok: false,
      reason: 'read-failed',
    });

    const malformed = join(root, 'malformed');
    mkdirSync(malformed);
    writeFileSync(join(malformed, 'package.json'), '{nope');
    expect(readPackageManifestFacts({ packageRoot: malformed, projectRoot: root })).toEqual({
      ok: false,
      reason: 'parse-failed',
    });

    const invalid = packageAt(root, 'invalid', { name: '' });
    expect(readPackageManifestFacts({ packageRoot: invalid, projectRoot: root })).toEqual({
      ok: false,
      reason: 'invalid-shape',
    });

    const arrayShape = join(root, 'array-shape');
    mkdirSync(arrayShape);
    writeFileSync(join(arrayShape, 'package.json'), '[]');
    expect(readPackageManifestFacts({ packageRoot: arrayShape, projectRoot: root })).toEqual({
      ok: false,
      reason: 'invalid-shape',
    });

    expect(
      readPackageManifestFacts({
        packageRoot: root,
        projectRoot: join(root, 'absent-root'),
      }),
    ).toEqual({ ok: false, reason: 'read-failed' });

    const large = packageAt(root, 'large', {
      name: 'large',
      pad: 'x'.repeat(100),
    });
    expect(
      readPackageManifestFacts({
        packageRoot: large,
        projectRoot: root,
        maxBytes: 16,
      }),
    ).toEqual({ ok: false, reason: 'too-large' });

    const controller = new AbortController();
    controller.abort();
    expect(
      readPackageManifestFacts({
        packageRoot: root,
        projectRoot: root,
        signal: controller.signal,
      }),
    ).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('rejects a package-root symlink that resolves outside the project', () => {
    const root = tempRoot();
    const outside = tempRoot();
    packageAt(outside, '.', { name: 'outside' });
    const link = join(root, 'linked-package');
    symlinkSync(outside, link, 'dir');

    expect(readPackageManifestFacts({ packageRoot: link, projectRoot: root })).toEqual({
      ok: false,
      reason: 'outside-root',
    });
  });

  it('rejects a package.json symlink that resolves outside the project', () => {
    const root = tempRoot();
    const outside = tempRoot();
    const packageRoot = join(root, 'linked-manifest');
    mkdirSync(packageRoot);
    packageAt(outside, '.', { name: 'outside' });
    symlinkSync(join(outside, 'package.json'), join(packageRoot, 'package.json'));

    expect(readPackageManifestFacts({ packageRoot, projectRoot: root })).toEqual({
      ok: false,
      reason: 'outside-root',
    });
  });
});
