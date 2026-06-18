/**
 * @fileoverview As-if-external acceptance test (release 2.8.0, identity &
 * compatibility — Phase 5, task 5.2).
 *
 * The miniature of the north-star §8 minimum proof slice: a **bundled** tool's
 * static manifest, loaded + admitted through the **exact same** gate path an
 * external tool would take (`loadToolManifest` → `admitTool`), is admitted
 * identically — and the gate actually fires on incompatibility.
 *
 * Why the equality is asserted against a KNOWN command list rather than by
 * importing the tool's runtime `Tool.commands`: core is the kernel and MUST
 * NOT import `@opensip-cli/fitness` / `graph` / `simulation` (the layering
 * rule dependency-cruiser enforces). The manifest⇔tool equality was already
 * asserted from the tool side in Phase 1; here we assert the manifest the
 * host reads matches the contract-frozen command set the tools register.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PLUGIN_API_VERSION } from '../../tools/manifest.js';
import { admitTool, loadToolManifest } from '../manifest-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, five levels up from this test's directory. */
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..');

/** A bundled first-party tool engine dir + the command names it must declare. */
interface BundledTool {
  readonly id: string;
  readonly dir: string;
  readonly commands: readonly string[];
}

/**
 * The three bundled tools' engine package dirs + their CONTRACT-FROZEN command
 * name sets. These are the exact lists the runtime `Tool.commands` arrays
 * register (Phase 1 asserts manifest⇔Tool from the tool side); core asserts
 * the host-read manifest matches them without importing the tool runtime.
 */
const BUNDLED_TOOLS: readonly BundledTool[] = [
  {
    // tool-command-surface-taxonomy Task 2.4: the manifest `id` (human key) equals
    // `metadata.name`, now the short command verb (`fit`/`sim`; graph already
    // matched). The config namespace literal (`fitness`/`simulation`) is decoupled
    // and unchanged.
    id: 'fit',
    dir: join(REPO_ROOT, 'packages', 'fitness', 'engine'),
    // Task 2.2 adds the canonical nested `export` (parent: 'fit') command.
    // Task 3.1 adds the grouped `list` / `recipes` (parent: 'fit') children.
    commands: [
      'fit',
      'fit-list',
      'fit-recipes',
      'list',
      'recipes',
      'fit-baseline-export',
      'export',
      'fit-run-worker',
    ],
  },
  {
    id: 'sim',
    dir: join(REPO_ROOT, 'packages', 'simulation', 'engine'),
    // Task 3.3 adds the grouped `recipes` (parent: 'sim') discoverability child.
    commands: ['sim', 'recipes', 'sim-run-worker'],
  },
  {
    id: 'graph',
    dir: join(REPO_ROOT, 'packages', 'graph', 'engine'),
    commands: [
      'graph',
      'graph-lookup',
      'graph-symbol-index',
      'graph-baseline-export',
      'graph-shard-worker',
      'graph-equivalence-check',
      'graph-run-worker',
      'catalog-export',
      'sarif-export',
      // Task 2.1 adds the canonical nested `export` (parent: 'graph') command.
      'export',
      'graph-recipes',
      // Task 3.1/3.2/3.4 add the grouped `recipes` / `lookup` / `index` / `list`
      // (parent: 'graph') children.
      'recipes',
      'lookup',
      'index',
      'list',
    ],
  },
];

const FIXTURES = join(HERE, '__fixtures__');
const FUTURE_EPOCH_DIR = join(FIXTURES, 'future-epoch-tool');
const NO_APIVERSION_DIR = join(FIXTURES, 'no-apiversion-tool');

describe('as-if-external gate — bundled tools admitted through the external path', () => {
  for (const tool of BUNDLED_TOOLS) {
    describe(`${tool.id} (bundled)`, () => {
      it('(a) loads its static manifest from package.json and admits it', () => {
        const manifest = loadToolManifest('bundled', tool.dir);
        expect(manifest, `expected a readable manifest for ${tool.id}`).toBeDefined();
        if (manifest === undefined) return;

        expect(manifest.kind).toBe('tool');
        expect(manifest.id).toBe(tool.id);
        // Bundled tools declare the current epoch.
        expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);

        const result = admitTool({
          manifest,
          source: 'bundled',
          dir: tool.dir,
          packageName: manifest.name,
          explicitlyRequested: false,
        });

        expect(result.decision).toBe('admit');
        expect(result.verdict.kind).toBe('compatible');
        expect(result.diagnostic).toBeUndefined();
        // Provenance identity matches the tool the host read.
        expect(result.provenance.source).toBe('bundled');
        expect(result.provenance.id).toBe(tool.id);
        expect(result.provenance.resolvedPath).toBe(tool.dir);
        expect(result.provenance.manifestHash).toMatch(/^[0-9a-f]{64}$/);
      });

      it('(b) manifest command-name SET equals the contract-frozen Tool.commands set', () => {
        const manifest = loadToolManifest('bundled', tool.dir);
        expect(manifest).toBeDefined();
        if (manifest === undefined) return;

        const manifestNames = new Set(manifest.commands.map((c) => c.name));
        expect(manifestNames).toEqual(new Set(tool.commands));
        // Every command entry carries a non-empty description (the manifest
        // contract the guardrail enforces).
        for (const cmd of manifest.commands) {
          expect(typeof cmd.description).toBe('string');
          expect(cmd.name.length).toBeGreaterThan(0);
        }
      });
    });
  }
});

describe('as-if-external gate — the gate fires on incompatibility', () => {
  it('(c) skips an out-of-range tool that was NOT explicitly requested', () => {
    const manifest = loadToolManifest('installed', FUTURE_EPOCH_DIR);
    expect(manifest?.apiVersion).toBe(999);
    if (manifest === undefined) return;

    const result = admitTool({
      manifest,
      source: 'installed',
      dir: FUTURE_EPOCH_DIR,
      explicitlyRequested: false,
    });

    expect(result.decision).toBe('skip');
    expect(result.verdict.kind).toBe('incompatible');
    expect(result.diagnostic).toBeTruthy();
    expect(result.diagnostic).toContain('999');
    // Provenance is still recorded for a skipped tool.
    expect(result.provenance.id).toBe('future');
  });

  it('(c) fails closed for an out-of-range tool that WAS explicitly requested', () => {
    const manifest = loadToolManifest('installed', FUTURE_EPOCH_DIR);
    expect(manifest).toBeDefined();
    if (manifest === undefined) return;

    const result = admitTool({
      manifest,
      source: 'installed',
      dir: FUTURE_EPOCH_DIR,
      explicitlyRequested: true,
    });

    expect(result.decision).toBe('fail-closed');
    expect(result.verdict.kind).toBe('incompatible');
    expect(result.diagnostic).toBeTruthy();
  });

  it('(d) fail-closes an explicitly-requested tool with NO apiVersion (3.0.0 — grace window ended)', () => {
    const manifest = loadToolManifest('installed', NO_APIVERSION_DIR);
    expect(manifest).toBeDefined();
    if (manifest === undefined) return;
    // The manifest omits apiVersion entirely.
    expect(manifest.apiVersion).toBeUndefined();

    const result = admitTool({
      manifest,
      source: 'installed',
      dir: NO_APIVERSION_DIR,
      explicitlyRequested: true, // 3.0.0: a missing apiVersion + explicit request → fail-closed.
    });

    expect(result.decision).toBe('fail-closed');
    expect(result.verdict.kind).toBe('incompatible');
    expect(result.diagnostic).toBeDefined();
  });
});
