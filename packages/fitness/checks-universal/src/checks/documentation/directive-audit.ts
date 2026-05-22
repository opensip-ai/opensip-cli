// @fitness-ignore-file file-length-limits -- Fitness check with extensive directive validation logic and pattern matching
// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file semgrep-justifications -- References nosemgrep patterns for directive parsing
// @fitness-ignore-file fitness-check-standards -- regex patterns are safe; bounded character classes prevent ReDoS
/**
 * @fileoverview Directive Audit - surfaces suppression directives for periodic review
 *
 * Audits all suppression directives in the codebase for periodic review:
 * - TypeScript: @ts-expect-error, @ts-expect-error
 * - ESLint: eslint-disable, eslint-disable-next-line, eslint-disable-line
 * - Fitness: @fitness-ignore-file, @fitness-ignore-next-line
 * - Semgrep: nosemgrep
 *
 * This check surfaces all directives as warnings for audit purposes.
 * Each directive can be reviewed to determine if it's still needed.
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

// =============================================================================
// TYPES
// =============================================================================

type DirectiveSource = 'typescript' | 'eslint' | 'fitness' | 'semgrep'
type DirectiveScope = 'file' | 'next-line' | 'same-line'

interface DirectiveInfo {
  file: string
  filePath: string
  line: number
  source: DirectiveSource
  scope: DirectiveScope
  rule: string
  reason: string
  raw: string
}

// =============================================================================
// CONSTANTS
// =============================================================================

// Quick check patterns - if none match, skip detailed parsing
const DIRECTIVE_MARKERS = [
  '@ts-expect-error',
  '@ts-expect-error',
  'eslint-disable',
  '@fitness-ignore',
  'nosemgrep',
]

// TypeScript directive pattern - matches // @ts-expect-error or // @ts-expect-error
// Uses explicit character class to avoid backtracking issues
const TS_DIRECTIVE_KEYWORD = '@ts-expect-error'
const TS_EXPECT_ERROR_KEYWORD = '@ts-expect-error'

// ESLint keywords
const ESLINT_DISABLE_NEXT_LINE = 'eslint-disable-next-line'
const ESLINT_DISABLE_LINE = 'eslint-disable-line'

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function extractTsDirectiveAndReason(line: string): { directive: string; reason: string } | null {
  // Find the directive marker
  let directiveStart = line.indexOf(TS_DIRECTIVE_KEYWORD)
  let directive = TS_DIRECTIVE_KEYWORD

  if (directiveStart === -1) {
    directiveStart = line.indexOf(TS_EXPECT_ERROR_KEYWORD)
    directive = TS_EXPECT_ERROR_KEYWORD
  }

  if (directiveStart === -1) {
    return null
  }

  // Check if preceded by //
  const beforeDirective = line.slice(0, directiveStart)
  if (!beforeDirective.includes('//')) {
    return null
  }

  // Extract reason after directive (after : or - or em-dash)
  // Using bounded quantifiers to prevent ReDoS
  const afterDirective = line.slice(directiveStart + directive.length)
  const separatorMatch = /^\s{0,5}[:\u002D\u2014]\s{0,5}(.{0,500})/.exec(afterDirective)
  const reason = separatorMatch?.[1]?.trim() ?? ''

  return { directive, reason }
}

function parseTypeScriptDirectives(
  content: string,
  filePath: string,
  file: string,
): DirectiveInfo[] {
  const directives: DirectiveInfo[] = []
  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next 4 -- defensive: lines.entries() never yields undefined for a string split */
    if (line === undefined) {
      // Skip undefined lines
      continue
    }

    const result = extractTsDirectiveAndReason(line)
    if (result) {
      directives.push({
        file,
        filePath,
        line: i + 1,
        source: 'typescript',
        scope: 'next-line',
        rule: result.directive,
        reason: result.reason,
        raw: line.trim(),
      })
    }
  }

  return directives
}

function determineESLintScope(text: string): DirectiveScope {
  if (text.includes(ESLINT_DISABLE_NEXT_LINE)) {
    return 'next-line'
  }
  if (text.includes(ESLINT_DISABLE_LINE)) {
    return 'same-line'
  }
  return 'file'
}

function parseRulesAndReason(rulesAndReasonRaw: string | undefined): {
  rules: string[]
  reason: string
} {
  /* v8 ignore next -- defensive: callers always pass non-empty strings here */
  const rulesAndReason = rulesAndReasonRaw?.trim() ?? ''
  const parts = rulesAndReason.split('--')
  /* v8 ignore next -- defensive: parts[0] always exists after split */
  const rulesPart = parts[0]?.trim() ?? ''
  /* v8 ignore next -- defensive: parts[1] may be undefined if no '--' separator */
  const reasonPart = parts[1]?.trim() ?? ''

  const rules = rulesPart
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r && r !== '*')

  return { rules, reason: reasonPart }
}

interface CreateESLintDirectiveOptions {
  rule: string
  scope: DirectiveScope
  lineNumber: number
  file: string
  filePath: string
  reason: string
  rawLine: string
}

function createESLintDirective(options: CreateESLintDirectiveOptions): DirectiveInfo {
  const { rule, scope, lineNumber, file, filePath, reason, rawLine } = options
  return {
    file,
    filePath,
    line: lineNumber,
    source: 'eslint',
    scope,
    rule,
    reason,
    raw: rawLine.trim(),
  }
}

interface AddESLintDirectivesOptions {
  rulesAndReasonRaw: string | undefined
  scope: DirectiveScope
  rawLine: string
  lineNumber: number
  file: string
  filePath: string
  directives: DirectiveInfo[]
}

function addESLintDirectives(options: AddESLintDirectivesOptions): void {
  const { rulesAndReasonRaw, scope, rawLine, lineNumber, file, filePath, directives } = options
  /* v8 ignore next 3 -- defensive: directives is constructed as an array in callers */
  if (!Array.isArray(directives)) {
    return
  }
  const { rules, reason } = parseRulesAndReason(rulesAndReasonRaw)

  if (rules.length === 0) {
    directives.push(
      createESLintDirective({ rule: '*', scope, lineNumber, file, filePath, reason, rawLine }),
    )
    return
  }

  for (const rule of rules) {
    directives.push(
      createESLintDirective({
        rule: `eslint/${rule}`,
        scope,
        lineNumber,
        file,
        filePath,
        reason,
        rawLine,
      }),
    )
  }
}

interface ProcessESLintCommentsOptions {
  line: string
  lineNumber: number
  file: string
  filePath: string
  directives: DirectiveInfo[]
}

function processESLintBlockComments(options: ProcessESLintCommentsOptions): void {
  const { line, lineNumber, file, filePath, directives } = options
  /* v8 ignore next 3 -- defensive: directives is constructed as an array in callers */
  if (!Array.isArray(directives)) {
    return
  }
  // Find block comments: /* eslint-disable[-next-line|-line] rules */
  let searchStart = 0
  while (searchStart < line.length) {
    const blockStart = line.indexOf('/*', searchStart)
    if (blockStart === -1) {
      return
    }

    const blockEnd = line.indexOf('*/', blockStart + 2)
    if (blockEnd === -1) {
      return
    }

    const blockContent = line.slice(blockStart + 2, blockEnd)
    // Using bounded quantifiers to prevent ReDoS
    const eslintMatch = /\s{0,5}eslint-disable(?:-next-line|-line)?\s{1,5}([^*]{1,500})/.exec(
      blockContent,
    )

    if (eslintMatch) {
      const scope = determineESLintScope(blockContent)
      addESLintDirectives({
        rulesAndReasonRaw: eslintMatch[1],
        scope,
        rawLine: line,
        lineNumber,
        file,
        filePath,
        directives,
      })
    }

    searchStart = blockEnd + 2
  }
}

function processESLintLineComments(options: ProcessESLintCommentsOptions): void {
  const { line, lineNumber, file, filePath, directives } = options
  /* v8 ignore next 3 -- defensive: directives is constructed as an array in callers */
  if (!Array.isArray(directives)) {
    return
  }
  // Find line comments: // eslint-disable[-next-line|-line] rules
  const commentStart = line.indexOf('//')
  if (commentStart === -1) {
    return
  }

  const afterComment = line.slice(commentStart + 2)
  // Using bounded quantifiers to prevent ReDoS
  const eslintMatch = /\s{0,5}eslint-disable(?:-next-line|-line)\s{1,5}(.{1,500})$/.exec(
    afterComment,
  )

  if (eslintMatch) {
    const scope = determineESLintScope(afterComment)
    addESLintDirectives({
      rulesAndReasonRaw: eslintMatch[1],
      scope,
      rawLine: line,
      lineNumber,
      file,
      filePath,
      directives,
    })
  }
}

function isFileLevelDisable(line: string): boolean {
  // Check for /* eslint-disable */ (no rules = all rules)
  const pattern = '/* eslint-disable */'
  return line.includes(pattern) || line.includes('/*eslint-disable*/')
}

function parseESLintDirectives(content: string, filePath: string, file: string): DirectiveInfo[] {
  const directives: DirectiveInfo[] = []
  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next 3 -- defensive: lines.entries() never yields undefined for a string split */
    if (line === undefined) {
      continue
    }

    const lineNumber = i + 1

    // Check for file-level eslint-disable at start of file (first 50 lines)
    if (i < 50 && isFileLevelDisable(line)) {
      directives.push({
        file,
        filePath,
        line: lineNumber,
        source: 'eslint',
        scope: 'file',
        rule: '*',
        reason: '',
        raw: line.trim(),
      })
    } else {
      processESLintBlockComments({
        line,
        lineNumber,
        file,
        filePath,
        directives,
      })
      processESLintLineComments({
        line,
        lineNumber,
        file,
        filePath,
        directives,
      })
    }
  }

  return directives
}

function extractFitnessDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
): DirectiveInfo | null {
  const fileMarker = '@fitness-ignore-file'
  const nextLineMarker = '@fitness-ignore-next-line'

  let scopeType: 'file' | 'next-line'
  let markerEnd: number

  const fileIdx = line.indexOf(fileMarker)
  const nextLineIdx = line.indexOf(nextLineMarker)

  if (fileIdx !== -1) {
    scopeType = 'file'
    markerEnd = fileIdx + fileMarker.length
  } else if (nextLineIdx === -1) {
    return null
  } else {
    scopeType = 'next-line'
    markerEnd = nextLineIdx + nextLineMarker.length
  }

  // Extract check ID and reason
  const afterMarker = line.slice(markerEnd).trim()
  const spaceIdx = afterMarker.indexOf(' ')
  if (spaceIdx === -1) {
    return null
  }

  const checkId = afterMarker.slice(0, spaceIdx)
  const rest = afterMarker.slice(spaceIdx).trim()

  // Look for -- separator
  const separatorIdx = rest.indexOf('--')
  if (separatorIdx === -1) {
    return null
  }

  const reason = rest.slice(separatorIdx + 2).trim()

  return {
    file,
    filePath,
    line: lineIndex + 1,
    source: 'fitness',
    scope: scopeType,
    rule: `fitness/${checkId}`,
    reason,
    raw: line.trim(),
  }
}

function parseFitnessDirectives(content: string, filePath: string, file: string): DirectiveInfo[] {
  const directives: DirectiveInfo[] = []
  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next 3 -- defensive: lines.entries() never yields undefined for a string split */
    if (line === undefined) {
      continue
    }

    const directive = extractFitnessDirective(line, i, filePath, file)
    if (directive) {
      directives.push(directive)
    }
  }

  return directives
}

/* v8 ignore start -- semgrep directive parsing has many sub-parsing branches; covered by integration */
/**
 * Extract semgrep rule ID and reason from a nosemgrep directive line.
 * Format: // nosemgrep: rule.id -- reason
 *         // nosemgrep: rule.id
 *         // nosemgrep
 */
function extractSemgrepDirective(
  line: string,
  lineIndex: number,
  filePath: string,
  file: string,
): DirectiveInfo | null {
  const nosemgrepMarker = 'nosemgrep'

  // Find the nosemgrep marker in a comment
  const commentIdx = line.indexOf('//')
  if (commentIdx === -1) {
    return null
  }

  const afterComment = line.slice(commentIdx + 2).trim()
  if (!afterComment.startsWith(nosemgrepMarker)) {
    return null
  }

  const afterMarker = afterComment.slice(nosemgrepMarker.length)

  // Extract rule ID and reason
  let ruleId = '*' // Default to all rules
  let reason = ''

  // Check for : separator (rule ID follows)
  if (afterMarker.startsWith(':')) {
    const afterColon = afterMarker.slice(1).trim()

    // Check for -- separator (reason follows)
    const reasonSeparator = afterColon.indexOf('--')
    if (reasonSeparator === -1) {
      ruleId = afterColon.trim() || '*'
    } else {
      ruleId = afterColon.slice(0, reasonSeparator).trim() || '*'
      reason = afterColon.slice(reasonSeparator + 2).trim()
    }
  } else if (afterMarker.trim().startsWith('--')) {
    // Just a reason, no rule ID
    reason = afterMarker.trim().slice(2).trim()
  }

  return {
    file,
    filePath,
    line: lineIndex + 1,
    source: 'semgrep',
    scope: 'next-line',
    rule: `semgrep/${ruleId}`,
    reason,
    raw: line.trim(),
  }
}
/* v8 ignore stop */

function parseSemgrepDirectives(content: string, filePath: string, file: string): DirectiveInfo[] {
  const directives: DirectiveInfo[] = []
  const lines = content.split('\n')

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next 3 -- defensive: lines.entries() never yields undefined for a string split */
    if (line === undefined) {
      continue
    }

    const directive = extractSemgrepDirective(line, i, filePath, file)
    if (directive) {
      directives.push(directive)
    }
  }

  return directives
}

function hasDirectiveMarkers(content: string): boolean {
  return DIRECTIVE_MARKERS.some((marker) => content.includes(marker))
}

function collectFileDirectives(content: string, filePath: string, file: string): DirectiveInfo[] {
  const directives: DirectiveInfo[] = [
    ...parseTypeScriptDirectives(content, filePath, file),
    ...parseESLintDirectives(content, filePath, file),
    ...parseFitnessDirectives(content, filePath, file),
    ...parseSemgrepDirectives(content, filePath, file),
  ]

  // Sort by line number
  directives.sort((a, b) => a.line - b.line)

  return directives
}

function isTypeScriptFile(filePath: string): boolean {
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx')
}

/**
 * Get the relative file name from a path (last part after last /)
 */
function getFileName(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/')
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
}

/**
 * Convert a directive to a CheckViolation
 */
function directiveToViolation(directive: DirectiveInfo): CheckViolation {
  const reasonPart = directive.reason ? ` -- ${directive.reason}` : ''
  const suggestion = directive.reason
    ? `Review if this suppression is still needed: ${directive.reason}`
    : 'Review if this suppression is still needed. Add a reason comment if keeping.'

  return {
    filePath: directive.filePath,
    line: directive.line,
    column: 0,
    message: `[${directive.source}/${directive.scope}] ${directive.rule}${reasonPart}`,
    severity: 'warning',
    suggestion,
    match: directive.raw,
    type: `directive-${directive.source}`,
  }
}

// =============================================================================
// ANALYSIS FUNCTION
// =============================================================================

/**
 * Analyze all files for suppression directives.
 * Uses analyzeAll mode since we need to collect statistics across files.
 */
async function analyzeAllFiles(files: FileAccessor): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = []

  // @lazy-ok -- validations inside loop depend on file content from await
  for (const filePath of files.paths) {
    // Only process TypeScript files
    if (!isTypeScriptFile(filePath)) {
      continue
    }

    try {
      const content = await files.read(filePath)
      const file = getFileName(filePath)

      // Quick filter: skip files without directive markers
      if (!hasDirectiveMarkers(content)) {
        continue
      }

      const directives = collectFileDirectives(content, filePath, file)

      for (const directive of directives) {
        violations.push(directiveToViolation(directive))
      }
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return violations
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: documentation/directive-audit
 *
 * Audits all suppression directives (TypeScript, ESLint, fitness-ignore)
 * in the codebase for periodic review. This is an informational check
 * that surfaces directives as warnings for audit purposes.
 *
 * Run via: pnpm sip fit --check documentation/directive-audit
 */
export const directiveAudit = defineCheck({
  id: '9ffe898e-3f62-4ef1-9abd-63cf45174689',
  slug: 'directive-audit',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Audit suppression directives for periodic review',
  longDescription: `**Purpose:** Surfaces all suppression directives across the codebase as warnings for periodic review, helping teams identify stale or unnecessary suppressions.

**Detects:**
- TypeScript directives: \`@ts-expect-error\` in \`//\` comments
- ESLint directives: \`eslint-disable\`, \`eslint-disable-next-line\`, \`eslint-disable-line\` in both line (\`//\`) and block (\`/* */\`) comments
- Fitness directives: \`@fitness-ignore-file\` and \`@fitness-ignore-next-line\` with check ID and \`--\` reason separator
- Semgrep directives: \`nosemgrep\` with optional \`:\` rule ID and \`--\` reason separator
- Classifies each directive by source, scope (file/next-line/same-line), rule, and reason
- Only processes TypeScript files (\`.ts\`, \`.tsx\`), skips files without directive markers for performance

**Why it matters:** Suppression directives accumulate over time and may outlive the conditions that justified them, silently weakening quality gates.

**Scope:** General best practice. Cross-file analysis via \`analyzeAll\` scanning all TypeScript files. Disabled by default; run manually for periodic audits.`,
  tags: ['documentation', 'audit', 'directives', 'maintenance'],
  fileTypes: ['ts', 'tsx'],
  disabled: true, // Run manually for periodic audits: pnpm sip fit --check documentation/directive-audit

  analyzeAll: analyzeAllFiles,
})
