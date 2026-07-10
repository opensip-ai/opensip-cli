import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('../lib/workspace-package-manifests.cjs');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Dynamic import of ESM build-arch-map helpers
const arch = await import('../build-arch-map.mjs');

describe('build-arch-map seam extraction', () => {
  it('extracts only direct ToolCliContext members including optional fields', () => {
    const source = `
export interface ToolCliContext {
  readonly scope: unknown;
  readonly getExitCode?: () => number | undefined;
  readonly toolState: {
    readonly get: (k: string) => unknown;
    readonly put: (k: string, v: unknown) => void;
  };
  readonly hostPlanes?: { governance: unknown };
  render(result: unknown): Promise<void>;
}
export interface Other { readonly nested: string; }
`;
    const seams = arch.extractToolCliContextSeams(source);
    assert.deepEqual([...seams], ['scope', 'getExitCode', 'toolState', 'hostPlanes', 'render']);
    assert.ok(!seams.includes('get'));
    assert.ok(!seams.includes('put'));
    assert.ok(!seams.includes('governance'));
  });

  it('fails on missing ToolCliContext', () => {
    assert.throws(() => arch.extractToolCliContextSeams('export interface Foo {}'), /not found/);
  });

  it('fails on duplicate ToolCliContext interfaces', () => {
    const source = `
export interface ToolCliContext { readonly a: 1 }
export interface ToolCliContext { readonly b: 2 }
`;
    assert.throws(() => arch.extractToolCliContextSeams(source), /duplicate/);
  });

  it('locks real ToolCliContext at exactly 24 members', () => {
    const text = readFileSync(join(REPO, 'packages/core/src/tools/cli-context.ts'), 'utf8');
    const seams = arch.extractToolCliContextSeams(text);
    assert.equal(seams.length, 24);
    assert.ok(seams.includes('scope'));
    assert.ok(seams.includes('getExitCode'));
    assert.ok(seams.includes('hostPlanes'));
    assert.ok(seams.includes('toolState'));
    assert.ok(!seams.includes('get'));
    assert.ok(!seams.includes('list'));
  });

  it('workspace inventory is 58 packages (56 publishable, 2 private)', () => {
    const records = readWorkspacePackageManifests(REPO);
    assert.equal(records.length, 58);
    const priv = records.filter((r) => r.private);
    assert.equal(priv.length, 2);
    const names = new Set(priv.map((r) => r.name));
    assert.ok(names.has('@opensip-cli/test-support'));
    assert.ok(names.has('@opensip-cli/checks-dogfood'));
  });
});
