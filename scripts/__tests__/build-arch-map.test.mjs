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

  it('renders the map purely from injected derived facts (no test-owned package baseline)', () => {
    // renderArchitectureMap must be a pure function of the counts/names/seams it
    // is handed, so the generated map reflects readGovernanceFacts and never a
    // frozen inventory literal. Inject synthetic facts and prove they surface.
    const out = arch.renderArchitectureMap(
      [{ layer: 1, pkg: '@x/core', note: 'kernel' }],
      ['@x/core', '@x/tool'],
      ['render', 'emitJson'],
      { total: 2, publishable: 1, private: 1 },
    );
    assert.match(out, /## Workspace packages \(2: 1 publishable, 1 private\)/);
    assert.match(out, /- `@x\/core`/);
    assert.match(out, /- `@x\/tool`/);
    assert.match(out, /## ToolCliContext seams \(2\)/);
    // No real package leaks in — the renderer has no hidden inventory of its own.
    assert.ok(!out.includes('@opensip-cli/fitness'), 'no baseline package leaks into output');
  });

  it('workspace inventory reconciles publishable + private (derived, structural identities)', () => {
    const records = readWorkspacePackageManifests(REPO);
    const priv = records.filter((r) => r.private);
    // Relationship, not a frozen number: total = publishable + private.
    assert.equal(records.length, records.filter((r) => !r.private).length + priv.length);
    // The known private ownership packages (identity, not a literal count).
    assert.deepEqual(priv.map((r) => r.name).sort(), [
      '@opensip-cli/agent-eval',
      '@opensip-cli/checks-dogfood',
      '@opensip-cli/test-support',
    ]);
    const names = records.map((r) => r.name);
    assert.equal(new Set(names).size, names.length, 'unique names');
  });
});
