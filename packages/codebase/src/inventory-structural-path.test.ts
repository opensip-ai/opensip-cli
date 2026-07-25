import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROJECT_INVENTORY_SCHEMA_VERSION,
  buildProjectInventorySnapshotIdentities,
  projectInventorySnapshotSchema,
} from '@opensip-cli/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalFile } from './inventory-structural.js';

/** Would the published contract accept a snapshot carrying this file identity? */
function contractAcceptsPath(path: string): boolean {
  const base = {
    schemaVersion: PROJECT_INVENTORY_SCHEMA_VERSION,
    project: {
      workspacePatterns: [],
      languages: [],
      fileCount: 1,
      packageCount: 0,
      configIdentity: 'cfg',
    },
    packages: [],
    files: [
      {
        path,
        size: 1,
        modifiedMs: 1,
        roles: ['production' as const],
        targets: [],
        languages: [],
        evidenceSupport: {
          callable: 'unknown' as const,
          declaration: 'unknown' as const,
          reference: 'unknown' as const,
        },
        provenance: [],
      },
    ],
    coverage: { status: 'complete' as const, reasonCodes: [], observed: 1, total: 1 },
  };
  return projectInventorySnapshotSchema.safeParse({
    ...base,
    ...buildProjectInventorySnapshotIdentities(base),
  }).success;
}

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-codebase-structural-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonicalFile publishable-path bounds', () => {
  it('admits an ordinary project-relative path the contract also accepts', () => {
    const root = tempRoot();
    const file = join(root, 'package.json');
    writeFileSync(file, '{}');

    const canonical = canonicalFile(file, root);

    expect(canonical?.relativePath).toBe('package.json');
    expect(contractAcceptsPath('package.json')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a POSIX filename containing a backslash, which the contract also rejects',
    () => {
      const root = tempRoot();
      // A backslash is a legal POSIX filename byte and survives toPosixRelative, but the
      // published contract rejects it. Admitting it here would make ONE unlucky filename
      // fail the whole snapshot's validation at the very end of the build.
      const name = String.raw`we\ird.ts`;
      const file = join(root, name);
      writeFileSync(file, 'source');

      expect(contractAcceptsPath(name)).toBe(false);
      expect(canonicalFile(file, root)).toBeUndefined();
    },
  );

  it('rejects a path that escapes the project root', () => {
    const root = tempRoot();
    const outside = tempRoot();
    const file = join(outside, 'outside.ts');
    writeFileSync(file, 'source');

    expect(canonicalFile(file, root)).toBeUndefined();
  });

  it('rejects an unresolvable path rather than treating it as in-project', () => {
    const root = tempRoot();

    expect(canonicalFile(join(root, 'missing.ts'), root)).toBeUndefined();
  });
});
