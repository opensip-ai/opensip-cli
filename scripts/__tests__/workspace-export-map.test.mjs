import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { readWorkspaceExportMap, resolveExportSource } = require('../lib/workspace-export-map.cjs');
const { readWorkspacePackageManifests } = require('../lib/workspace-package-manifests.cjs');

const REPO = join(import.meta.dirname, '../..');

describe('workspace-export-map', () => {
  it('maps root and subpath exports for the real repository', () => {
    const { entries, diagnostics } = readWorkspaceExportMap(REPO);
    assert.equal(diagnostics.length, 0);
    assert.ok(entries.length >= 50);
    const bySpec = new Map(entries.map((e) => [e.specifier, e]));
    assert.ok(bySpec.has('@opensip-cli/core'));
    assert.ok(bySpec.has('@opensip-cli/datastore/internal'));
    assert.ok(bySpec.has('@opensip-cli/graph/read'));
    assert.match(bySpec.get('@opensip-cli/graph/read').relativeSource, /read\/index\.ts$/);
  });

  it('resolveExportSource rejects traversal and non-dist targets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'export-map-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export {}');
      assert.equal(resolveExportSource(dir, './src/index.ts'), undefined);
      assert.equal(resolveExportSource(dir, './dist/../etc/passwd.js'), undefined);
      assert.equal(resolveExportSource(dir, './dist/*.js'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags conditional and wildcard exports as diagnostics in a fixture tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'export-map-root-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      // Minimal workspace shape packages/foo
      const pkgDir = join(root, 'packages', 'foo');
      mkdirSync(join(pkgDir, 'src'), { recursive: true });
      writeFileSync(join(pkgDir, 'src', 'index.ts'), 'export {}');
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@opensip-cli/foo',
          exports: {
            '.': { import: './dist/index.js' },
            './wild/*': './dist/wild/*.js',
          },
        }),
      );
      // The fixture workspace declares packages/* above.
      const { diagnostics } = readWorkspaceExportMap(root);
      assert.ok(diagnostics.some((d) => /conditional|wildcard|unsupported/i.test(d)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('workspace package manifests reject escaping package symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'manifest-out-'));
    try {
      mkdirSync(join(root, 'packages'), { recursive: true });
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: '@opensip-cli/evil' }));
      symlinkSync(outside, join(root, 'packages', 'evil'));
      assert.throws(() => readWorkspacePackageManifests(root), /escapes repository root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
