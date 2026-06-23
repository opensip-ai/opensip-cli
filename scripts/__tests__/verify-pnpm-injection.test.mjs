import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectInjectedPackages,
  collectSourcePackages,
  compareDistFileSets,
  entryFor,
  exportPathsBeyondDot,
  formatContentFailures,
  listDistFiles,
  opensipToolsEqual,
  resolveExportTarget,
  verifyConfigFromText,
  verifyInjectedContent,
  verifyPackageFreshness,
} from '../verify-pnpm-injection.mjs';

test('verifyConfigFromText accepts injectWorkspacePackages: true', () => {
  const result = verifyConfigFromText('packages:\n  - packages/*\ninjectWorkspacePackages: true\n');
  assert.equal(result.ok, true);
});

test('verifyConfigFromText rejects missing injectWorkspacePackages', () => {
  const result = verifyConfigFromText('packages:\n  - packages/*\n');
  assert.equal(result.ok, false);
});

test('entryFor resolves conditional and main fallbacks', () => {
  assert.equal(
    entryFor({
      exports: {
        '.': { import: './dist/index.js', types: './dist/index.d.ts' },
      },
    }),
    './dist/index.js',
  );
  assert.equal(entryFor({ main: './lib/index.js' }), './lib/index.js');
  assert.equal(entryFor({}), null);
});

test('resolveExportTarget prefers import over require', () => {
  assert.equal(
    resolveExportTarget({ import: './dist/a.js', require: './dist/a.cjs' }),
    './dist/a.js',
  );
});

test('exportPathsBeyondDot skips dot and wildcard patterns', () => {
  const paths = exportPathsBeyondDot({
    exports: {
      '.': './dist/index.js',
      './errors': './dist/lib/errors.js',
      './*': './*.js',
    },
  });
  assert.deepEqual(paths, [{ subpath: './errors', file: './dist/lib/errors.js' }]);
});

test('compareDistFileSets reports missing and extra files', () => {
  const source = new Set(['index.js', 'tools/identity.js']);
  const injected = new Set(['index.js', 'legacy.js']);
  assert.deepEqual(compareDistFileSets(source, injected), {
    missing: ['tools/identity.js'],
    extra: ['legacy.js'],
  });
});

test('listDistFiles walks nested directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-pnpm-injection-'));
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'index.js'), '');
  writeFileSync(join(root, 'tools', 'identity.js'), '');

  assert.deepEqual([...listDistFiles(root)].sort(), ['index.js', 'tools/identity.js']);
});

test('opensipToolsEqual compares manifest blocks regardless of key order', () => {
  assert.equal(
    opensipToolsEqual({ kind: 'tool', id: 'fitness' }, { id: 'fitness', kind: 'tool' }),
    true,
  );
  assert.equal(opensipToolsEqual({ kind: 'tool' }, { kind: 'fit-pack' }), false);
  assert.equal(opensipToolsEqual({ kind: 'tool' }), false);
});

test('verifyPackageFreshness detects entry, export, dist, and opensipTools drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-pnpm-injection-'));
  const sourceDir = join(root, 'source');
  const injectedDir = join(root, 'injected');
  mkdirSync(join(sourceDir, 'dist', 'tools'), { recursive: true });
  mkdirSync(join(injectedDir, 'dist'), { recursive: true });
  writeFileSync(join(sourceDir, 'dist', 'index.js'), '');
  writeFileSync(join(sourceDir, 'dist', 'tools', 'identity.js'), '');
  writeFileSync(join(injectedDir, 'dist', 'index.js'), '');

  const source = {
    sourceDir,
    pkg: {
      name: '@opensip-cli/core',
      exports: {
        '.': './dist/index.js',
        './tools/identity': './dist/tools/identity.js',
      },
      opensipTools: { kind: 'internal' },
    },
  };
  const injected = {
    copyDir: injectedDir,
    pkg: {
      name: '@opensip-cli/core',
      exports: source.pkg.exports,
      opensipTools: { kind: 'stale' },
    },
  };

  const issues = verifyPackageFreshness(source, injected);
  const kinds = issues.map((issue) => issue.kind).sort();
  assert.deepEqual(kinds, ['dist-missing', 'export', 'opensipTools']);
});

test('verifyInjectedContent dedupes injected copies and maps back to source', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-pnpm-injection-'));
  const packagesDir = join(root, 'packages', 'demo');
  const pnpmDir = join(root, 'node_modules', '.pnpm');
  const injectedDir = join(
    pnpmDir,
    '@opensip-cli+demo@file+packages+demo',
    'node_modules',
    '@opensip-cli',
    'demo',
  );

  mkdirSync(join(packagesDir, 'dist'), { recursive: true });
  writeFileSync(join(packagesDir, 'dist', 'index.js'), '');
  writeFileSync(
    join(packagesDir, 'package.json'),
    JSON.stringify({
      name: '@opensip-cli/demo',
      exports: { '.': './dist/index.js' },
    }),
  );

  mkdirSync(injectedDir, { recursive: true });
  writeFileSync(
    join(injectedDir, 'package.json'),
    JSON.stringify({
      name: '@opensip-cli/demo',
      exports: { '.': './dist/index.js' },
    }),
  );

  const { checked, issuesByPkg } = verifyInjectedContent({
    repoRoot: root,
    pnpmDir,
    packagesDir: join(root, 'packages'),
  });

  assert.equal(checked, 1);
  assert.equal(issuesByPkg.size, 1);
  assert.ok(issuesByPkg.get('@opensip-cli/demo').some((issue) => issue.kind === 'entry'));
});

test('collectSourcePackages and collectInjectedPackages index by package name', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-pnpm-injection-'));
  const packagesDir = join(root, 'packages', 'demo');
  const injectedDir = join(
    root,
    'node_modules',
    '.pnpm',
    '@opensip-cli+demo@file+packages+demo',
    'node_modules',
    '@opensip-cli',
    'demo',
  );

  mkdirSync(packagesDir, { recursive: true });
  writeFileSync(join(packagesDir, 'package.json'), JSON.stringify({ name: '@opensip-cli/demo' }));
  mkdirSync(injectedDir, { recursive: true });
  writeFileSync(join(injectedDir, 'package.json'), JSON.stringify({ name: '@opensip-cli/demo' }));

  const source = collectSourcePackages(join(root, 'packages'));
  const injected = collectInjectedPackages(join(root, 'node_modules', '.pnpm'));
  assert.equal(source.get('@opensip-cli/demo')?.sourceDir, packagesDir);
  assert.equal(injected.get('@opensip-cli/demo')?.copyDir, injectedDir);
});

test('formatContentFailures includes remedy steps', () => {
  const lines = formatContentFailures(
    new Map([
      [
        '@opensip-cli/core',
        [
          {
            kind: 'export',
            subpath: './tools/identity',
            file: './dist/tools/identity.js',
          },
        ],
      ],
    ]),
  );
  assert.match(lines.join('\n'), /missing export \.\/tools\/identity/);
  assert.match(lines.join('\n'), /pnpm build/);
  assert.match(lines.join('\n'), /pnpm-workspace-state-v1\.json/);
});
