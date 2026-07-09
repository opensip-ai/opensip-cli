/**
 * @opensip-cli/cli-ui is a near-leaf UI kit: the only allowed workspace
 * dependency is the pure `@opensip-cli/format` label package (ADR-0144).
 * It must not pull core, contracts, the dispatcher, or tools. The
 * dependency-cruiser rule `cli-ui-no-workspace-deps` enforces this on the
 * import graph; this test enforces it on the package MANIFEST itself.
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

/** ADR-0144: pure presentation formatters only. */
const ALLOWED_WORKSPACE_DEPS = new Set(['@opensip-cli/format']);

describe('@opensip-cli/cli-ui — leaf package (format-only workspace dep)', () => {
  it('is the cli-ui package', () => {
    expect(pkg.name).toBe('@opensip-cli/cli-ui');
  });

  it('may depend only on @opensip-cli/format among workspace packages', () => {
    const names = Object.keys(pkg.dependencies ?? {});
    const workspaceDeps = names.filter((n) => n.startsWith('@opensip-cli/'));
    expect(workspaceDeps.every((n) => ALLOWED_WORKSPACE_DEPS.has(n))).toBe(true);
    expect(workspaceDeps).toContain('@opensip-cli/format');
  });

  for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
    it(`declares no @opensip-cli/* package in ${field}`, () => {
      const names = Object.keys(pkg[field] ?? {});
      const workspaceDeps = names.filter((n) => n.startsWith('@opensip-cli/'));
      expect(workspaceDeps).toEqual([]);
    });
  }
});
