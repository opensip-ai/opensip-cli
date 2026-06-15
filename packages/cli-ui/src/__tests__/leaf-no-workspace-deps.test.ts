/**
 * @opensip-cli/cli-ui is a LEAF UI kit (host-owned-run-timing §11 #8): it must
 * carry ZERO `@opensip-cli/*` workspace dependencies, so tools that ship a live
 * view depend on the UI primitives without pulling in the dispatcher / kernel.
 * The dependency-cruiser rule `cli-ui-no-workspace-deps` enforces this on the
 * import graph; this test enforces it on the package MANIFEST itself (the two
 * are complementary — a stray declared-but-unused dep would slip past depcruise).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe('@opensip-cli/cli-ui — leaf package (no workspace deps)', () => {
  it('is the cli-ui package', () => {
    expect(pkg.name).toBe('@opensip-cli/cli-ui');
  });

  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const) {
    it(`declares no @opensip-cli/* package in ${field}`, () => {
      const names = Object.keys(pkg[field] ?? {});
      const workspaceDeps = names.filter((n) => n.startsWith('@opensip-cli/'));
      expect(workspaceDeps).toEqual([]);
    });
  }
});
