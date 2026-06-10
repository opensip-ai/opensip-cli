/**
 * @fileoverview Machine output must be a CommandOutcome, not a bare shape (§5.5).
 *
 * Release 2.12.0 made `CommandOutcome<T>` the one outer currency: every `--json`
 * result and error is serialized through the single `renderOutcome` seam, with the
 * (unchanged) `SignalEnvelope` under `.envelope`, a `CommandResult` under `.data`,
 * and structured `errors`. Two drift shapes are now forbidden:
 *
 *   1. The bare `emitJson({ error })` error object — retired in favour of the
 *      `cli.emitError` seam, which wraps a `status:'error'` outcome.
 *   2. A direct `process.stdout.write(JSON.stringify(...))` /
 *      `process.stdout.write(formatSignalJson(...))` — machine output must go
 *      through `renderOutcome`, the one serialization point, so the outer shape
 *      cannot re-drift per command.
 *
 * `strip-strings-and-comments` keeps the many doc-comment/example mentions of
 * these shapes from false-firing; the check packs are excluded (they describe the
 * patterns). The one sanctioned stdout-JSON writer, `render-outcome.ts`, is
 * allow-listed.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

const CHECK_PACK_PATH = /packages\/[^/]+\/checks-/;

/** Tests construct bare shapes / capture emit calls as fixtures. */
const TEST_PATH = /\.test\.tsx?$|\/__tests__\//;

/** The one sanctioned stdout JSON serialization site. */
const RENDER_OUTCOME_BASENAME = 'render-outcome.ts';

/**
 * Subprocess IPC writers whose stdout JSON is a wire protocol read by a parent,
 * not user-facing command output (already exempted by no-direct-stdout-in-tool-
 * engine). The shard-worker writes one JSON document the orchestrator reads to EOF.
 */
const IPC_BASENAMES: ReadonlySet<string> = new Set(['shard-worker.ts']);

interface OutcomeRule {
  readonly re: RegExp;
  readonly message: string;
  readonly suggestion: string;
  /** When true, the rule is skipped in the render-outcome.ts allow-listed file. */
  readonly allowInRenderer: boolean;
}

const RULES: readonly OutcomeRule[] = [
  {
    re: /\bemitJson\s*\(\s*\{\s*error\b/,
    message:
      'Bare `emitJson({ error })` is retired (§5.5): a failed --json run must emit a ' +
      'structured status:error CommandOutcome.',
    suggestion: 'Call cli.emitError({ message, exitCode, suggestion? }) instead.',
    allowInRenderer: false,
  },
  {
    re: /\bprocess\.stdout\.write\s*\([^)]*\b(?:JSON\.stringify|formatSignalJson)\s*\(/,
    message:
      'Machine JSON output must go through the single renderOutcome seam (§5.5), not a ' +
      'direct process.stdout.write — otherwise the outer CommandOutcome shape re-drifts.',
    suggestion: 'Build a CommandOutcome and render it via renderOutcome / the cli emit seams.',
    allowInRenderer: true,
  },
];

/** Pure analysis. `isRenderer` exempts the rules flagged `allowInRenderer`. Exported for tests. */
export function analyzeOneOutcomeShape(content: string, isRenderer: boolean): CheckViolation[] {
  const violations: CheckViolation[] = [];
  for (const [i, line] of content.split('\n').entries()) {
    for (const rule of RULES) {
      if (rule.allowInRenderer && isRenderer) continue;
      if (rule.re.test(line)) {
        violations.push({
          message: rule.message,
          suggestion: rule.suggestion,
          severity: 'error',
          line: i + 1,
        });
      }
    }
  }
  return violations;
}

export const oneOutcomeShape = defineCheck({
  id: 'c10e25f5-9b99-4b46-a372-7c0e420dc5c2',
  slug: 'one-outcome-shape',
  description:
    'Machine output must be a CommandOutcome via renderOutcome, not a bare {error} / raw JSON (§5.5)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => {
    if (CHECK_PACK_PATH.test(filePath) || TEST_PATH.test(filePath)) return [];
    const basename = filePath.split('/').at(-1) ?? '';
    if (IPC_BASENAMES.has(basename)) return [];
    return analyzeOneOutcomeShape(content, basename === RENDER_OUTCOME_BASENAME);
  },
});
