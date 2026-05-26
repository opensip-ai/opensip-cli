/**
 * @fileoverview security/cli-realpath-validation — within the trees that
 * own filesystem-input validation (`packages/cli/src/` and
 * `packages/core/src/plugins/`), forbid the legacy
 * `<filePath>.startsWith(<projectRoot>)` shape. It is bypassable via
 * symlinks, trailing-slash edge cases, and Windows path normalisation
 * — exactly the vectors the 2026-05-25 plugin-discovery audit flagged.
 *
 * Why it matters: the audit replaced startsWith-style guards with
 * `realpathSync` + `path.relative` (or the local `isPathInside`
 * helper) so symlink-based escapes are caught. This check is the
 * regression gate — if a contributor reintroduces the legacy guard
 * shape, fit fails.
 *
 * The rule is intentionally narrow: only the conventional filesystem-
 * root variable names (`projectRoot`, `rootDir`, `repoRoot`, `baseDir`,
 * `cwd`, `workspaceRoot`, `packageDir`, `parent`) trigger. Variable
 * names like `prefix` or `routePath` that legitimately use `startsWith`
 * for non-path checks are not in the list.
 *
 * Confidence: high (narrow scope, narrow trigger).
 *
 * Inspired by `opensip-ai/opensip/opensip-tools` `arch-cli-realpath-validation`.
 */

import { defineCheck, isTestFile, type CheckViolation } from '@opensip-tools/fitness'

const SCOPED_PATH_SEGMENTS: readonly string[] = [
  'packages/cli/src/',
  'packages/core/src/plugins/',
]

// `<root-name>.startsWith(...)` or `someVar.startsWith(<root-name>)` where
// the root-name is one of the conventional filesystem-root identifiers.
const ROOT_NAMES =
  /(projectRoot|rootDir|repoRoot|baseDir|cwd|workspaceRoot|packageDir|nodeModulesDir|parent)/.source

// `<x>.startsWith(<root-name>...)`
const STARTSWITH_OF_ROOT_RE = new RegExp(
  String.raw`\.startsWith\s*\(\s*` + ROOT_NAMES + String.raw`\b`,
  'g',
)

// `<root-name>.startsWith(...)` is less common in path-guard code (the
// other direction), but worth catching for symmetry. The match captures
// the root-name so the message can name it.
const ROOT_DOT_STARTSWITH_RE = new RegExp(
  String.raw`\b` + ROOT_NAMES + String.raw`\s*\.\s*startsWith\s*\(`,
  'g',
)

const FILE_IGNORE_RE = /@fitness-ignore-file\s+cli-realpath-validation/

/** Exported for unit tests. */
export function analyzeCliRealpathValidation(
  content: string,
  filePath: string,
): CheckViolation[] {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return []
  if (filePath.endsWith('.d.ts')) return []
  if (isTestFile(filePath)) return []
  const normalized = filePath.replaceAll('\\', '/')
  if (!SCOPED_PATH_SEGMENTS.some((seg) => normalized.includes(seg))) return []

  // Fast path: nothing to do if startsWith is absent.
  if (!content.includes('startsWith')) return []

  const rawLines = content.split('\n')
  if (rawLines.slice(0, 50).some((line) => FILE_IGNORE_RE.test(line))) return []

  const violations: CheckViolation[] = []

  // Pattern 1: `<x>.startsWith(<root-name>...)`
  for (const m of content.matchAll(STARTSWITH_OF_ROOT_RE)) {
    const idx = m.index ?? 0
    const rootName = m[1] ?? '<root>'
    violations.push({
      line: lineNumberOfIndex(content, idx),
      severity: 'error',
      message:
        `Legacy path-traversal guard: \`.startsWith(${rootName})\`. ` +
        `startsWith is bypassable via symlinks, trailing-slash edge cases, ` +
        `and Windows path normalisation. The 2026-05-25 plugin-discovery ` +
        `audit replaced these with realpathSync + path.relative / isPathInside.`,
      suggestion:
        `Use \`isPathInside(child, ${rootName})\` from packages/core/src/plugins/discover.ts ` +
        `(or an equivalent realpathSync-based check) — it resolves symlinks before comparing.`,
    })
  }

  // Pattern 2: `<root-name>.startsWith(...)`
  for (const m of content.matchAll(ROOT_DOT_STARTSWITH_RE)) {
    const idx = m.index ?? 0
    const rootName = m[1] ?? '<root>'
    violations.push({
      line: lineNumberOfIndex(content, idx),
      severity: 'error',
      message:
        `Legacy path-traversal guard: \`${rootName}.startsWith(...)\`. ` +
        `Symmetric to the more common shape; same bypass surface.`,
      suggestion:
        `Use \`isPathInside(<candidate>, ${rootName})\` or \`realpathSync\` + ` +
        `\`path.relative\` instead.`,
    })
  }

  return violations
}

function lineNumberOfIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++
  }
  return line
}

export const cliRealpathValidation = defineCheck({
  id: 'fa7c1b29-3e4d-4cb1-9a8f-5f2e9c6b4d18',
  slug: 'cli-realpath-validation',
  scope: { languages: ['typescript'], concerns: ['security', 'cli'] },
  contentFilter: 'raw',
  confidence: 'high',
  description:
    'Within packages/cli/src/ and packages/core/src/plugins/, forbid the legacy `<x>.startsWith(<projectRoot>)` path-traversal guard. Use realpathSync + path.relative (or isPathInside) instead.',
  longDescription: `**Purpose:** Block the symlink-bypassable path-traversal guard shape in the two trees that own filesystem-input validation.

**Detects:**
- \`<x>.startsWith(<root-name>)\` where root-name is one of: \`projectRoot\`, \`rootDir\`, \`repoRoot\`, \`baseDir\`, \`cwd\`, \`workspaceRoot\`, \`packageDir\`, \`nodeModulesDir\`, \`parent\`
- \`<root-name>.startsWith(...)\` (symmetric shape)

**Why it matters:** \`String.startsWith\` is not a path-containment check. Symlinks, trailing-slash edge cases (\`/foo\` vs \`/foo/\`), and Windows path normalisation all bypass it. The 2026-05-25 plugin-discovery audit found a real instance where a malicious \`pkg.main\` could escape \`node_modules\` past such a guard; the fix introduced \`isPathInside\` which uses \`realpathSync\` first. This check pins that fix.

**Scope:** TypeScript source whose path contains \`packages/cli/src/\` or \`packages/core/src/plugins/\`. Tests, \`.d.ts\`, and files outside those trees are skipped. Variables like \`prefix\` or \`routePath\` that legitimately use \`startsWith\` for non-path checks are not in the trigger list.

**Opt-out:** Place \`@fitness-ignore-file cli-realpath-validation\` in the first 50 lines if you have a legitimate non-path startsWith using a flagged variable name.`,
  tags: ['security', 'cli', 'path-traversal'],
  fileTypes: ['ts', 'tsx'],
  analyze: analyzeCliRealpathValidation,
})
