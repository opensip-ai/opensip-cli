import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildAllowedSpecifiers, findUndeclaredImports, verifyWorkspaceImportSurfaces } =
  await import('../verify-workspace-import-surfaces.mjs');

const REPO = new URL('../..', import.meta.url).pathname;

describe('workspace-import-surfaces', () => {
  it('allows declared roots and internal surfaces', () => {
    const allowed = buildAllowedSpecifiers(REPO);
    assert.ok(allowed.has('@opensip-cli/core'));
    assert.ok(allowed.has('@opensip-cli/graph/read'));
    assert.ok(allowed.has('@opensip-cli/fitness/internal'));
  });

  it('flags undeclared subpaths in AST imports', () => {
    const allowed = new Set(['@opensip-cli/fitness']);
    const source = `
import { x } from '@opensip-cli/fitness/cli/execute-fit.js';
import type { Y } from '@opensip-cli/fitness';
const z = await import('@opensip-cli/fitness/framework/foo.js');
// import { fake } from '@opensip-cli/fitness/cli/hidden.js';
const msg = "import { x } from '@opensip-cli/fitness/cli/string.js'";
export { a } from '@opensip-cli/fitness/undeclared.js';
`;
    const hits = findUndeclaredImports('packages/x/src/a.ts', source, allowed);
    assert.ok(hits.some((h) => h.includes('fitness/cli/execute-fit')));
    assert.ok(hits.some((h) => h.includes('fitness/framework/foo')));
    assert.ok(hits.some((h) => h.includes('fitness/undeclared')));
    assert.ok(!hits.some((h) => h.includes('string.js')));
    assert.ok(!hits.some((h) => h.includes('hidden.js')));
  });

  it('repository scan reports zero undeclared imports', () => {
    const hits = verifyWorkspaceImportSurfaces(REPO);
    assert.deepEqual(hits, []);
  });
});
