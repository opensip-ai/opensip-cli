/**
 * @fileoverview Keep live (TTY) runs executing OFF the main process (ADR-0028).
 *
 * The original defect (the one ADR-0028 fixes) is a CPU-heavy tool rendering its
 * live view while the *same* main thread runs the engine: the 80 ms clock + Ink
 * reconciler starve under each synchronous chunk and the spinner stutters. The
 * fix routes every tool's live runner through the off-thread selector
 * `runOffThreadOrInProcess` (core), which forks the engine to a headless worker
 * subcommand and keeps the render process free. Two regressions would silently
 * undo it, and neither has an import edge dependency-cruiser could catch:
 *
 *   1. A live runner (`*-runner.tsx`) calls the bare in-process transport
 *      (`createInProcessTransport(`) directly instead of `runOffThreadOrInProcess`
 *      — back to running the engine on the render thread.
 *   2. A worker entry (`*-worker.ts`) performs persistence (`persist*(`). Workers
 *      run off-process and must only COMPUTE; persistence (and cloud egress) stay
 *      on the parent, after the run, from the returned slim result. A worker that
 *      persists is doing parent-only work across the boundary (it may read the
 *      scope datastore for an in-build cache — that is fine; writing a *session*
 *      is not).
 *
 * This check closes both gaps with call-shape rules, scoped by `filePath` so the
 * legitimate in-process fallback INSIDE core (`subprocess-transport.ts`,
 * `in-process-transport.ts`) is exempt (it is not a `*-runner.tsx`).
 *
 * DETECTION — regex on `strip-strings-and-comments`-filtered content (NOT AST):
 * string literals AND comment/JSDoc bodies are blanked before `analyze` runs, so
 * the word "persists" in a doc-comment (including the worker headers this very
 * codebase ships) never false-fires; only real call expressions survive. The
 * shapes matched are purely local and lexical — no cross-statement reasoning,
 * type resolution, or scope analysis an AST would buy us.
 *
 * SCOPE — the filename conventions (`*-runner.tsx` for a tool's live view,
 * `*-worker.ts` for its headless engine entry) are opensip-tools' own; a consumer
 * that does not adopt them sees this check as a no-op. A genuine exception is
 * exempted per-file via `@fitness-ignore-file live-runs-off-thread` with a
 * justification comment.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

/** Test-file fragments — skipped (fixtures may exercise either transport). */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/** A tool's live-view renderer: `<tool>-runner.tsx`. */
const RUNNER_SUFFIX = '-runner.tsx';

/** A tool's headless engine worker entry: `<tool>-worker.ts`. */
const WORKER_SUFFIX = '-worker.ts';

/**
 * A direct call to the bare in-process transport. A live runner must drive the
 * engine through `runOffThreadOrInProcess` (which owns the in-process fallback
 * internally); calling `createInProcessTransport()` from a runner forces the
 * engine onto the render thread — the exact regression ADR-0028 forbids.
 */
const IN_PROCESS_TRANSPORT_CALL = /\bcreateInProcessTransport\s*\(/;

/**
 * A persistence call (`persistSession(` / `persistFitSession(` /
 * `persistSimSession(` …). Anchored on `persist` + an upper-case word + `(`, so
 * prose like "the parent persists" (already blanked by the content filter) and
 * an unrelated `persistence` identifier never match.
 */
const PERSIST_CALL = /\bpersist[A-Z]\w*\s*\(/;

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * logic without standing up the full Check framework. Operates on
 * `strip-strings-and-comments`-filtered content; `filePath` selects which
 * call-shape rule applies (runner vs worker).
 */
export function analyzeLiveRunsOffThread(content: string, filePath: string): CheckViolation[] {
  if (TEST_PATH.test(filePath)) return [];

  const isRunner = filePath.endsWith(RUNNER_SUFFIX);
  const isWorker = filePath.endsWith(WORKER_SUFFIX);
  if (!isRunner && !isWorker) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (isRunner && IN_PROCESS_TRANSPORT_CALL.test(line)) {
      violations.push({
        message:
          'Live runner calls the bare in-process transport (`createInProcessTransport`). ' +
          'The live (TTY) path must execute the engine OFF the main process so the ' +
          'spinner + 80ms clock never starve (ADR-0028).',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Drive the engine through `runOffThreadOrInProcess({ descriptor, inProcess })` ' +
          'from @opensip-tools/core — it forks the headless `<tool>-run-worker` and ' +
          'falls back to in-process itself (OPENSIP_TOOLS_NO_WORKER / fork failure). ' +
          'If this runner is genuinely a light, in-process-only view, add ' +
          '`@fitness-ignore-file live-runs-off-thread` with a justification comment.',
      });
    }
    if (isWorker && PERSIST_CALL.test(line)) {
      violations.push({
        message:
          'Worker entry performs persistence (`persist…(`). Off-process workers must ' +
          'only COMPUTE; persistence + egress run on the parent, after the run, from ' +
          'the returned result (ADR-0028).',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Return the slim result over IPC and persist it on the main process in the ' +
          'live runner (e.g. `persistFitSession` / `persistSession` after `run.result`). ' +
          'Reading the scope datastore for an in-build cache is fine — writing a session ' +
          'is not.',
      });
    }
  }
  return violations;
}

export const liveRunsOffThread = defineCheck({
  id: '22ee3ed4-80d2-44d4-8361-1307d60d5163',
  slug: 'live-runs-off-thread',
  description:
    'Live runners drive the engine off the main process; worker entries stay persistence-free (ADR-0028)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts', 'tsx'],
  // strip-strings-and-comments so call-shapes inside string literals or
  // comment/JSDoc bodies (e.g. a worker header noting "the parent persists")
  // never false-fire; only real call expressions survive.
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => analyzeLiveRunsOffThread(content, filePath),
});
