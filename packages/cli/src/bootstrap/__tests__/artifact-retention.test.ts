import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ARTIFACT_RETENTION_KEEP, pruneArtifactRetention } from '../artifact-retention.js';

let root = '';

/** Create `<artifactsDir>/<tool>/<name>` run dirs with strictly increasing mtimes. */
function makeRunDirs(artifactsDir: string, tool: string, names: string[]): void {
  const toolDir = join(artifactsDir, tool);
  names.forEach((name, index) => {
    const dir = join(toolDir, name);
    mkdirSync(dir, { recursive: true });
    const seconds = 1_700_000_000 + index * 100; // earlier index ⇒ older
    utimesSync(dir, seconds, seconds);
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifact-retention-'));
});

afterEach(() => {
  if (root.length > 0) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('pruneArtifactRetention', () => {
  it('keeps the N most-recent run dirs and removes the older ones', () => {
    const artifactsDir = join(root, 'artifacts');
    makeRunDirs(artifactsDir, 'gitleaks', ['r1', 'r2', 'r3', 'r4', 'r5']);

    pruneArtifactRetention('gitleaks', artifactsDir, 2);

    // r4 + r5 are the two newest (largest mtime) ⇒ retained.
    expect(readdirSync(join(artifactsDir, 'gitleaks')).sort()).toEqual(['r4', 'r5']);
  });

  it('is a no-op when the per-tool dir is missing', () => {
    const artifactsDir = join(root, 'artifacts');
    expect(() => pruneArtifactRetention('never-ran', artifactsDir, 2)).not.toThrow();
  });

  it('is disabled (no-op) when keep <= 0', () => {
    const artifactsDir = join(root, 'artifacts');
    makeRunDirs(artifactsDir, 'gitleaks', ['r1', 'r2', 'r3']);

    pruneArtifactRetention('gitleaks', artifactsDir, 0);

    expect(readdirSync(join(artifactsDir, 'gitleaks')).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('ignores non-directory entries under the tool dir', () => {
    const artifactsDir = join(root, 'artifacts');
    makeRunDirs(artifactsDir, 'gitleaks', ['r1', 'r2']);
    // A stray file directly under <tool>/ is not a run dir and must survive.
    writeFileSync(join(artifactsDir, 'gitleaks', 'stray.txt'), 'x');

    pruneArtifactRetention('gitleaks', artifactsDir, 1);

    expect(readdirSync(join(artifactsDir, 'gitleaks')).sort()).toEqual(['r2', 'stray.txt']);
  });

  it('keeps everything when there are fewer run dirs than keep', () => {
    const artifactsDir = join(root, 'artifacts');
    makeRunDirs(artifactsDir, 'trivy', ['r1', 'r2']);

    pruneArtifactRetention('trivy', artifactsDir, 10);

    expect(readdirSync(join(artifactsDir, 'trivy')).sort()).toEqual(['r1', 'r2']);
  });

  it('exposes a default retention of 10', () => {
    expect(DEFAULT_ARTIFACT_RETENTION_KEEP).toBe(10);
  });
});
