import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverCapabilityContributions,
  type CapabilityDiscoveryDiagnostic,
} from '../capability-discovery.js';

import type { CapabilityDiscoveryDescriptor } from '../../tools/capability.js';

let testDir: string;

/**
 * Write a fixture package: `package.json` (name + optional marker) and an
 * `index.mjs` exporting `<exportName>` with the given JS literal source. The
 * substrate dynamic-imports the entry, so the export must be real ESM.
 */
function writeFixturePackage(opts: {
  readonly relDir: string; // e.g. 'node_modules/@acme/items-a'
  readonly name: string;
  readonly markerKind?: string;
  readonly exportName: string;
  readonly exportSource: string; // RHS of `export const <exportName> =`
  readonly baseDir?: string; // root the relDir is joined under; defaults to testDir
}): void {
  const dir = join(opts.baseDir ?? testDir, opts.relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: opts.name,
      type: 'module',
      main: './index.mjs',
      ...(opts.markerKind === undefined ? {} : { opensipTools: { kind: opts.markerKind } }),
    }),
  );
  writeFileSync(
    join(dir, 'index.mjs'),
    `export const ${opts.exportName} = ${opts.exportSource};\n`,
  );
}

const MARKER_DESCRIPTOR: CapabilityDiscoveryDescriptor = {
  discovery: { mode: 'marker', markerKind: 'items-pack' },
  exportName: 'items',
  exportShape: 'array',
  configKeys: { packages: 'itemPackages' },
};

const NAME_PATTERN_DESCRIPTOR: CapabilityDiscoveryDescriptor = {
  discovery: {
    mode: 'name-pattern',
    prefix: 'items-',
    defaultScopes: ['@acme'],
  },
  exportName: 'items',
  exportShape: 'array',
  configKeys: {
    packages: 'itemPackages',
    autoDiscover: 'autoDiscoverItems',
    scopes: 'itemScopes',
  },
};

const SINGLE_DESCRIPTOR: CapabilityDiscoveryDescriptor = {
  discovery: { mode: 'marker', markerKind: 'adapter-pack' },
  exportName: 'adapter',
  exportShape: 'single',
  configKeys: {},
};

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-cap-discovery-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('discoverCapabilityContributions — marker mode', () => {
  it('carries package target metadata on discovered contributions', async () => {
    const dir = join(testDir, 'node_modules', '@acme/items-meta');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/items-meta',
        type: 'module',
        main: './index.mjs',
        opensipTools: {
          kind: 'items-pack',
          targetDomain: 'items',
          targetDomainApiVersion: 1,
        },
      }),
    );
    writeFileSync(join(dir, 'index.mjs'), `export const items = [{ id: 'meta' }];\n`);

    const contributions = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
    });

    expect(contributions).toEqual([
      {
        contribution: { id: 'meta' },
        sourcePackage: '@acme/items-meta',
        packageTargetDomain: 'items',
        packageTargetDomainApiVersion: 1,
      },
    ]);
  });

  it('finds a marker package and spreads its array export, tagged by source', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-a',
      name: '@acme/items-a',
      markerKind: 'items-pack',
      exportName: 'items',
      exportSource: "[{ id: 'one' }, { id: 'two' }]",
    });
    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
    });
    expect(out).toEqual([
      { contribution: { id: 'one' }, sourcePackage: '@acme/items-a' },
      { contribution: { id: 'two' }, sourcePackage: '@acme/items-a' },
    ]);
  });

  it('ignores packages declaring a different marker kind', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/other',
      name: '@acme/other',
      markerKind: 'something-else',
      exportName: 'items',
      exportSource: "[{ id: 'nope' }]",
    });
    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
    });
    expect(out).toEqual([]);
  });

  it('normalizes a single-shape export to one contribution', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/adapter',
      name: '@acme/adapter',
      markerKind: 'adapter-pack',
      exportName: 'adapter',
      exportSource: "{ language: 'go' }",
    });
    const out = await discoverCapabilityContributions({
      descriptor: SINGLE_DESCRIPTOR,
      projectDir: testDir,
    });
    expect(out).toEqual([{ contribution: { language: 'go' }, sourcePackage: '@acme/adapter' }]);
  });

  it('splits built-ins to cliDir when builtinScope is declared', async () => {
    const cliDir = mkdtempSync(join(tmpdir(), 'opensip-cap-cli-'));
    try {
      // built-in lives in the CLI tree
      writeFixturePackage({
        baseDir: cliDir,
        relDir: 'node_modules/@builtin/items-core',
        name: '@builtin/items-core',
        markerKind: 'items-pack',
        exportName: 'items',
        exportSource: "[{ id: 'builtin' }]",
      });
      // a project-installed @builtin/* is a SHADOW and must be dropped
      writeFixturePackage({
        relDir: 'node_modules/@builtin/items-core',
        name: '@builtin/items-core',
        markerKind: 'items-pack',
        exportName: 'items',
        exportSource: "[{ id: 'shadow' }]",
      });
      // a consumer-owned pack resolves from the project
      writeFixturePackage({
        relDir: 'node_modules/@acme/items-custom',
        name: '@acme/items-custom',
        markerKind: 'items-pack',
        exportName: 'items',
        exportSource: "[{ id: 'custom' }]",
      });
      const out = await discoverCapabilityContributions({
        descriptor: { ...MARKER_DESCRIPTOR, builtinScope: '@builtin' },
        projectDir: testDir,
        cliDir,
      });
      const ids = out.map((c) => (c.contribution as { id: string }).id).sort();
      expect(ids).toEqual(['builtin', 'custom']); // 'shadow' dropped
    } finally {
      rmSync(cliDir, { recursive: true, force: true });
    }
  });
});

describe('discoverCapabilityContributions — name-pattern mode', () => {
  it('finds @scope/prefix-* packages under the default scopes', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-load',
      name: '@acme/items-load',
      exportName: 'items',
      exportSource: "[{ id: 'load' }]",
    });
    // wrong prefix — ignored
    writeFixturePackage({
      relDir: 'node_modules/@acme/widgets-x',
      name: '@acme/widgets-x',
      exportName: 'items',
      exportSource: "[{ id: 'widget' }]",
    });
    const out = await discoverCapabilityContributions({
      descriptor: NAME_PATTERN_DESCRIPTOR,
      projectDir: testDir,
    });
    expect(out).toEqual([{ contribution: { id: 'load' }, sourcePackage: '@acme/items-load' }]);
  });

  it('honors a scopes override over the descriptor default', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@other/items-z',
      name: '@other/items-z',
      exportName: 'items',
      exportSource: "[{ id: 'z' }]",
    });
    const out = await discoverCapabilityContributions({
      descriptor: NAME_PATTERN_DESCRIPTOR,
      projectDir: testDir,
      preferences: { scopes: ['@other'] },
    });
    expect(out).toEqual([{ contribution: { id: 'z' }, sourcePackage: '@other/items-z' }]);
  });
});

describe('discoverCapabilityContributions — preferences', () => {
  it('explicit packages override auto-discovery', async () => {
    // a marker package that WOULD auto-discover
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-auto',
      name: '@acme/items-auto',
      markerKind: 'items-pack',
      exportName: 'items',
      exportSource: "[{ id: 'auto' }]",
    });
    // the explicitly-listed package (no marker — only reachable via explicit list)
    writeFixturePackage({
      relDir: 'node_modules/@acme/explicit',
      name: '@acme/explicit',
      exportName: 'items',
      exportSource: "[{ id: 'explicit' }]",
    });
    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
      preferences: { packages: ['@acme/explicit'] },
    });
    expect(out).toEqual([{ contribution: { id: 'explicit' }, sourcePackage: '@acme/explicit' }]);
  });

  it('autoDiscover:false yields nothing even with a marker present', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-a',
      name: '@acme/items-a',
      markerKind: 'items-pack',
      exportName: 'items',
      exportSource: "[{ id: 'one' }]",
    });
    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
      preferences: { autoDiscover: false },
    });
    expect(out).toEqual([]);
  });

  it('diagnoses an explicit package that is not installed', async () => {
    const diags: CapabilityDiscoveryDiagnostic[] = [];
    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
      preferences: { packages: ['@acme/missing'] },
      onDiagnostic: (d) => diags.push(d),
    });
    expect(out).toEqual([]);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.evt).toBe('capability.discovery.package_not_resolved');
    expect(diags[0]?.packageName).toBe('@acme/missing');
  });

  it('denies a selected package before resolving or importing its entry', async () => {
    const dir = join(testDir, 'node_modules/@acme/denied');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/denied',
        type: 'module',
        main: './index.mjs',
        opensipTools: { kind: 'items-pack' },
      }),
    );
    writeFileSync(join(dir, 'index.mjs'), "throw new Error('must not import');\n");
    const diags: CapabilityDiscoveryDiagnostic[] = [];

    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
      preferences: { packages: ['@acme/denied'] },
      shouldLoadPackage: (pkg) =>
        pkg.name === '@acme/denied' ? { admit: false, reason: 'not trusted' } : { admit: true },
      onDiagnostic: (d) => diags.push(d),
    });

    expect(out).toEqual([]);
    expect(diags).toEqual([
      {
        evt: 'capability.discovery.package_denied',
        packageName: '@acme/denied',
        message: 'package @acme/denied denied by capability-pack trust policy: not trusted',
      },
    ]);
  });
});

describe('discoverCapabilityContributions — co-contributions (§5.3)', () => {
  it('routes a secondary export to its target domain, tagged', async () => {
    const dir = join(testDir, 'node_modules/@acme/items-co');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/items-co',
        type: 'module',
        main: './index.mjs',
        opensipTools: { kind: 'items-pack' },
      }),
    );
    writeFileSync(
      join(dir, 'index.mjs'),
      "export const items = [{ id: 'a' }];\nexport const extras = [{ id: 'x' }, { id: 'y' }];\n",
    );

    const out = await discoverCapabilityContributions({
      descriptor: {
        ...MARKER_DESCRIPTOR,
        coContributions: [
          {
            exportName: 'extras',
            exportShape: 'array',
            domainId: 'extras-domain',
          },
        ],
      },
      projectDir: testDir,
    });
    expect(out).toEqual([
      { contribution: { id: 'a' }, sourcePackage: '@acme/items-co' },
      {
        contribution: { id: 'x' },
        sourcePackage: '@acme/items-co',
        targetDomainId: 'extras-domain',
      },
      {
        contribution: { id: 'y' },
        sourcePackage: '@acme/items-co',
        targetDomainId: 'extras-domain',
      },
    ]);
  });

  it('a package missing the co-export is silent (the co-export is optional)', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-only',
      name: '@acme/items-only',
      markerKind: 'items-pack',
      exportName: 'items',
      exportSource: "[{ id: 'a' }]",
    });
    const diags: CapabilityDiscoveryDiagnostic[] = [];
    const out = await discoverCapabilityContributions({
      descriptor: {
        ...MARKER_DESCRIPTOR,
        coContributions: [{ exportName: 'recipes', exportShape: 'array', domainId: 'r' }],
      },
      projectDir: testDir,
      onDiagnostic: (d) => diags.push(d),
    });
    expect(out).toEqual([{ contribution: { id: 'a' }, sourcePackage: '@acme/items-only' }]);
    expect(diags).toEqual([]);
  });
});

describe('discoverCapabilityContributions — explicit list mode', () => {
  it('augment mode unions explicit + auto-discovered packages', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-auto',
      name: '@acme/items-auto',
      markerKind: 'items-pack',
      exportName: 'items',
      exportSource: "[{ id: 'auto' }]",
    });
    // no marker — only reachable via the explicit list
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-explicit',
      name: '@acme/items-explicit',
      exportName: 'items',
      exportSource: "[{ id: 'explicit' }]",
    });
    const out = await discoverCapabilityContributions({
      descriptor: { ...MARKER_DESCRIPTOR, explicitListMode: 'augment' },
      projectDir: testDir,
      preferences: { packages: ['@acme/items-explicit'] },
    });
    const ids = out.map((c) => (c.contribution as { id: string }).id).sort();
    expect(ids).toEqual(['auto', 'explicit']);
  });
});

describe('discoverCapabilityContributions — per-package isolation', () => {
  it('skips a package whose array export is the wrong shape, with a diagnostic', async () => {
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-bad',
      name: '@acme/items-bad',
      markerKind: 'items-pack',
      exportName: 'items',
      exportSource: "{ not: 'an array' }",
    });
    writeFixturePackage({
      relDir: 'node_modules/@acme/items-good',
      name: '@acme/items-good',
      markerKind: 'items-pack',
      exportName: 'items',
      exportSource: "[{ id: 'good' }]",
    });
    const diags: CapabilityDiscoveryDiagnostic[] = [];
    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
      onDiagnostic: (d) => diags.push(d),
    });
    // the good package still loads — one bad export doesn't fail the others
    expect(out).toEqual([{ contribution: { id: 'good' }, sourcePackage: '@acme/items-good' }]);
    expect(diags.map((d) => d.evt)).toContain('capability.discovery.bad_export');
  });

  it('skips a package whose entry throws on import, with a diagnostic', async () => {
    const dir = join(testDir, 'node_modules/@acme/items-throws');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@acme/items-throws',
        type: 'module',
        main: './index.mjs',
        opensipTools: { kind: 'items-pack' },
      }),
    );
    writeFileSync(join(dir, 'index.mjs'), "throw new Error('boom on import');\n");
    const diags: CapabilityDiscoveryDiagnostic[] = [];
    const out = await discoverCapabilityContributions({
      descriptor: MARKER_DESCRIPTOR,
      projectDir: testDir,
      onDiagnostic: (d) => diags.push(d),
    });
    expect(out).toEqual([]);
    expect(diags.map((d) => d.evt)).toContain('capability.discovery.load_failed');
  });
});
