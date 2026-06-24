import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NEAR_DUP_SIGNATURE_K } from '@opensip-cli/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pythonGraphAdapter } from '../index.js';

function allOccurrences(walk: ReturnType<typeof pythonGraphAdapter.walkProject>) {
  return Object.values(walk.occurrences).flat();
}

describe('Python bodySignature population', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-py-sig-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates bodySignature on walked function occurrences', () => {
    writeFileSync(
      join(dir, 'work.py'),
      `def work(items):
    out = []
    for item in items:
        out.append(item.strip())
    return out
`,
      'utf8',
    );
    const discovery = pythonGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = pythonGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = pythonGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const withSig = allOccurrences(walked).filter((o) => o.bodySignature !== undefined);
    expect(withSig.length).toBeGreaterThan(0);
    expect(withSig[0]?.bodySignature?.length).toBe(NEAR_DUP_SIGNATURE_K);
  });
});
