/**
 * Unit tests for the `tool-has-manifest` guardrail.
 *
 * Two layers:
 *  1. The pure `analyzeToolHasManifest(pkg, filePath)` detector — exercised
 *     with in-memory parsed package.json objects (a conformant manifest → 0
 *     findings; each missing/invalid field → a finding).
 *  2. The full `analyzeAll` over a fake in-memory `FileAccessor` — proves the
 *     self-targeting (only `kind:'tool'` package.json files are inspected;
 *     non-tool packages and non-package.json files are ignored) and the
 *     malformed-JSON skip.
 */
import { describe, expect, it } from 'vitest';

import { analyzeAllToolManifests, analyzeToolHasManifest } from '../tool-has-manifest.js';

import type { FileAccessor } from '@opensip-cli/fitness';

const CONFORMANT = {
  opensipTools: {
    kind: 'tool',
    id: 'fitness',
    apiVersion: 1,
    commands: [
      { name: 'fit', description: 'Run fitness checks' },
      { name: 'fit-list', description: 'List checks', aliases: ['checks'] },
    ],
  },
};

const FILE = '/repo/packages/fitness/engine/package.json';

describe('analyzeToolHasManifest (pure detector)', () => {
  it('returns 0 findings for a conformant tool manifest', () => {
    expect(analyzeToolHasManifest(CONFORMANT, FILE)).toEqual([]);
  });

  it('returns 0 findings for a non-tool package (no opensipTools)', () => {
    expect(analyzeToolHasManifest({}, FILE)).toEqual([]);
  });

  it('returns 0 findings for a package whose opensipTools.kind is not "tool"', () => {
    expect(
      analyzeToolHasManifest({ opensipTools: { kind: 'fit-pack', id: 'x', commands: [] } }, FILE),
    ).toEqual([]);
  });

  it('flags a missing id', () => {
    const v = analyzeToolHasManifest(
      {
        opensipTools: {
          kind: 'tool',
          apiVersion: 1,
          commands: [{ name: 'x', description: 'y' }],
        },
      },
      FILE,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('manifest-id');
    expect(v[0]?.severity).toBe('error');
  });

  it('flags an empty id', () => {
    const v = analyzeToolHasManifest(
      {
        opensipTools: {
          kind: 'tool',
          id: '',
          apiVersion: 1,
          commands: [{ name: 'x', description: 'y' }],
        },
      },
      FILE,
    );
    expect(v.map((x) => x.type)).toContain('manifest-id');
  });

  it('flags a missing apiVersion', () => {
    const v = analyzeToolHasManifest(
      {
        opensipTools: {
          kind: 'tool',
          id: 'fitness',
          commands: [{ name: 'x', description: 'y' }],
        },
      },
      FILE,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('manifest-apiVersion');
  });

  it('flags a non-numeric apiVersion', () => {
    const v = analyzeToolHasManifest(
      {
        opensipTools: {
          kind: 'tool',
          id: 'fitness',
          apiVersion: 'one',
          commands: [{ name: 'x', description: 'y' }],
        },
      },
      FILE,
    );
    expect(v.map((x) => x.type)).toContain('manifest-apiVersion');
  });

  it('flags missing commands', () => {
    const v = analyzeToolHasManifest(
      { opensipTools: { kind: 'tool', id: 'fitness', apiVersion: 1 } },
      FILE,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('manifest-commands');
  });

  it('flags an empty commands array', () => {
    const v = analyzeToolHasManifest(
      {
        opensipTools: {
          kind: 'tool',
          id: 'fitness',
          apiVersion: 1,
          commands: [],
        },
      },
      FILE,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.type).toBe('manifest-commands');
  });

  it('flags a command entry missing a name', () => {
    const v = analyzeToolHasManifest(
      {
        opensipTools: {
          kind: 'tool',
          id: 'fitness',
          apiVersion: 1,
          commands: [{ description: 'no name' }],
        },
      },
      FILE,
    );
    expect(v.map((x) => x.type)).toContain('manifest-commands');
  });

  it('flags a command entry missing a description', () => {
    const v = analyzeToolHasManifest(
      {
        opensipTools: {
          kind: 'tool',
          id: 'fitness',
          apiVersion: 1,
          commands: [{ name: 'fit' }],
        },
      },
      FILE,
    );
    expect(v.map((x) => x.type)).toContain('manifest-commands');
  });

  it('accumulates findings across several invalid fields', () => {
    const v = analyzeToolHasManifest({ opensipTools: { kind: 'tool' } }, FILE);
    const types = new Set(v.map((x) => x.type));
    expect(types).toEqual(new Set(['manifest-id', 'manifest-apiVersion', 'manifest-commands']));
  });
});

/** Build a fake FileAccessor over an in-memory path→content map. */
function fakeAccessor(files: Record<string, string>): FileAccessor {
  return {
    paths: Object.keys(files),
    read: (p) => Promise.resolve(files[p] ?? ''),
    readMany: (ps) => Promise.resolve(new Map(ps.map((p) => [p, files[p] ?? '']))),
    readAll: () => Promise.resolve(new Map(Object.entries(files))),
  };
}

describe('analyzeAllToolManifests (self-targeting over the file set)', () => {
  it('returns 0 findings when every tool package is conformant', async () => {
    const files = {
      '/repo/packages/fitness/engine/package.json': JSON.stringify(CONFORMANT),
      // a non-tool package — ignored
      '/repo/packages/core/package.json': JSON.stringify({ name: '@x/core' }),
      // a non-package.json file in the set — ignored
      '/repo/src/index.ts': 'export const x = 1',
    };
    const v = await analyzeAllToolManifests(fakeAccessor(files));
    expect(v).toEqual([]);
  });

  it('flags a tool package with a broken manifest, ignoring non-tool packages', async () => {
    const files = {
      '/repo/packages/fitness/engine/package.json': JSON.stringify(CONFORMANT),
      '/repo/packages/graph/engine/package.json': JSON.stringify({
        opensipTools: {
          kind: 'tool',
          id: 'graph' /* no apiVersion, no commands */,
        },
      }),
      '/repo/packages/core/package.json': JSON.stringify({ name: '@x/core' }),
    };
    const v = await analyzeAllToolManifests(fakeAccessor(files));
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.every((x) => x.filePath === '/repo/packages/graph/engine/package.json')).toBe(true);
    expect(new Set(v.map((x) => x.type))).toEqual(
      new Set(['manifest-apiVersion', 'manifest-commands']),
    );
  });

  it('skips a malformed package.json without throwing', async () => {
    const files = { '/repo/packages/x/package.json': '{ not valid json' };
    const v = await analyzeAllToolManifests(fakeAccessor(files));
    expect(v).toEqual([]);
  });
});
