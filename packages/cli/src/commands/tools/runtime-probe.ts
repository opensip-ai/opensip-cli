/**
 * runtime-probe — the parent-process side of `tools validate`'s runtime
 * sections (ADR-0041).
 *
 * Spawns `runtime-probe-entry.js` (compiled sibling in dist) against a staged
 * candidate dir with a hard timeout. The child dynamic-imports the candidate —
 * the subprocess is a CRASH/CONTAMINATION boundary (a throwing module
 * top-level, a hang, a process.env mutation cannot touch the parent), NOT a
 * security boundary (same user privileges; ADR-0041's trust posture applies).
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { AdmissionSectionResult } from '../../bootstrap/admit-tool-package.js';

/** The slim, JSON-serializable report the probe child prints. */
export interface ProbeReport {
  readonly ok: boolean;
  readonly sections: readonly AdmissionSectionResult[];
  /** The runtime `Tool.config.namespace`; `null` = the tool declares no config. */
  readonly toolConfigNamespace: string | null;
  /** The runtime tool id, when the tool loaded. */
  readonly toolId: string | null;
}

/** Hard ceiling on candidate module-load time (a hung import must not hang the CLI). */
export const PROBE_TIMEOUT_MS = 30_000;

/** Resolved against THIS module's location, so it works from dist and when packed. */
const PROBE_ENTRY = fileURLToPath(new URL('runtime-probe-entry.js', import.meta.url));

/**
 * Run the runtime admission sections against `packageDir` in a child process.
 * Never throws: a crash/timeout/unparseable child maps to a synthetic failed
 * `runtime-load` section carrying the child's stderr as diagnostic.
 */
export function runRuntimeProbe(packageDir: string): ProbeReport {
  const child = spawnSync(process.execPath, [PROBE_ENTRY, packageDir], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const failed = (diagnostic: string): ProbeReport => ({
    ok: false,
    sections: [{ section: 'runtime-load', ok: false, diagnostic }],
    toolConfigNamespace: null,
    toolId: null,
  });

  if (child.error !== undefined) {
    const timedOut = (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    return failed(
      timedOut
        ? `runtime probe timed out after ${PROBE_TIMEOUT_MS}ms (the module load hung)`
        : `runtime probe failed to spawn: ${child.error.message}`,
    );
  }
  const stdout = (child.stdout ?? '').trim();
  if (stdout.length === 0) {
    const stderr = (child.stderr ?? '').trim();
    return failed(
      stderr.length > 0
        ? `runtime probe crashed: ${stderr.slice(0, 500)}`
        : 'runtime probe produced no report',
    );
  }
  try {
    return JSON.parse(stdout.split('\n').at(-1) ?? '') as ProbeReport;
  } catch {
    return failed(`runtime probe printed an unparseable report: ${stdout.slice(0, 200)}`);
  }
}
