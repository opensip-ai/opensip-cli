import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverGraphAdapterPackages,
  readGraphAdapterPackageMetadata,
  readGraphAdapterPackagePreferences,
} from '../graph-adapter-discovery.js';

let testDir: string;

function makeNodeModulesPackage(
  testDir: string,
  scopedName: string,
  fields: Record<string, unknown> = {},
): string {
  const [scope, name] = scopedName.startsWith('@')
    ? [scopedName.split('/')[0], scopedName.split('/').slice(1).join('/')]
    : ['', scopedName];
  const dir = scope
    ? join(testDir, 'node_modules', scope, name)
    : join(testDir, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: scopedName,
      version: '0.0.0',
      main: './index.js',
      // Real adapters declare this marker; auto-discovery requires it. Tests
      // that want a marker-less library pass `{ opensipTools: undefined }`.
      opensipTools: { kind: 'graph-adapter' },
      ...fields,
    }),
  );
  writeFileSync(join(dir, 'index.js'), 'export const adapter = {}; export const metadata = {}');
  return dir;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-graph-adapter-disc-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('discoverGraphAdapterPackages — auto-discovery (default)', () => {
  it('finds @opensip-tools/graph-* packages in node_modules', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-rust');
    const result = discoverGraphAdapterPackages({ projectDir: testDir });
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual([
      '@opensip-tools/graph-python',
      '@opensip-tools/graph-rust',
    ]);
  });

  it('returns every @opensip-tools/graph-* package without privileging any one', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-typescript');
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    const result = discoverGraphAdapterPackages({ projectDir: testDir });
    expect(result.map((p) => p.name).sort()).toEqual([
      '@opensip-tools/graph-python',
      '@opensip-tools/graph-typescript',
    ]);
  });

  it('does NOT match @opensip-tools/graph itself (engine package)', () => {
    // The hyphen anchor on `graph-` ensures the bare engine package
    // name `graph` is excluded from discovery. Without this, the
    // engine would attempt to load itself as an adapter pack.
    makeNodeModulesPackage(testDir, '@opensip-tools/graph');
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    const result = discoverGraphAdapterPackages({ projectDir: testDir });
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/graph-python']);
  });

  it('ignores @opensip-tools packages that are not graph adapter packs', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/checks-python');
    makeNodeModulesPackage(testDir, '@opensip-tools/lang-python');
    makeNodeModulesPackage(testDir, '@opensip-tools/core');
    const result = discoverGraphAdapterPackages({ projectDir: testDir });
    expect(result).toHaveLength(0);
  });

  it('does NOT auto-discover a graph-* scaffolding library with no kind marker', () => {
    // @opensip-tools/graph-adapter-common shares the `graph-` prefix but is a
    // shared library, not an adapter — it carries no `opensipTools.kind`, so
    // auto-discovery must skip it silently (no "missing adapter export" warning).
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-adapter-common', { opensipTools: undefined });
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    const result = discoverGraphAdapterPackages({ projectDir: testDir });
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/graph-python']);
  });

  it('walks ancestor node_modules to handle pnpm hoisted layouts', () => {
    // Place adapter pack in workspace-root node_modules, run discovery
    // from a nested project dir.
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    const nestedDir = join(testDir, 'apps', 'web');
    mkdirSync(nestedDir, { recursive: true });
    const result = discoverGraphAdapterPackages({ projectDir: nestedDir });
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/graph-python']);
  });

  it('returns empty array when there is no @opensip-tools scope dir', () => {
    const result = discoverGraphAdapterPackages({ projectDir: testDir });
    expect(result).toEqual([]);
  });
});

describe('discoverGraphAdapterPackages — opt-out', () => {
  it('returns empty array when autoDiscover is false', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    const result = discoverGraphAdapterPackages({ projectDir: testDir, autoDiscover: false });
    expect(result).toEqual([]);
  });
});

describe('discoverGraphAdapterPackages — explicit packages', () => {
  it('loads only the configured list', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-rust');
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-typescript');
    const result = discoverGraphAdapterPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/graph-python'],
    });
    expect(result.map((p) => p.name)).toEqual(['@opensip-tools/graph-python']);
  });

  it('warns and skips packages that are configured but not installed', () => {
    const result = discoverGraphAdapterPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/graph-missing'],
    });
    expect(result).toEqual([]);
  });

  it('explicit empty list disables loading entirely', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    const result = discoverGraphAdapterPackages({ projectDir: testDir, explicitPackages: [] });
    expect(result).toEqual([]);
  });

  it('honors every entry in the explicit list — no package is privileged', () => {
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-typescript');
    makeNodeModulesPackage(testDir, '@opensip-tools/graph-python');
    const result = discoverGraphAdapterPackages({
      projectDir: testDir,
      explicitPackages: ['@opensip-tools/graph-typescript', '@opensip-tools/graph-python'],
    });
    expect(result.map((p) => p.name).sort()).toEqual([
      '@opensip-tools/graph-python',
      '@opensip-tools/graph-typescript',
    ]);
  });
});

describe('readGraphAdapterPackageMetadata', () => {
  it('reads name and main from package.json', () => {
    const dir = makeNodeModulesPackage(testDir, '@opensip-tools/graph-python', {
      main: './dist/index.js',
    });
    const meta = readGraphAdapterPackageMetadata(dir);
    expect(meta?.name).toBe('@opensip-tools/graph-python');
    expect(meta?.mainEntry.endsWith('/dist/index.js')).toBe(true);
  });

  it('honors exports["."] over main', () => {
    const dir = makeNodeModulesPackage(testDir, '@opensip-tools/graph-rust', {
      main: './main-fallback.js',
      exports: { '.': './dist/preferred.js' },
    });
    const meta = readGraphAdapterPackageMetadata(dir);
    expect(meta?.mainEntry.endsWith('/dist/preferred.js')).toBe(true);
  });

  it('returns undefined when no package.json exists', () => {
    expect(readGraphAdapterPackageMetadata('/nonexistent/path')).toBeUndefined();
  });
});

describe('readGraphAdapterPackagePreferences', () => {
  it('reads graphAdapters and autoDiscoverGraphAdapters from project config', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    languages: [typescript]
    concerns: []
    include: ["**/*.ts"]
plugins:
  graphAdapters:
    - "@opensip-tools/graph-python"
  autoDiscoverGraphAdapters: false
fitness:
  failOnErrors: 1
  failOnWarnings: 0
  disabledChecks: []
`,
    );
    const prefs = readGraphAdapterPackagePreferences(testDir);
    expect(prefs.graphAdapters).toEqual(['@opensip-tools/graph-python']);
    expect(prefs.autoDiscoverGraphAdapters).toBe(false);
  });

  it('returns empty object when config has no plugins section', () => {
    writeFileSync(
      join(testDir, 'opensip-tools.config.yml'),
      `targets:
  src:
    description: x
    languages: []
    concerns: []
    include: ["**/*.ts"]
fitness: { failOnErrors: 0, failOnWarnings: 0, disabledChecks: [] }
`,
    );
    const prefs = readGraphAdapterPackagePreferences(testDir);
    expect(prefs).toEqual({});
  });

  it('returns empty object when no config file exists', () => {
    expect(readGraphAdapterPackagePreferences(testDir)).toEqual({});
  });
});
