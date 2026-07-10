import assert from 'node:assert/strict';
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
  readWorkspacePackageManifests,
} = require('../lib/workspace-package-manifests.cjs');

describe('workspace package manifests', () => {
  it('returns unique package names and 58 workspace packages', () => {
    const packages = readWorkspacePackageManifests(REPO_ROOT);
    assert.equal(packages.length, 58);
    const names = packages.map((p) => p.name);
    assert.equal(new Set(names).size, names.length);
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
    // Substrate is inventoried separately when present as kind:tool; external-tool-adapter is not kind:tool.
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
    assert.equal(p.isToolSourcePath('packages/core/src/index.ts'), false);
  });
});
