import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultPackageAdmission, selectPackages } from '../capability-package-selection.js';

import type { CapabilityDiscoveryDescriptor } from '../../tools/capability.js';
import type {
  CapabilityDiscoveryDiagnostic,
  SelectedCapabilityPackage,
} from '../capability-discovery-types.js';

const markerDiscoveryProbe = vi.hoisted(() => ({
  packages: undefined as
    | {
        readonly name: string;
        readonly packageDir: string;
        readonly kind: string;
      }[]
    | undefined,
}));

type MarkerDiscoveryModule = Record<string, unknown> & {
  readonly discoverPackagesByDeclaredKind: (
    projectDir: string,
    kind: string,
  ) => {
    readonly name: string;
    readonly packageDir: string;
    readonly kind: string;
  }[];
};

vi.mock('../marker-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<MarkerDiscoveryModule>();
  return {
    ...actual,
    discoverPackagesByDeclaredKind: (projectDir: string, kind: string) =>
      markerDiscoveryProbe.packages ?? actual.discoverPackagesByDeclaredKind(projectDir, kind),
  };
});

const MARKER_DESCRIPTOR: CapabilityDiscoveryDescriptor = {
  discovery: { mode: 'marker', markerKind: 'edge-pack' },
  exportName: 'edges',
  exportShape: 'array',
  configKeys: { packages: 'edgePackages' },
};

const NAME_PATTERN_DESCRIPTOR: CapabilityDiscoveryDescriptor = {
  discovery: {
    mode: 'name-pattern',
    prefix: 'edge-',
    defaultScopes: ['@acme'],
  },
  exportName: 'edges',
  exportShape: 'array',
  configKeys: {},
};

let testDir: string;

beforeEach(() => {
  markerDiscoveryProbe.packages = undefined;
  testDir = mkdtempSync(join(tmpdir(), 'opensip-package-selection-edges-'));
});

afterEach(() => {
  markerDiscoveryProbe.packages = undefined;
  rmSync(testDir, { recursive: true, force: true });
});

function packageDir(name: string): string {
  return join(testDir, 'node_modules', ...name.split('/'));
}

function writeSelectedPackage(name: string, opensipTools?: Record<string, unknown>): string {
  const dir = packageDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      ...(opensipTools === undefined ? {} : { opensipTools }),
    }),
  );
  return dir;
}

function writeForeignCore(
  ownerPackageDir: string,
  manifest: {
    readonly version?: string;
    readonly opensipScopeAbiVersion?: number;
  },
): void {
  const coreDir = join(ownerPackageDir, 'node_modules', '@opensip-cli', 'core');
  mkdirSync(join(coreDir, 'dist'), { recursive: true });
  writeFileSync(
    join(coreDir, 'package.json'),
    JSON.stringify({
      name: '@opensip-cli/core',
      main: './dist/index.js',
      ...manifest,
    }),
  );
  writeFileSync(join(coreDir, 'dist', 'index.js'), 'export {};\n');
}

function descriptorWhoseModeChanges(
  first: 'marker' | 'name-pattern',
  second: 'marker' | 'name-pattern',
): CapabilityDiscoveryDescriptor {
  let reads = 0;
  const discovery = {
    markerKind: 'edge-pack',
    prefix: 'edge-',
    defaultScopes: [] as string[],
  };
  Object.defineProperty(discovery, 'mode', {
    enumerable: true,
    get: () => (reads++ === 0 ? first : second),
  });
  return {
    ...MARKER_DESCRIPTOR,
    discovery: discovery as unknown as CapabilityDiscoveryDescriptor['discovery'],
  };
}

describe('capability package selection edge cases', () => {
  it('admits packages owned by a builtin scope or name-pattern default scope', () => {
    const builtin: SelectedCapabilityPackage = {
      name: '@builtin/edge-core',
      packageDir: join(testDir, 'builtin'),
    };
    const defaultScoped: SelectedCapabilityPackage = {
      name: '@acme/edge-community',
      packageDir: join(testDir, 'community'),
    };

    expect(
      defaultPackageAdmission(builtin, {
        ...MARKER_DESCRIPTOR,
        builtinScope: '@builtin/',
      }),
    ).toEqual({ admit: true });
    expect(defaultPackageAdmission(defaultScoped, NAME_PATTERN_DESCRIPTOR)).toEqual({
      admit: true,
    });
    expect(
      defaultPackageAdmission(
        { name: '@other/edge-external', packageDir: join(testDir, 'external') },
        NAME_PATTERN_DESCRIPTOR,
      ),
    ).toMatchObject({ admit: false });
  });

  it('keeps the explicit package once when augment auto-discovery finds the same name', () => {
    const dir = writeSelectedPackage('@acme/edge-shared', {
      kind: 'edge-pack',
    });

    const selected = selectPackages({
      descriptor: { ...MARKER_DESCRIPTOR, explicitListMode: 'augment' },
      projectDir: testDir,
      preferences: { packages: ['@acme/edge-shared'] },
    });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({
      name: '@acme/edge-shared',
      packageDir: dir,
    });
  });

  it('keeps the first marker package when a discovery provider repeats a name', () => {
    const firstDir = writeSelectedPackage('@acme/edge-duplicate');
    markerDiscoveryProbe.packages = [
      {
        name: '@acme/edge-duplicate',
        packageDir: firstDir,
        kind: 'edge-pack',
      },
      {
        name: '@acme/edge-duplicate',
        packageDir: join(testDir, 'later-duplicate'),
        kind: 'edge-pack',
      },
    ];

    expect(
      selectPackages({
        descriptor: MARKER_DESCRIPTOR,
        projectDir: testDir,
      }),
    ).toEqual([
      expect.objectContaining({
        name: '@acme/edge-duplicate',
        packageDir: firstDir,
      }),
    ]);
  });

  it('fails closed when a mutable descriptor changes discovery mode during selection', () => {
    expect(
      selectPackages({
        descriptor: descriptorWhoseModeChanges('marker', 'name-pattern'),
        projectDir: testDir,
      }),
    ).toEqual([]);
    expect(
      selectPackages({
        descriptor: descriptorWhoseModeChanges('name-pattern', 'marker'),
        projectDir: testDir,
      }),
    ).toEqual([]);
  });

  it.each([
    [
      'an explicit foreign ABI with no version',
      { opensipScopeAbiVersion: 2 },
      '<unknown version> (scope ABI 2)',
    ],
    ['a pre-shared-scope core', { version: '0.1.0' }, '0.1.0 (pre-shared-scope)'],
  ])('drops %s and emits the capability-shaped diagnostic', (_label, coreManifest, detail) => {
    const name = `@acme/foreign-${String('version' in coreManifest ? coreManifest.version : 'abi')}`;
    const dir = writeSelectedPackage(name);
    writeForeignCore(dir, coreManifest);
    const diagnostics: CapabilityDiscoveryDiagnostic[] = [];

    expect(
      selectPackages({
        descriptor: MARKER_DESCRIPTOR,
        projectDir: testDir,
        preferences: { packages: [name] },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    ).toEqual([]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      evt: 'capability.discovery.foreign_core',
      packageName: name,
    });
    expect(diagnostics[0]?.message).toContain(detail);
    expect(diagnostics[0]?.message).toContain('mismatched core scope ABIs cannot share run scope');
  });
});
