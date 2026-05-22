/**
 * @fileoverview File-level fan-out (outbound coupling) check.
 *
 * Flags files that import many other intra-project files. High fan-out
 * indicates a "god-file" — a module that knows too much, hard to refactor
 * without ripple effects, hard for an AI agent to reason about because
 * search returns too many adjacent matches.
 *
 * Composition-root files (DI containers, plugin registries) legitimately
 * have high fan-out and can be exempted with
 * `// @fitness-ignore-file module-coupling-fan-out` at the top of the file.
 *
 * Pure barrel files (whose only top-level content is `export ... from`
 * re-exports) are auto-exempt. Re-exporting many modules is a barrel's
 * function — the "god-file" pathology applies to logic-bearing files,
 * not to public-API surfaces. If a barrel grows enormous, that's a
 * separate concern (warrants a "barrel-bloat" check, not this one).
 */

import { defineCheck, type CheckViolation, type FileAccessor, buildImportGraph } from '@opensip-tools/fitness'

const WARNING_THRESHOLD = 15
const ERROR_THRESHOLD = 30

/**
 * True if a file's only top-level content is `export ... from` re-exports.
 * Robust against block comments, line comments, and multi-line export
 * lists — but not a full parser. False negatives (treating a real barrel
 * as non-barrel) just leave the existing check behaviour; false positives
 * (treating a logic file as a barrel) would silently exempt a god-file.
 * The heuristic biases toward the safer false-negative side: any
 * non-re-export top-level statement (import, const, function, class,
 * interface, type X = …) flips the verdict to "not a barrel".
 */
function isBarrelFile(content: string): boolean {
  // Strip block comments and line comments first so prose can't fool the
  // top-level statement scan.
  const stripped = content
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    // eslint-disable-next-line sonarjs/slow-regex -- anchored line scan with bounded `.*`; no ReDoS exposure
    .replaceAll(/\/\/.*$/gm, '')

  // Collapse multi-line `export { a, b, c } from '...'` blocks onto one
  // logical line by joining lines that don't terminate a statement. Any
  // line that contains `from '` or `from "` is treated as a terminator.
  const logicalLines: string[] = []
  let buffer = ''
  for (const rawLine of stripped.split('\n')) {
    const line = rawLine.trim()
    /* v8 ignore next -- defensive guard */
    if (!line) continue
    buffer = buffer ? `${buffer} ${line}` : line
    if (line.includes(';') || / from ['"]/.test(line)) {
      logicalLines.push(buffer)
      buffer = ''
    }
  }
  if (buffer) logicalLines.push(buffer)

  /* v8 ignore next -- defensive AST/type guard */
  if (logicalLines.length === 0) return false

  // Every logical line must be a re-export. Anything else (import,
  // declaration, side-effect call) disqualifies.
  const reExportRe = /^export\s+(?:type\s+)?[*{]/
  return logicalLines.every((line) => reExportRe.test(line))
}

export const moduleCouplingFanOut = defineCheck({
  id: '4c2e1a8b-9f7d-4e3a-8b6c-1d0f2a3b4c5e',
  slug: 'module-coupling-fan-out',
  description: 'Flags files with high outbound import fan-out (god-files)',
  longDescription:
    `Counts each file's outbound intra-project imports. Files exceeding ${WARNING_THRESHOLD} ` +
    `imports get a warning; files exceeding ${ERROR_THRESHOLD} get an error. Composition ` +
    'roots (DI, plugin registries) legitimately exceed this — exempt them with ' +
    '`// @fitness-ignore-file module-coupling-fan-out` at the top of the file. ' +
    'Pure barrel files (only `export ... from` re-exports) are auto-exempt: ' +
    'fanning out is the barrel\'s job, not a god-file pathology.',
  scope: { languages: ['typescript', 'tsx', 'javascript', 'jsx'], concerns: ['backend', 'frontend', 'cli', 'shared'] },
  confidence: 'medium',
  tags: ['architecture', 'modularity'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const fileMap = await files.readAll()
    const graph = buildImportGraph(fileMap)

    const violations: CheckViolation[] = []
    for (const [filePath, edges] of graph.outbound) {
      const fanOut = edges.size
      if (fanOut <= WARNING_THRESHOLD) continue

      // Auto-exempt type-declaration files. `.d.ts` and `.test-d.ts`
      // files contain only type information that compiles to nothing —
      // their imports impose no runtime coupling cost.
      if (filePath.endsWith('.d.ts') || filePath.endsWith('.test-d.ts')) continue

      // Auto-exempt barrels. Re-export-only files have high fan-out by
      // design and never represent the "knows too much" pathology this
      // check targets.
      const content = fileMap.get(filePath)
      if (content !== undefined && isBarrelFile(content)) continue

      const severity: 'error' | 'warning' = fanOut > ERROR_THRESHOLD ? 'error' : 'warning'
      const limit = severity === 'error' ? ERROR_THRESHOLD : WARNING_THRESHOLD
      violations.push({
        severity,
        message: `High fan-out: ${fanOut} intra-project imports (limit ${limit}). High-fan-out files are hard to refactor and reason about.`,
        filePath,
        line: 1,
      })
    }

    // Sort for deterministic output: highest fan-out first.
    return violations.sort((a, b) => {
      /* v8 ignore next -- defensive nullish fallback */
      const aFan = graph.outbound.get(a.filePath ?? '')?.size ?? 0
      /* v8 ignore next -- defensive nullish fallback */
      const bFan = graph.outbound.get(b.filePath ?? '')?.size ?? 0
      return bFan - aFan
    })
  },
})
