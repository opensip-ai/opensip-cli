import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_INFLIGHT_GRACE_MS,
  DEFAULT_ARTIFACT_RETENTION_KEEP,
  pruneArtifactRetention,
} from '../artifact-retention.js';

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

/** Create one run dir at a precise mtime (seconds since epoch). */
function makeRunDirAt(artifactsDir: string, tool: string, name: string, mtimeSec: number): void {
  const dir = join(artifactsDir, tool, name);
  mkdirSync(dir, { recursive: true });
  utimesSync(dir, mtimeSec, mtimeSec);
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

  // A12: a concurrent in-flight run's dir must never be evicted by a peer's prune.
  describe('in-flight recency floor (A12)', () => {
    const NOW_MS = 2_000_000_000_000; // fixed wall clock for determinism
    const NOW_SEC = NOW_MS / 1000;

    it('never prunes a dir within the grace window even when it ranks past keep', () => {
      const artifactsDir = join(root, 'artifacts');
      // Three completed runs are "newest"; a slow CONCURRENT run's dir is recent
      // (within grace) but ranks below them; two genuinely-old runs are stale.
      makeRunDirAt(artifactsDir, 'gitleaks', 'recent-a', NOW_SEC - 1);
      makeRunDirAt(artifactsDir, 'gitleaks', 'recent-b', NOW_SEC - 2);
      makeRunDirAt(artifactsDir, 'gitleaks', 'recent-c', NOW_SEC - 3);
      makeRunDirAt(
        artifactsDir,
        'gitleaks',
        'concurrent',
        NOW_SEC - ARTIFACT_INFLIGHT_GRACE_MS / 1000 / 2,
      );
      makeRunDirAt(artifactsDir, 'gitleaks', 'old-1', NOW_SEC - 3600);
      makeRunDirAt(artifactsDir, 'gitleaks', 'old-2', NOW_SEC - 7200);

      // keep=1 would normally leave a single newest dir; the floor retains EVERY
      // within-grace dir (incl. the low-ranked concurrent one) and prunes only the
      // genuinely-old ones.
      pruneArtifactRetention('gitleaks', artifactsDir, 1, { now: NOW_MS });

      expect(readdirSync(join(artifactsDir, 'gitleaks')).sort()).toEqual([
        'concurrent',
        'recent-a',
        'recent-b',
        'recent-c',
      ]);
    });

    it('never prunes the current run dir even when it ranks oldest and is outside the grace window', () => {
      const artifactsDir = join(root, 'artifacts');
      // The current run's dir is the OLDEST (outside grace), so only the runId skip
      // — not the grace floor — can protect it.
      makeRunDirAt(artifactsDir, 'trivy', 'current', NOW_SEC - 100_000);
      makeRunDirAt(artifactsDir, 'trivy', 'older-1', NOW_SEC - 90_000);
      makeRunDirAt(artifactsDir, 'trivy', 'newest', NOW_SEC - 80_000);

      pruneArtifactRetention('trivy', artifactsDir, 1, { now: NOW_MS, currentRunId: 'current' });

      // `newest` is kept by rank; `current` is kept by the runId skip; `older-1`
      // (past keep, outside grace, not current) is the only one pruned.
      expect(readdirSync(join(artifactsDir, 'trivy')).sort()).toEqual(['current', 'newest']);
    });

    it('still prunes within-keep+stale dirs when nothing is in flight (no false retention)', () => {
      const artifactsDir = join(root, 'artifacts');
      makeRunDirAt(artifactsDir, 'osv-scanner', 'r1', NOW_SEC - 100_000);
      makeRunDirAt(artifactsDir, 'osv-scanner', 'r2', NOW_SEC - 90_000);
      makeRunDirAt(artifactsDir, 'osv-scanner', 'r3', NOW_SEC - 80_000);

      pruneArtifactRetention('osv-scanner', artifactsDir, 1, { now: NOW_MS });

      expect(readdirSync(join(artifactsDir, 'osv-scanner')).sort()).toEqual(['r3']);
    });
  });
});
