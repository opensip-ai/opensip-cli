// @fitness-ignore-file no-skipped-tests -- this file's job is to detect skip/focus idioms; the patterns appear in regex and JSDoc by design
/**
 * @fileoverview Cross-language skipped / focused / placeholder test detection.
 *
 * Detects disabled (`.skip`, `@Disabled`, `#[ignore]`, `t.Skip`),
 * focused (`.only`, `fit(`, `fdescribe(`), and placeholder (`it.todo`)
 * tests across JS/TS, Python, Go, Rust, and Java test files. Disabled or
 * abandoned test work silently erodes coverage; a `.only` is the most
 * dangerous of all because it silences every OTHER test in the suite.
 *
 * INVERSION: unlike most checks (which skip test files), this check ONLY
 * applies to test files — `if (!isTestFile(filePath)) return []`.
 *
 * Uses the `strip-strings-and-comments` content filter so the idioms are
 * matched as live CODE only, never as text inside a description string
 * (`it('should skip empty input', ...)`) or a comment (`fit (checks/recipes)`
 * in prose, or a commented-out `// it.skip(...)`). Both classes would
 * otherwise false-fire — comments especially for `fit(` / `xit(`, which are
 * also ordinary English words.
 *
 * Supersedes the former TS-only `no-focused-tests` check (its `.only` / `fit(`
 * / `fdescribe(` detection is folded in here); the slug and id are retained
 * so the dogfood baseline stays continuous.
 */
import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'

/** A skip/focus idiom: its detection regex and the violation it yields. */
interface SkipIdiom {
  /** Regex (with `g` flag) matched against each stripped source line. */
  readonly pattern: RegExp
  /** Human-readable name of the idiom, used in the violation message. */
  readonly label: string
  /** Whether this idiom FOCUSES (disables all other tests) vs. merely skips one. */
  readonly focused: boolean
}

const SUGGESTION =
  'Re-enable the test or remove it; track the reason in an issue. ' +
  '`.only` must never ship — it silences the rest of the suite.'

const FOCUSED_SUGGESTION =
  'A focused test disables EVERY OTHER test in the file. Remove the focus ' +
  '(`.only` / `fit(` / `fdescribe(`) before committing — it must never ship.'

// JS/TS — vitest / jest / mocha / playwright. Method-call forms (`.skip(`,
// `.only(`, `.todo(`, `.concurrent.skip(`) plus the word-boundary call forms
// (`xit(`, `fit(`, ...).
const JS_IDIOMS: readonly SkipIdiom[] = [
  { pattern: /\b(?:it|test|describe|context|suite|bench)(?:\.concurrent)?\.only\b/g, label: '.only focused test', focused: true },
  { pattern: /\b(?:it|test|describe|context|suite|bench)(?:\.concurrent)?\.skip\b/g, label: '.skip skipped test', focused: false },
  { pattern: /\b(?:it|test)\.todo\b/g, label: '.todo placeholder test', focused: false },
  { pattern: /\bfit\s*\(/g, label: 'fit() focused test', focused: true },
  { pattern: /\bfdescribe\s*\(/g, label: 'fdescribe() focused suite', focused: true },
  { pattern: /\bxit\s*\(/g, label: 'xit() skipped test', focused: false },
  { pattern: /\bxtest\s*\(/g, label: 'xtest() skipped test', focused: false },
  { pattern: /\bxdescribe\s*\(/g, label: 'xdescribe() skipped suite', focused: false },
]

// Python — pytest / unittest.
const PY_IDIOMS: readonly SkipIdiom[] = [
  { pattern: /@pytest\.mark\.skipif\b/g, label: '@pytest.mark.skipif', focused: false },
  { pattern: /@pytest\.mark\.skip\b/g, label: '@pytest.mark.skip', focused: false },
  { pattern: /@unittest\.expectedFailure\b/g, label: '@unittest.expectedFailure', focused: false },
  { pattern: /@unittest\.skip\b/g, label: '@unittest.skip', focused: false },
  { pattern: /\bself\.skipTest\s*\(/g, label: 'self.skipTest()', focused: false },
  { pattern: /\bpytest\.skip\s*\(/g, label: 'pytest.skip()', focused: false },
]

// Go — testing.T skip APIs.
const GO_IDIOMS: readonly SkipIdiom[] = [
  { pattern: /\bt\.SkipNow\s*\(/g, label: 't.SkipNow()', focused: false },
  { pattern: /\bt\.Skipf\s*\(/g, label: 't.Skipf()', focused: false },
  { pattern: /\bt\.Skip\s*\(/g, label: 't.Skip()', focused: false },
]

// Rust — the #[ignore] test attribute.
const RUST_IDIOMS: readonly SkipIdiom[] = [
  { pattern: /#\[\s*ignore\b/g, label: '#[ignore] test attribute', focused: false },
]

// Java — JUnit 5 (@Disabled) / JUnit 4 (@Ignore).
const JAVA_IDIOMS: readonly SkipIdiom[] = [
  { pattern: /@Disabled\b/g, label: '@Disabled', focused: false },
  { pattern: /@Ignore\b/g, label: '@Ignore', focused: false },
]

/** Map a file extension (no leading dot) to its idiom set. */
function idiomsForExtension(filePath: string): readonly SkipIdiom[] {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs': {
      return JS_IDIOMS
    }
    case 'py': {
      return PY_IDIOMS
    }
    case 'go': {
      return GO_IDIOMS
    }
    case 'rs': {
      return RUST_IDIOMS
    }
    case 'java': {
      return JAVA_IDIOMS
    }
    default: {
      return []
    }
  }
}

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * logic without standing up the full Check framework. `content` is expected
 * to be the `strip-strings`-filtered source so that idiom-like words inside
 * description string literals don't false-fire; `filePath` selects the
 * language idiom set (the caller is responsible for the `isTestFile` gate).
 */
export function analyzeSkippedTests(content: string, filePath: string): CheckViolation[] {
  const idioms = idiomsForExtension(filePath)
  if (idioms.length === 0) return []

  const violations: CheckViolation[] = []
  const lines = content.split('\n')
  for (const [i, line] of lines.entries()) {
    for (const idiom of idioms) {
      idiom.pattern.lastIndex = 0
      if (idiom.pattern.test(line)) {
        violations.push({
          message: idiom.focused
            ? `Focused test detected (${idiom.label}) — it disables every other test in the file`
            : `Skipped/placeholder test detected (${idiom.label})`,
          // Soft shipped default; repos wanting a hard gate set `failOnWarnings`
          // (this repo does — see opensip-tools.config.yml).
          severity: 'warning',
          line: i + 1,
          suggestion: idiom.focused ? FOCUSED_SUGGESTION : SUGGESTION,
        })
      }
    }
  }
  return violations
}

/**
 * Check: testing/no-skipped-tests
 *
 * Detects skipped, focused, or placeholder tests across JS/TS, Python, Go,
 * Rust, and Java. Test-files-only (the inverse of most checks).
 */
export const noSkippedTests = defineCheck({
  id: '6d58546e-7335-42da-94f3-abb015e3a4c0',
  slug: 'no-skipped-tests',
  scope: { languages: [], concerns: ['testing'] },
  description: 'Tests must never ship skipped, focused (.only), or placeholder',
  longDescription: `**Purpose:** Surfaces disabled, focused, and placeholder tests so they are re-enabled or removed rather than left to silently erode coverage. A committed \`.only\` is the most dangerous case — it silences every other test in the file and gives a false green CI signal.

**Detects (test files only, by extension):**
- **JS/TS** — \`.only\` / \`.skip\` / \`.todo\` (incl. \`.concurrent.*\`) on \`it\`/\`test\`/\`describe\`/\`context\`/\`suite\`/\`bench\`, plus \`fit(\`, \`fdescribe(\`, \`xit(\`, \`xtest(\`, \`xdescribe(\`
- **Python** — \`@pytest.mark.skip\`/\`skipif\`, \`@unittest.skip\`/\`expectedFailure\`, \`self.skipTest(\`, \`pytest.skip(\`
- **Go** — \`t.Skip(\`, \`t.Skipf(\`, \`t.SkipNow(\`
- **Rust** — the \`#[ignore]\` test attribute
- **Java** — \`@Disabled\` (JUnit 5), \`@Ignore\` (JUnit 4)

**Why it matters:** Skipped tests accumulate as dead code and silently reduce effective coverage; focused tests cause CI to run only the focused test while the rest of the suite is silently skipped.

**Scope:** Cross-language best practice. Uses the \`strip-strings-and-comments\` filter so idiom-like words inside description strings (e.g. \`it('should skip empty input')\`) and comments (e.g. \`fit(\` in prose, or a commented-out \`// it.skip(...)\`) do not false-fire. Targets test files only.`,
  tags: ['quality', 'testing', 'ci-blocking'],
  fileTypes: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'java', 'rs'],
  // Match the skip idioms as live CODE only — never inside a description
  // string (`it('should skip empty input', ...)`) or a comment (`fit(` / `xit(`
  // are ordinary English words that recur in prose and commented-out tests).
  contentFilter: 'strip-strings-and-comments',
  confidence: 'high',
  analyze: (content, filePath) => {
    // INVERSION: this hygiene rule applies ONLY to test files. A skip idiom
    // in production code is not this check's concern.
    if (!isTestFile(filePath)) return []
    return analyzeSkippedTests(content, filePath)
  },
})
