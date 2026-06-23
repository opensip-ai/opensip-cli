import { describe, expect, it } from 'vitest';

import {
  analyzeAllToolIdentityManifests,
  analyzeToolIdentitySingleSource,
} from '../tool-identity-single-source.js';

import type { FileAccessor } from '@opensip-cli/fitness';

function accessor(files: Record<string, string>): FileAccessor {
  return {
    paths: Object.keys(files),
    read: (path: string) => Promise.resolve(files[path] ?? ''),
    readMany: (paths: readonly string[]) =>
      Promise.resolve(new Map(paths.map((path) => [path, files[path] ?? '']))),
    readAll: () => Promise.resolve(new Map(Object.entries(files))),
  };
}

describe('tool-identity-single-source', () => {
  it('passes a conformant fitness-shaped manifest', () => {
    const pkg = {
      opensipTools: {
        kind: 'tool',
        id: 'fitness',
        identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
        commands: [
          { name: 'fitness', aliases: ['fit'], description: 'Run' },
          { name: 'list', parent: 'fitness', description: 'List' },
        ],
        pluginLayout: { domain: 'fit', userSubdirs: ['checks'] },
      },
    };
    expect(analyzeToolIdentitySingleSource(pkg, 'packages/fitness/engine/package.json')).toEqual(
      [],
    );
  });

  it('flags missing identity', () => {
    const pkg = {
      opensipTools: {
        kind: 'tool',
        id: 'fitness',
        commands: [{ name: 'fitness', description: 'Run' }],
      },
    };
    const violations = analyzeToolIdentitySingleSource(pkg, 'package.json');
    expect(violations.some((v) => v.type === 'identity-identity')).toBe(true);
  });

  it('flags id drift from identity.name', () => {
    const pkg = {
      opensipTools: {
        kind: 'tool',
        id: 'fit',
        identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
        commands: [{ name: 'fitness', aliases: ['fit'], description: 'Run' }],
        pluginLayout: { domain: 'fit', userSubdirs: [] },
      },
    };
    const violations = analyzeToolIdentitySingleSource(pkg, 'package.json');
    expect(violations.some((v) => v.message.includes('must equal identity.name'))).toBe(true);
  });

  it('walks package.json files via analyzeAll', async () => {
    const violations = await analyzeAllToolIdentityManifests(
      accessor({
        'a/package.json': JSON.stringify({ name: 'a' }),
        'b/package.json': JSON.stringify({
          opensipTools: { kind: 'tool', id: 'x', commands: [{ name: 'x', description: 'd' }] },
        }),
      }),
    );
    expect(violations.length).toBeGreaterThan(0);
  });
});
