import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverPackagesByDeclaredKind, isMarkerKind } from '../marker-discovery.js';

let testDir: string;

function writePkg(dir: string, json: object): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(json));
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-marker-discover-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('isMarkerKind', () => {
  it('narrows the host marker tool', () => {
    expect(isMarkerKind('tool')).toBe(true);
  });

  it.each(['', 'fit-pack', 'sim-pack', 'graph-adapter', 'graph-pack', 'TOOL', 'check-pack', 'tools'])('rejects %s', (kind) => {
    expect(isMarkerKind(kind)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isMarkerKind(undefined)).toBe(false);
    expect(isMarkerKind(null)).toBe(false);
    expect(isMarkerKind(42)).toBe(false);
    expect(isMarkerKind({ kind: 'tool' })).toBe(false);
  });
});

describe('discoverPackagesByDeclaredKind', () => {
  it('returns an empty list when node_modules is missing', () => {
    expect(discoverPackagesByDeclaredKind(testDir, 'fit-pack')).toEqual([]);
  });

  it('finds a fit-pack package under an unscoped name', () => {
    writePkg(join(testDir, 'node_modules', 'acme-fit'), {
      name: 'acme-fit',
      opensipTools: { kind: 'fit-pack' },
    });
    const out = discoverPackagesByDeclaredKind(testDir, 'fit-pack');
    expect(out.map((p) => p.name)).toEqual(['acme-fit']);
    expect(out[0]?.kind).toBe('fit-pack');
  });

  it('finds a fit-pack package under any scope', () => {
    writePkg(join(testDir, 'node_modules', '@acme', 'fit'), {
      name: '@acme/fit',
      opensipTools: { kind: 'fit-pack' },
    });
    const out = discoverPackagesByDeclaredKind(testDir, 'fit-pack');
    expect(out.map((p) => p.name)).toEqual(['@acme/fit']);
  });

  it('finds a sim-pack package without picking up fit-packs', () => {
    writePkg(join(testDir, 'node_modules', '@acme', 'sim'), {
      name: '@acme/sim',
      opensipTools: { kind: 'sim-pack' },
    });
    writePkg(join(testDir, 'node_modules', '@acme', 'fit'), {
      name: '@acme/fit',
      opensipTools: { kind: 'fit-pack' },
    });
    const out = discoverPackagesByDeclaredKind(testDir, 'sim-pack');
    expect(out.map((p) => p.name)).toEqual(['@acme/sim']);
  });

  it('does not return tool-marked packages when asked for fit-pack', () => {
    writePkg(join(testDir, 'node_modules', '@opensip-tools', 'fitness'), {
      name: '@opensip-tools/fitness',
      opensipTools: { kind: 'tool' },
    });
    expect(discoverPackagesByDeclaredKind(testDir, 'fit-pack')).toEqual([]);
  });

  it('skips packages with no opensipTools field', () => {
    writePkg(join(testDir, 'node_modules', 'random-pkg'), { name: 'random-pkg' });
    expect(discoverPackagesByDeclaredKind(testDir, 'fit-pack')).toEqual([]);
  });

  it('skips packages declaring an unknown kind', () => {
    writePkg(join(testDir, 'node_modules', '@acme', 'graph'), {
      name: '@acme/graph',
      opensipTools: { kind: 'graph-pack' },
    });
    expect(discoverPackagesByDeclaredKind(testDir, 'fit-pack')).toEqual([]);
  });

  it('skips dot-prefixed entries (.bin, .pnpm, etc.)', () => {
    writePkg(join(testDir, 'node_modules', '.bin', 'fake-pack'), {
      name: 'fake-pack',
      opensipTools: { kind: 'fit-pack' },
    });
    expect(discoverPackagesByDeclaredKind(testDir, 'fit-pack')).toEqual([]);
  });

  it('treats malformed package.json as non-pack (no crash)', () => {
    const dir = join(testDir, 'node_modules', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{not-json');
    expect(discoverPackagesByDeclaredKind(testDir, 'fit-pack')).toEqual([]);
  });

  it('walks ancestor node_modules and dedupes by package name (nearest wins)', () => {
    const nested = join(testDir, 'project');
    mkdirSync(nested, { recursive: true });

    writePkg(join(testDir, 'node_modules', '@acme', 'fit'), {
      name: '@acme/fit',
      opensipTools: { kind: 'fit-pack' },
    });
    writePkg(join(nested, 'node_modules', '@acme', 'fit'), {
      name: '@acme/fit',
      opensipTools: { kind: 'fit-pack' },
    });

    const out = discoverPackagesByDeclaredKind(nested, 'fit-pack');
    expect(out).toHaveLength(1);
    expect(out[0]?.packageDir).toBe(join(nested, 'node_modules', '@acme', 'fit'));
  });

  it('returns kind echoed in each result so multi-kind callers can multiplex', () => {
    writePkg(join(testDir, 'node_modules', '@acme', 'fit'), {
      name: '@acme/fit',
      opensipTools: { kind: 'fit-pack' },
    });
    writePkg(join(testDir, 'node_modules', '@acme', 'sim'), {
      name: '@acme/sim',
      opensipTools: { kind: 'sim-pack' },
    });
    const fitPacks = discoverPackagesByDeclaredKind(testDir, 'fit-pack');
    const simPacks = discoverPackagesByDeclaredKind(testDir, 'sim-pack');
    expect(fitPacks.every((p) => p.kind === 'fit-pack')).toBe(true);
    expect(simPacks.every((p) => p.kind === 'sim-pack')).toBe(true);
  });

  it('cross-kind isolation: discoverToolPackages does not surface fit-packs', async () => {
    // Verifies the Phase 0 refactor — tool-package-discovery delegates to
    // the generic walker with kind: 'tool', so a fit-pack should NOT show
    // up in the tool discovery results.
    const { discoverToolPackages } = await import('../tool-package-discovery.js');
    writePkg(join(testDir, 'node_modules', '@acme', 'fit'), {
      name: '@acme/fit',
      opensipTools: { kind: 'fit-pack' },
    });
    writePkg(join(testDir, 'node_modules', '@my-co', 'audit'), {
      name: '@my-co/audit',
      opensipTools: { kind: 'tool' },
    });
    const tools = discoverToolPackages({ projectDir: testDir });
    expect(tools.map((t) => t.name)).toEqual(['@my-co/audit']);
  });
});
