import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { walkManifestFilesystem } from './manifest-filesystem-walk.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'opensip-codebase-walk-visitor-'));
  roots.push(root);
  mkdirSync(join(root, 'packages/a'), { recursive: true });
  mkdirSync(join(root, 'packages/b'), { recursive: true });
  writeFileSync(join(root, 'packages/a/package.json'), '{"name":"a"}');
  writeFileSync(join(root, 'packages/b/package.json'), '{"name":"b"}');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('walkManifestFilesystem visitor guard', () => {
  it('qualifies the walk when the visitor throws instead of rejecting the walk', async () => {
    const root = tempRoot();
    const seen: string[] = [];

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      (candidate) => {
        seen.push(candidate.packageRoot);
        throw new Error('visitor fixture failure');
      },
    );

    expect(seen).toHaveLength(1);
    expect(result.visitorFailed).toBe(true);
    expect(result.stoppedByVisitor).toBe(true);
    expect(result.cancelled).toBe(false);
  });

  it('qualifies the walk when the visitor rejects asynchronously', async () => {
    const root = tempRoot();

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      () => Promise.reject(new Error('async visitor fixture failure')),
    );

    expect(result.visitorFailed).toBe(true);
    expect(result.stoppedByVisitor).toBe(true);
  });

  it('separates a deliberate visitor stop from a visitor fault', async () => {
    const root = tempRoot();

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      () => false,
    );

    expect(result.stoppedByVisitor).toBe(true);
    expect(result.visitorFailed).toBe(false);
  });

  it('leaves both flags clear for a walk the visitor completes', async () => {
    const root = tempRoot();
    const seen: string[] = [];

    const result = await walkManifestFilesystem(
      root,
      12,
      () => true,
      (candidate) => {
        seen.push(candidate.packageRoot);
      },
    );

    expect([...seen].sort()).toEqual(['packages/a', 'packages/b']);
    expect(result.visitorFailed).toBe(false);
    expect(result.stoppedByVisitor).toBe(false);
    expect(result.capped).toBe(false);
  });
});
