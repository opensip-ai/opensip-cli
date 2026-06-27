/**
 * runtime-probe — the parent side of `tools validate`'s runtime sections
 * (ADR-0041). It spawns the compiled probe entry against a candidate dir and
 * NEVER throws: a child that prints nothing (and writes to stderr) becomes a
 * synthetic failed `runtime-load` section carrying the child's stderr; a child
 * that prints a parseable report is returned verbatim. Drives the dist probe
 * (the suites require a build, like every dist-spawning e2e here).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PROBE_TIMEOUT_MS, runRuntimeProbe } from '../commands/tools/runtime-probe.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('runRuntimeProbe', () => {
  it('exposes a sane hard timeout ceiling', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('maps a child that writes only to stderr (no report) to a failed runtime-load section', () => {
    // An empty dir argument makes the probe entry print a "missing package dir"
    // message to stderr and exit without a stdout report → the "crashed" branch.
    const report = runRuntimeProbe('');
    expect(report.ok).toBe(false);
    expect(report.toolId).toBeNull();
    expect(report.toolConfigNamespace).toBeNull();
    expect(report.sections).toHaveLength(1);
    expect(report.sections[0]).toMatchObject({ section: 'runtime-load', ok: false });
    expect(report.sections[0]?.diagnostic).toMatch(/runtime probe/);
  });

  it('returns a parseable report for a dir with no manifest (ok:false, no throw)', () => {
    // A real (empty) package dir: admission runs, finds no manifest, and the
    // child still prints a valid JSON report — the happy parse path with ok:false.
    const dir = mkdtempSync(join(tmpdir(), 'ost-probe-empty-'));
    tmpDirs.push(dir);
    const report = runRuntimeProbe(dir);
    expect(report.ok).toBe(false);
    expect(Array.isArray(report.sections)).toBe(true);
  });

});
