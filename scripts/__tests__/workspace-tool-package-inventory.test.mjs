import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const {
  readProductionToolPackageInventory,
  createToolPathPredicates,
} = require('../lib/workspace-tool-package-inventory.cjs');
const {
  readWorkspaceGlobs,
  readWorkspacePackageManifests,
} = require('../lib/workspace-package-manifests.cjs');

function writePackage(root, relativeDir, manifest, source = 'export {};\n') {
  const dir = join(root, relativeDir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'src', 'tool.ts'), source);
}

describe('workspace package manifests', () => {
  it('returns unique package names for every workspace package (no frozen count)', () => {
    const packages = readWorkspacePackageManifests(REPO_ROOT);
    assert.ok(packages.length > 0);
    const names = packages.map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
  });

  it('reads package globs from pnpm-workspace.yaml instead of a mirrored list', () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-manifests-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'extensions/*'\n");
      writePackage(root, 'extensions/oddity', {
        name: '@opensip-cli/oddity',
        opensipTools: { kind: 'tool' },
      });

      assert.deepEqual(readWorkspaceGlobs(root), ['extensions/*']);
      assert.deepEqual(
        readWorkspacePackageManifests(root).map((pkg) => pkg.relativeDir),
        ['extensions/oddity'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an escaping pnpm-workspace.yaml symlink before reading it', () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-manifest-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'workspace-manifest-outside-'));
    try {
      writeFileSync(join(outside, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      symlinkSync(join(outside, 'pnpm-workspace.yaml'), join(root, 'pnpm-workspace.yaml'));

      assert.throws(() => readWorkspaceGlobs(root), /pnpm-workspace\.yaml escapes repository root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects an escaping package.json symlink before reading it', () => {
    const root = mkdtempSync(join(tmpdir(), 'package-manifest-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'package-manifest-outside-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      mkdirSync(join(root, 'packages', 'escaped'), { recursive: true });
      writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: '@vendor/escaped' }));
      symlinkSync(join(outside, 'package.json'), join(root, 'packages', 'escaped', 'package.json'));

      assert.throws(
        () => readWorkspacePackageManifests(root),
        /workspace package manifest escapes package root: packages\/escaped\/package\.json/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('production tool package inventory', () => {
  it('includes bundled tools and external tool packages by opensipTools.kind', () => {
    const inv = readProductionToolPackageInventory(REPO_ROOT);
    const names = new Set(inv.map((t) => t.name));
    assert.ok(names.has('@opensip-cli/fitness'));
    assert.ok(names.has('@opensip-cli/graph'));
    assert.ok(names.has('@opensip-cli/mcp'));
    assert.ok(names.has('@opensip-cli/tool-gitleaks'));
    // Non-tool tool-* packages must not appear (tool-test-kit is not a tool).
    assert.ok(!names.has('@opensip-cli/tool-test-kit'));
    // The substrate remains separate because it is intentionally not kind:tool.
    assert.ok(!names.has('@opensip-cli/external-tool-adapter'));
  });

  it('classifies bundled status from the bundled-tools manifest', () => {
    const inv = readProductionToolPackageInventory(REPO_ROOT);
    const fitness = inv.find((t) => t.name === '@opensip-cli/fitness');
    const gitleaks = inv.find((t) => t.name === '@opensip-cli/tool-gitleaks');
    assert.equal(fitness?.bundled, true);
    assert.equal(gitleaks?.bundled, false);
  });

  it('predicates match known engine paths without regex inventory edits', () => {
    const p = createToolPathPredicates(REPO_ROOT);
    assert.ok(p.toolEnginePathRe().test('packages/fitness/engine/src/tool.ts'));
    assert.ok(p.toolEnginePathRe().test('packages/mcp/src/command.ts'));
    assert.ok(p.toolSeamPathRe().test('packages/tool-gitleaks/src/index.ts'));
    assert.ok(p.toolSeamPathRe().test('packages/external-tool-adapter/src/index.ts'));
    assert.equal(p.adapterSubstrate?.name, '@opensip-cli/external-tool-adapter');
    assert.equal(p.isToolSourcePath('packages/core/src/index.ts'), false);
  });

  it('classifies an arbitrarily named Tool without editing a path regex', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-inventory-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writePackage(root, 'packages/oddity-analyzer', {
        name: '@vendor/oddity-analyzer',
        opensipTools: { kind: 'tool' },
      });
      writePackage(root, 'packages/not-a-tool', { name: '@vendor/not-a-tool' });
      writePackage(root, 'packages/external-tool-adapter', {
        name: '@opensip-cli/external-tool-adapter',
      });

      const inventory = readProductionToolPackageInventory(root);
      assert.deepEqual(
        inventory.map((tool) => tool.name),
        ['@vendor/oddity-analyzer'],
      );
      const predicates = createToolPathPredicates(root);
      assert.ok(predicates.toolEnginePathRe().test('packages/oddity-analyzer/src/tool.ts'));
      assert.ok(
        predicates.toolSeamPathRe().test('packages/external-tool-adapter/src/run-adapter.ts'),
      );
      assert.equal(predicates.toolEnginePathRe().test('packages/not-a-tool/src/tool.ts'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('excludes an arbitrarily named kind:fit-pack package from the production Tool inventory', () => {
    const root = mkdtempSync(join(tmpdir(), 'fit-pack-inventory-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      // A fit pack whose directory/name match no current regex: it is a fitness
      // EXTENSION, not a Tool, so it must never enter the Tool inventory or match
      // a Tool source-path predicate — the fit-pack allowlist governs it instead.
      writePackage(root, 'packages/reduce-audit', {
        name: '@vendor/reduce-audit',
        opensipTools: { kind: 'fit-pack' },
      });
      writePackage(root, 'packages/oddity-analyzer', {
        name: '@vendor/oddity-analyzer',
        opensipTools: { kind: 'tool' },
      });

      const inventory = readProductionToolPackageInventory(root);
      assert.deepEqual(
        inventory.map((tool) => tool.name),
        ['@vendor/oddity-analyzer'],
        'only the kind:tool package is a production Tool',
      );
      const predicates = createToolPathPredicates(root);
      assert.equal(
        predicates.toolEnginePathRe().test('packages/reduce-audit/src/tool.ts'),
        false,
        'a fit-pack path must not classify as a Tool engine path',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a Tool source directory symlink that escapes its package', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-source-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'tool-source-outside-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const packageDir = join(root, 'packages', 'escaped-source');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@vendor/escaped-source',
          opensipTools: { kind: 'tool' },
        }),
      );
      writeFileSync(join(outside, 'tool.ts'), 'export {};\n');
      symlinkSync(outside, join(packageDir, 'src'));

      assert.throws(
        () => readProductionToolPackageInventory(root),
        /tool package @vendor\/escaped-source source directory escapes package root/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a Tool descriptor symlink that escapes its source directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tool-descriptor-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'tool-descriptor-outside-'));
    try {
      writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      const packageDir = join(root, 'packages', 'escaped-descriptor');
      mkdirSync(join(packageDir, 'src'), { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify({
          name: '@vendor/escaped-descriptor',
          opensipTools: { kind: 'tool' },
        }),
      );
      writeFileSync(join(outside, 'tool.ts'), 'export {};\n');
      symlinkSync(join(outside, 'tool.ts'), join(packageDir, 'src', 'tool.ts'));

      assert.throws(
        () => readProductionToolPackageInventory(root),
        /tool package @vendor\/escaped-descriptor descriptor escapes source root/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
