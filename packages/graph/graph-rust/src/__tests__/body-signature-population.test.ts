import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NEAR_DUP_SIGNATURE_K } from '@opensip-cli/graph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rustGraphAdapter } from '../index.js';

function allOccurrences(walk: ReturnType<typeof rustGraphAdapter.walkProject>) {
  return Object.values(walk.occurrences).flat();
}

describe('Rust bodySignature population', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-sig-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('populates bodySignature on walked function occurrences', () => {
    writeFileSync(
      join(dir, 'lib.rs'),
      `pub fn work(items: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for item in items {
        out.push(item.trim().to_string());
    }
    out
}
`,
      'utf8',
    );
    const discovery = rustGraphAdapter.discoverFiles({ cwd: dir });
    const parsed = rustGraphAdapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
      resolutionMode: 'exact',
    });
    const walked = rustGraphAdapter.walkProject({
      project: parsed.project,
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
    });
    const withSig = allOccurrences(walked).filter((o) => o.bodySignature !== undefined);
    expect(withSig.length).toBeGreaterThan(0);
    expect(withSig[0]?.bodySignature?.length).toBe(NEAR_DUP_SIGNATURE_K);
  });
});
