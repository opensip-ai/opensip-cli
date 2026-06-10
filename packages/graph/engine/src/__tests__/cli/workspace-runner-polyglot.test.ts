/**
 * Polyglot --workspace aggregation via mock adapters (D8b).
 *
 * Verifies that discoverPolyglotUnits walks every adapter that
 * implements `discoverWorkspaceUnits`, aggregates their units, and
 * returns them sorted by rootDir for deterministic fan-out order.
 * Adapters without the hook contribute zero units but don't throw.
 */

import { describe, expect, it } from 'vitest';

import { discoverPolyglotUnits } from '../../cli/workspace-runner.js';

import type { LanguageAdapter, WorkspaceUnit } from '@opensip-tools/core';

function mockAdapter(id: string, units?: readonly WorkspaceUnit[]): LanguageAdapter {
  return {
    id,
    fileExtensions: ['.x'],
    parse: () => null,
    stripStrings: (s) => s,
    stripComments: (s) => s,
    discoverWorkspaceUnits:
      units === undefined
        ? undefined
        : // eslint-disable-next-line @typescript-eslint/require-await
          async () => units,
  };
}

describe('discoverPolyglotUnits', () => {
  it('returns an empty list when no adapters are passed', async () => {
    const units = await discoverPolyglotUnits('/var/fixture-root', []);
    expect(units).toEqual([]);
  });

  it('aggregates units across multiple adapters', async () => {
    const tsUnits: WorkspaceUnit[] = [
      { id: 'ts-a', rootDir: '/root/ts/a', configPath: '/root/ts/a/tsconfig.json' },
      { id: 'ts-b', rootDir: '/root/ts/b', configPath: '/root/ts/b/tsconfig.json' },
      { id: 'ts-c', rootDir: '/root/ts/c', configPath: '/root/ts/c/tsconfig.json' },
    ];
    const rustUnits: WorkspaceUnit[] = [
      { id: 'crate-x', rootDir: '/root/crates/x', configPath: '/root/crates/x/Cargo.toml' },
      { id: 'crate-y', rootDir: '/root/crates/y', configPath: '/root/crates/y/Cargo.toml' },
    ];
    const ts = mockAdapter('typescript', tsUnits);
    const rust = mockAdapter('rust', rustUnits);
    const all = await discoverPolyglotUnits('/root', [ts, rust]);
    expect(all).toHaveLength(5);
    const ids = all.map((u) => u.id);
    expect(ids).toContain('ts-a');
    expect(ids).toContain('crate-x');
  });

  it('returns units sorted by rootDir', async () => {
    const ts = mockAdapter('typescript', [
      { id: 'ts-z', rootDir: '/root/z' },
      { id: 'ts-a', rootDir: '/root/a' },
    ]);
    const rust = mockAdapter('rust', [{ id: 'rust-m', rootDir: '/root/m' }]);
    const all = await discoverPolyglotUnits('/root', [ts, rust]);
    expect(all.map((u) => u.rootDir)).toEqual(['/root/a', '/root/m', '/root/z']);
  });

  it('skips adapters that omit discoverWorkspaceUnits without throwing', async () => {
    const ts = mockAdapter('typescript', [{ id: 'ts-a', rootDir: '/root/a' }]);
    const noHook = mockAdapter('mystery'); // no units arg → hook omitted
    const all = await discoverPolyglotUnits('/root', [ts, noHook]);
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('ts-a');
  });

  it('returns determinstic order across runs', async () => {
    const ts = mockAdapter('typescript', [
      { id: 'a', rootDir: '/root/a' },
      { id: 'b', rootDir: '/root/b' },
    ]);
    const rust = mockAdapter('rust', [{ id: 'c', rootDir: '/root/c' }]);
    const a = await discoverPolyglotUnits('/root', [ts, rust]);
    const b = await discoverPolyglotUnits('/root', [rust, ts]);
    expect(a.map((u) => u.rootDir)).toEqual(b.map((u) => u.rootDir));
  });
});
