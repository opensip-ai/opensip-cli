import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NEAR_DUP_SIGNATURE_K } from '@opensip-cli/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { goGraphAdapter } from '../index.js';

function allOccurrences(walk: ReturnType<typeof goGraphAdapter.walkProject>) {
  return Object.values(walk.occurrences).flat();
}

describe('Go bodySignature population', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-go-sig-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates bodySignature on walked function occurrences', () => {
    writeFileSync(
      join(dir, 'main.go'),
      `package main
func work(items []string) []string {
  out := make([]string, 0, len(items))
  for _, item := range items { out = append(out, item) }
  return out
}
`,
      'utf8',
    );
    const discovery = goGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = goGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = goGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const withSig = allOccurrences(walked).filter((o) => o.bodySignature !== undefined);
    expect(withSig.length).toBeGreaterThan(0);
    expect(withSig[0]?.bodySignature?.length).toBe(NEAR_DUP_SIGNATURE_K);
  });
});
