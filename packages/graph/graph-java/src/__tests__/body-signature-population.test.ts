import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NEAR_DUP_SIGNATURE_K } from '@opensip-cli/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { javaGraphAdapter } from '../index.js';

function allOccurrences(walk: ReturnType<typeof javaGraphAdapter.walkProject>) {
  return Object.values(walk.occurrences).flat();
}

describe('Java bodySignature population', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-java-sig-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates bodySignature on walked method occurrences', () => {
    writeFileSync(
      join(dir, 'Work.java'),
      `public class Work {
  public static String[] work(String[] items) {
    String[] out = new String[items.length];
    for (int i = 0; i < items.length; i++) out[i] = items[i].trim();
    return out;
  }
}
`,
      'utf8',
    );
    const discovery = javaGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = javaGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = javaGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const withSig = allOccurrences(walked).filter((o) => o.bodySignature !== undefined);
    expect(withSig.length).toBeGreaterThan(0);
    expect(withSig[0]?.bodySignature?.length).toBe(NEAR_DUP_SIGNATURE_K);
  });
});
