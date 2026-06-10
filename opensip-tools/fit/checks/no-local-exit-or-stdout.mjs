/**
 * @fileoverview no-local-exit-or-stdout — exit codes flow through the one
 *               boundary, not local process.exit (§4.7). Project-local SELF-check.
 *
 * Relocated out of `@opensip-tools/checks-universal` (where it shipped 2.12.0–2.12.x):
 * the PRINCIPLE (drain before exit via `process.exitCode`) is sound, but this
 * check encodes opensip-tools' OWN §4.7 convergence — it forbids `process.exit()`
 * outright and points violators at opensip-tools' typed `BootstrapError`/`ToolError`
 * and single-top-level-boundary model. A consumer with a different (equally valid)
 * termination architecture — e.g. a sanctioned process-exit wrapper package — does
 * not share that model, so the check is tool-internal, not universal. It lives
 * here as a dogfood self-check rather than in the shipped pack.
 *
 * Release 2.12.0 (§4.7) converged process termination: NOTHING calls
 * `process.exit(n)`. Bootstrap guards throw a typed `BootstrapError`, and the
 * single top-level boundary sets `process.exitCode` once (letting the event loop
 * drain so telemetry/sessions flush). A stray `process.exit(n)` re-scatters the
 * control flow the release paid down — it skips the pending stderr flush, the
 * structured error outcome, and the `--json` path.
 *
 * `strip-strings-and-comments` keeps doc-comment/example mentions from
 * false-firing; the check packs (`checks-*`) are excluded (they detect and
 * describe `process.exit` in user code); tests are excluded (they spy on it).
 *
 * ALLOWANCE: the graph heap-preflight (`heap-preflight.ts`) is a subprocess-
 * relaunch WRAPPER — after raising NODE_OPTIONS it re-spawns the CLI and the
 * parent must terminate with the child's exact exit code (it runs no event loop
 * of its own to drain), so it is allow-listed by basename.
 */
import { defineCheck } from '@opensip-tools/fitness';

/** A real `process.exit(...)` call (post strip-strings-and-comments). */
const PROCESS_EXIT_RE = /\bprocess\.exit\s*\(/;

/** Check packs describe/detect process.exit in user code; excluded wholesale. */
const CHECK_PACK_PATH = /packages\/[^/]+\/checks-/;

/** Subprocess-relaunch wrappers that must propagate a child's exact exit code. */
const ALLOWLISTED_BASENAMES = new Set(['heap-preflight.ts']);

/** Tests legitimately spy on / drive process.exit. */
const TEST_PATH = /\.test\.tsx?$|\/__tests__\//;

/** Pure analysis. Exported so the dogfood-integration test can exercise it. */
export function analyzeNoLocalExit(content) {
  const violations = [];
  for (const [i, line] of content.split('\n').entries()) {
    if (PROCESS_EXIT_RE.test(line)) {
      violations.push({
        message:
          'No process.exit() (§4.7): exit codes flow through the single top-level ' +
          'boundary via `process.exitCode`, so the event loop drains (telemetry / ' +
          'session flush) and the structured error outcome + --json path are honoured.',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Set `process.exitCode = n` at the boundary, or throw a typed error ' +
          '(BootstrapError / ToolError) for the boundary to render and map.',
      });
    }
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '60201712-a9c3-467d-b1db-c9ca53acf4dd',
    slug: 'no-local-exit-or-stdout',
    description:
      'No local process.exit(); exit codes flow through the one boundary via process.exitCode (§4.7)',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'quality'],
    fileTypes: ['ts', 'tsx'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => {
      if (CHECK_PACK_PATH.test(filePath) || TEST_PATH.test(filePath)) return [];
      if (ALLOWLISTED_BASENAMES.has(filePath.split('/').at(-1) ?? '')) return [];
      return analyzeNoLocalExit(content);
    },
  }),
];
