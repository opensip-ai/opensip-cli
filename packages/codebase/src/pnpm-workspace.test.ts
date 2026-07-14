import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pnpmWorkspacePatterns } from './pnpm-workspace.js';
import { MAX_WORKSPACE_PATTERNS } from './types.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-pnpm-workspace-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('pnpmWorkspacePatterns', () => {
  it('returns empty patterns when the workspace manifest is absent', () => {
    const reasons = new Set<string>();
    expect(pnpmWorkspacePatterns(tempRoot(), 1024, reasons)).toEqual([]);
    expect([...reasons]).toEqual([]);
  });

  it('projects valid package globs from a well-formed manifest', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'apps/*'\n");
    const reasons = new Set<string>();

    expect(pnpmWorkspacePatterns(root, 1024, reasons)).toEqual(['apps/*', 'packages/*']);
    expect([...reasons]).toEqual([]);
  });

  it('rejects manifests larger than the byte budget', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    const reasons = new Set<string>();

    expect(pnpmWorkspacePatterns(root, 1, reasons)).toEqual([]);
    expect([...reasons]).toEqual(['workspace-manifest-invalid']);
  });

  it('rejects parse failures and non-mapping YAML roots', () => {
    const cases: readonly { readonly body: string; readonly name: string }[] = [
      { name: 'broken yaml', body: 'packages: [\n' },
      { name: 'array root', body: "- 'packages/*'\n" },
      { name: 'scalar root', body: 'packages\n' },
      { name: 'null root', body: 'null\n' },
      { name: 'missing packages', body: "name: monorepo\n" },
      { name: 'packages not array', body: "packages: 'packages/*'\n" },
    ];

    for (const fixture of cases) {
      const root = tempRoot();
      writeFileSync(join(root, 'pnpm-workspace.yaml'), fixture.body);
      const reasons = new Set<string>();

      expect(pnpmWorkspacePatterns(root, 1024, reasons), fixture.name).toEqual([]);
      expect([...reasons], fixture.name).toEqual(['workspace-manifest-invalid']);
    }
  });

  it('records pattern invalidity and authored workspace caps', () => {
    const root = tempRoot();
    const patterns = Array.from(
      { length: MAX_WORKSPACE_PATTERNS + 1 },
      (_, index) => `packages/pkg-${String(index).padStart(3, '0')}`,
    );
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      `packages:\n${patterns.map((pattern) => `  - '${pattern}'\n`).join('')}`,
    );
    const reasons = new Set<string>();

    const projected = pnpmWorkspacePatterns(root, 64 * 1024, reasons);
    expect(projected).toHaveLength(MAX_WORKSPACE_PATTERNS);
    expect(reasons.has('manifest-workspace-cap-reached')).toBe(true);
  });

  it('records invalid workspace pattern reasons without discarding valid globs', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      "packages:\n  - '../../outside/**'\n  - 'packages/*'\n",
    );
    const reasons = new Set<string>();

    expect(pnpmWorkspacePatterns(root, 1024, reasons)).toEqual(['packages/*']);
    expect([...reasons]).toEqual(['workspace-pattern-invalid']);
  });

  it('rejects workspace manifests that resolve outside the project root', () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    symlinkSync(join(outside, 'pnpm-workspace.yaml'), join(root, 'pnpm-workspace.yaml'));
    const reasons = new Set<string>();

    expect(pnpmWorkspacePatterns(root, 1024, reasons)).toEqual([]);
    expect([...reasons]).toEqual(['workspace-manifest-invalid']);
  });

  it('qualifies unreadable workspace manifests as invalid', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'pnpm-workspace.yaml'));
    const reasons = new Set<string>();

    expect(pnpmWorkspacePatterns(root, 1024, reasons)).toEqual([]);
    expect([...reasons]).toEqual(['workspace-manifest-invalid']);
  });
});
