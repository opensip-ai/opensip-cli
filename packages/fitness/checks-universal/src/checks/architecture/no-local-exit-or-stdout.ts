/**
 * @fileoverview No local process.exit — exit codes flow through the one boundary.
 *
 * Release 2.12.0 (§4.7) converged process termination: NOTHING calls
 * `process.exit(n)` any more. Bootstrap guards throw a typed `BootstrapError`, and
 * the single top-level boundary sets `process.exitCode` once (letting the event
 * loop drain so telemetry/sessions flush). A stray `process.exit(n)` re-scatters
 * the control flow the release paid down — it skips the pending stderr flush, the
 * structured error outcome, and the `--json` path.
 *
 * This check flags `process.exit(` calls in the runtime packages (the sanctioned
 * mechanism is `process.exitCode = n`, which it does NOT flag). The MACHINE-output
 * stdout dimension of the §5.5 contract is owned by the sibling checks
 * `one-outcome-shape` (JSON must be a CommandOutcome) and
 * `no-direct-stdout-in-tool-engine` (tool engines own no stdout); this check owns
 * the exit-convergence half.
 *
 * `strip-strings-and-comments` keeps doc-comment/example mentions of
 * `process.exit` from false-firing; the check packs are excluded (they detect and
 * describe `process.exit` in user code).
 *
 * ALLOWANCE: the graph heap-preflight (`heap-preflight.ts`) is a subprocess-
 * relaunch WRAPPER — after raising NODE_OPTIONS it re-spawns the CLI and the
 * parent must terminate with the child's exact exit code. That is a genuine
 * `process.exit(code)` (the parent runs no event loop of its own to drain), so it
 * is allow-listed by basename.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/** A real `process.exit(...)` call (post strip-strings-and-comments). */
const PROCESS_EXIT_RE = /\bprocess\.exit\s*\(/

/** Check packs describe/detect process.exit in user code; excluded wholesale. */
const CHECK_PACK_PATH = /packages\/[^/]+\/checks-/

/** Subprocess-relaunch wrappers that must propagate a child's exact exit code. */
const ALLOWLISTED_BASENAMES: ReadonlySet<string> = new Set(['heap-preflight.ts'])

/** Tests legitimately spy on / drive process.exit. */
const TEST_PATH = /\.test\.tsx?$|\/__tests__\//

/** Pure analysis. Exported for unit tests. */
export function analyzeNoLocalExit(content: string): CheckViolation[] {
  const violations: CheckViolation[] = []
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
      })
    }
  }
  return violations
}

export const noLocalExitOrStdout = defineCheck({
  id: '60201712-a9c3-467d-b1db-c9ca53acf4dd',
  slug: 'no-local-exit-or-stdout',
  description: 'No local process.exit(); exit codes flow through the one boundary via process.exitCode (§4.7)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => {
    if (CHECK_PACK_PATH.test(filePath) || TEST_PATH.test(filePath)) return []
    if (ALLOWLISTED_BASENAMES.has(filePath.split('/').at(-1) ?? '')) return []
    return analyzeNoLocalExit(content)
  },
})
