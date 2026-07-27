import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { derivePackageRoots } from '../../edge-helpers/cross-package-context.js';

import type { Catalog } from '@opensip-cli/graph';

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function catalogWithFile(filePath: string): Catalog {
  return {
    functions: {
      fixture: [{ filePath }],
    },
  } as never;
}

describe('derivePackageRoots', () => {
  it('does not retain negative manifest probes across MCP-style rebuilds', () => {
    root = mkdtempSync(join(tmpdir(), 'graph-ts-package-roots-'));
    const packageRoot = join(root, 'packages', 'new-package');
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    const catalog = catalogWithFile('packages/new-package/src/index.ts');

    expect(derivePackageRoots(catalog, root)).toEqual([]);

    writeFileSync(join(packageRoot, 'package.json'), '{"name":"new-package"}', 'utf8');
    expect(derivePackageRoots(catalog, root)).toEqual([packageRoot]);
  });
});
