/**
 * Determinism + warm-safety + structural contract of the flat-large fixture
 * generator (`_flat-large-fixture.ts`, ADR-0045 B1 measurement plane):
 *
 *   (a) byte-identity — two generations with the same spec are identical
 *       file-by-file;
 *   (b) warm-safety — re-invoking on an existing dir is a strict no-op
 *       (`skipped: true`, mtimes unchanged — the fragment cache fingerprint
 *       is mtime+size, so any rewrite would poison warm measurements);
 *   (c) resolvable imports — every emitted relative specifier resolves to a
 *       generated file;
 *   (d) misalignment — each `src/dN` directory mixes files from more than
 *       one cluster (otherwise `hybrid` would trivially win the experiment).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { generateFlatLargeFixture } from './_flat-large-fixture.js';

import type { FlatLargeFixtureSpec } from './_flat-large-fixture.js';

const SMALL_SPEC: FlatLargeFixtureSpec = { fileCount: 60 };

const work = mkdtempSync(join(tmpdir(), 'flat-large-fixture-test-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Walk a generated tree, returning sorted POSIX-relative file paths. */
function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, entryRel));
    else out.push(entryRel);
  }
  out.sort();
  return out;
}

describe('generateFlatLargeFixture', () => {
  it('(a) two generations with the same spec are byte-identical file-by-file', () => {
    const a = join(work, 'gen-a');
    const b = join(work, 'gen-b');
    const resultA = generateFlatLargeFixture(a, SMALL_SPEC);
    const resultB = generateFlatLargeFixture(b, SMALL_SPEC);
    expect(resultA).toEqual({
      fileCount: 60,
      clusterCount: 30,
      skipped: false,
    });
    expect(resultB.skipped).toBe(false);

    const filesA = listFiles(a);
    expect(filesA).toEqual(listFiles(b));
    expect(filesA.length).toBe(60 + 2); // 60 sources + package.json + tsconfig.json
    for (const rel of filesA) {
      expect(readFileSync(join(a, rel), 'utf8')).toBe(readFileSync(join(b, rel), 'utf8'));
    }
  });

  it('(b) re-invoking on an existing dir is a no-op (skipped: true, mtimes unchanged)', () => {
    const dir = join(work, 'gen-warm');
    generateFlatLargeFixture(dir, SMALL_SPEC);
    const before = new Map(
      listFiles(dir).map((rel) => [rel, statSync(join(dir, rel)).mtimeMs] as const),
    );

    const again = generateFlatLargeFixture(dir, SMALL_SPEC);
    expect(again.skipped).toBe(true);

    const after = listFiles(dir);
    expect(after).toEqual([...before.keys()].sort());
    for (const rel of after) {
      expect(statSync(join(dir, rel)).mtimeMs).toBe(before.get(rel));
    }
  });

  it('(c) every emitted import specifier resolves to a generated file', () => {
    const dir = join(work, 'gen-imports');
    generateFlatLargeFixture(dir, SMALL_SPEC);
    const sources = listFiles(dir).filter((rel) => rel.endsWith('.ts'));
    let importCount = 0;
    for (const rel of sources) {
      const text = readFileSync(join(dir, rel), 'utf8');
      for (const match of text.matchAll(/from '([^']+)'/g)) {
        importCount++;
        const spec = match[1] ?? '';
        const targetRel = posix.join(posix.dirname(rel), spec.replace(/\.js$/, '.ts'));
        expect(existsSync(join(dir, targetRel)), `${rel} imports missing ${spec}`).toBe(true);
      }
    }
    expect(importCount).toBeGreaterThan(0);
  });

  it('(d) each src/dN directory mixes files from more than one cluster', () => {
    const dir = join(work, 'gen-mix');
    const { clusterCount } = generateFlatLargeFixture(dir, SMALL_SPEC);
    const byDir = new Map<string, Set<number>>();
    for (const rel of listFiles(dir)) {
      const match = /^src\/(d\d+)\/f(\d+)\.ts$/.exec(rel);
      if (match === null) continue;
      const clusters = byDir.get(match[1] ?? '') ?? new Set<number>();
      clusters.add(Number(match[2]) % clusterCount);
      byDir.set(match[1] ?? '', clusters);
    }
    expect(byDir.size).toBeGreaterThan(1);
    for (const [dirName, clusters] of byDir) {
      expect(clusters.size, `${dirName} holds a single cluster`).toBeGreaterThan(1);
    }
  });
});
