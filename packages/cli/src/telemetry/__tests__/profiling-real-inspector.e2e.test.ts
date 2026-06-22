/**
 * Genuine end-to-end verification of the REAL `node:inspector` CPU-profiler path
 * — driven in a CHILD PROCESS, not in-process.
 *
 * Node's CPU profiler is process-global and inspector-based; in-process it races
 * with `@vitest/coverage-v8` (also inspector-based), corrupting coverage-v8's
 * data collection for profiling.ts non-deterministically. Even though the real
 * profiler runs in an UNINSTRUMENTED child here, the blocking `spawnSync` was
 * observed to still poison the PARENT worker's precise-coverage counters for
 * profiling.ts (the start/stop callback arms exercised by the deterministic
 * fake-session unit tests in `profiling.test.ts` were intermittently dropped,
 * flickering the cli package below its branch floor).
 *
 * The fix is process isolation at the FILE level: this real-inspector suite lives
 * in its OWN test file so vitest runs it in a SEPARATE worker (the `forks` pool
 * isolates each test file). The deterministic branch coverage of profiling.ts
 * comes entirely from the fake-session unit tests in `profiling.test.ts`; this
 * file only proves the genuine wiring (real Session → real .cpuprofile + labels
 * sidecar) and contributes nothing to in-process coverage by design.
 *
 * The build must exist (the driver imports the compiled dist module) — the same
 * precondition as e2e.test.ts.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ost-profiling-e2e-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function profilesDir(): string {
  return join(tmp, 'opensip-cli/.runtime/profiles');
}

function readdir(): string[] {
  try {
    return readdirSync(profilesDir());
  } catch {
    return [];
  }
}
function readdirHasCpuprofile(): boolean {
  return readdir().some((f) => f.endsWith('.cpuprofile'));
}
function readdirHasLabels(): boolean {
  return readdir().some((f) => f.endsWith('.labels.json'));
}
function labelsFile(): string {
  const f = readdir().find((x) => x.endsWith('.labels.json'));
  if (!f) throw new Error('no labels file');
  return join(profilesDir(), f);
}

describe('CPU profiling — real inspector session (uninstrumented child process)', () => {
  const driver = fileURLToPath(new URL('fixtures/real-profiler-driver.mjs', import.meta.url));

  function runDriver(mode: 'project' | 'noscope'): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [driver, mode, tmp], {
      encoding: 'utf8',
      // No coverage instrumentation in the child; generous cap for a real profile.
      timeout: 30_000,
    });
  }

  it('writes a real .cpuprofile + labels sidecar across a project-scoped start → stop', () => {
    const res = runDriver('project');
    expect(res.status, `driver stderr: ${res.stderr}`).toBe(0);

    expect(readdirHasCpuprofile()).toBe(true);
    expect(readdirHasLabels()).toBe(true);
    const labels = JSON.parse(readFileSync(labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.runId).toBe('RUN_PROF_1');
    expect(labels.command).toBe('fit:run');
    expect(labels.service).toBe('opensip-cli');
  });

  it('uses cwd profile storage and default command labels outside project scope', () => {
    const res = runDriver('noscope');
    expect(res.status, `driver stderr: ${res.stderr}`).toBe(0);

    const files = readdir();
    expect(files.some((file) => file.includes('-cli-RUN_NO_PROJECT.'))).toBe(true);
    expect(files.some((file) => file.endsWith('.cpuprofile'))).toBe(true);
    const labels = JSON.parse(readFileSync(labelsFile(), 'utf8')) as Record<string, unknown>;
    expect(labels.runId).toBe('RUN_NO_PROJECT');
    expect(labels.command).toBe('unknown');
  });
});
