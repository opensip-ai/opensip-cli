/**
 * Child-process driver for the REAL `node:inspector` CPU-profiler path.
 *
 * Why a subprocess: Node's CPU profiler is process-global and inspector-based,
 * which races with `@vitest/coverage-v8` (also inspector-based) when both run in
 * the same process. In-process that race corrupts coverage-v8's data collection
 * for profiling.ts non-deterministically (the file's branch coverage flickers
 * between runs). Driving the real profiler in an UNINSTRUMENTED child process
 * removes the contention entirely, so the in-process suite measures profiling.ts
 * coverage deterministically via the fake-session unit tests, while THIS driver
 * still proves the genuine `node:inspector` wiring end-to-end.
 *
 * Mirrors the established cli pattern: behaviour that can't be observed under
 * in-process instrumentation (subprocess execution) is verified by spawning a
 * real process and asserting on its side effects.
 *
 * Usage: node real-profiler-driver.mjs <mode> <profilesBaseDir>
 *   mode = "project"  → project-scoped RunScope (runId RUN_PROF_1, command fit:run);
 *                       profiles land under projectRoot/opensip-cli/.runtime/profiles
 *   mode = "noscope"  → RunScope without projectContext (runId RUN_NO_PROJECT, no command);
 *                       exercises the cwd-fallback storage branch + default "unknown" command
 * Exits 0 on success (artifacts written), non-zero with a diagnostic on failure.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
const baseDir = process.argv[3];

if (!mode || !baseDir) {
  process.stderr.write('usage: real-profiler-driver.mjs <project|noscope> <profilesBaseDir>\n');
  process.exit(2);
}

// The driver lives at packages/cli/src/telemetry/__tests__/fixtures/ → the built
// module is at packages/cli/dist/telemetry/profiling.js.
const profilingUrl = new URL('../../../../dist/telemetry/profiling.js', import.meta.url);
const { startProfiling, stopProfiling } = await import(profilingUrl.href);

// Open the profiling gate for this child.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318/v1/traces';
process.env.OPENSIP_PROFILING = '1';

// Profiles land under <baseDir>/opensip-cli/.runtime/profiles when project-scoped
// (projectRoot=baseDir) or under cwd/.runtime/profiles for the noscope case
// (we chdir to baseDir so both modes write under the same observable dir).
mkdirSync(baseDir, { recursive: true });
process.chdir(baseDir);

const profilesDir = fileURLToPath(new URL('opensip-cli/.runtime/profiles/', `file://${baseDir}/`));

// project: project-scoped (profiles under projectRoot). noscope: a scope WITHOUT
// projectContext so the cwd-fallback storage branch runs (we chdir to baseDir),
// while still carrying a runId so the artifact filename is assertable.
const scope =
  mode === 'project'
    ? {
        runId: 'RUN_PROF_1',
        projectContext: { scope: 'project', projectRoot: baseDir },
        telemetry: {},
      }
    : { runId: 'RUN_NO_PROJECT', telemetry: {} };
const command = mode === 'project' ? 'fit:run' : undefined;

function hasArtifact(suffix) {
  try {
    return readdirSync(profilesDir).some((f) => f.endsWith(suffix));
  } catch {
    return false;
  }
}

async function waitFor(pred, ms = 8000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 15));
  }
  return true;
}

startProfiling(scope, command);

// The labels sidecar is written from the async Profiler.start callback.
if (!(await waitFor(() => existsSync(profilesDir) && hasArtifact('.labels.json')))) {
  process.stderr.write('timed out waiting for labels sidecar\n');
  process.exit(3);
}

// A little CPU work so the profiler captures samples before we stop.
let acc = 0;
for (let i = 0; i < 1e6; i++) acc += Math.sqrt(i);
if (!(acc > 0)) {
  process.stderr.write('cpu work produced no accumulation\n');
  process.exit(4);
}

stopProfiling(scope);

// The .cpuprofile is written from the async Profiler.stop callback.
if (!(await waitFor(() => hasArtifact('.cpuprofile')))) {
  process.stderr.write('timed out waiting for .cpuprofile\n');
  process.exit(5);
}

process.stdout.write('ok\n');
process.exit(0);
