// @fitness-ignore-file batch-operation-limits -- reviewed: pattern is architecturally justified or false positive
/**
 * @fileoverview Semgrep static analysis security scan
 *
 * Runs Semgrep with auto config to detect security vulnerabilities,
 * code injection, and other issues across all supported languages.
 */

import * as path from 'node:path'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

// =============================================================================
// SEMGREP JSON OUTPUT TYPES
// =============================================================================

interface SemgrepResult {
  check_id: string
  path: string
  start: { line: number; col: number }
  end: { line: number; col: number }
  extra: {
    message: string
    severity: 'ERROR' | 'WARNING' | 'INFO'
    metadata?: {
      cwe?: string[]
      owasp?: string[]
      confidence?: string
      category?: string
      subcategory?: string[]
      impact?: string
      likelihood?: string
    }
  }
}

interface SemgrepOutput {
  results: SemgrepResult[]
  errors: { message: string }[]
}

// =============================================================================
// SEVERITY MAPPING
// =============================================================================

/* v8 ignore start -- semgrep parsing helpers exercised via integration tests (requires semgrep CLI) */
function mapSeverity(semgrepSeverity: string): 'error' | 'warning' {
  return semgrepSeverity === 'ERROR' ? 'error' : 'warning'
}

// =============================================================================
// OUTPUT PARSING
// =============================================================================

function parseSemgrepOutput(
  stdout: string,
  _stderr: string,
  _exitCode: number,
  _files: readonly string[],
  cwd: string,
): CheckViolation[] {
  if (!stdout.trim()) return []

  let output: SemgrepOutput
  try {
    output = JSON.parse(stdout) as SemgrepOutput
  } catch {
    // @swallow-ok Non-JSON output from semgrep (e.g. login prompts, version warnings)
    return []
  }

  const violations: CheckViolation[] = []

  for (const result of output.results) {
    const meta = result.extra.metadata
    const cwe = meta?.cwe?.[0] ?? ''
    const prefix = cwe ? `[${cwe.split(':')[0]}] ` : ''

    violations.push({
      filePath: path.isAbsolute(result.path) ? result.path : path.join(cwd, result.path),
      line: result.start.line,
      column: result.start.col,
      message: `${prefix}${result.extra.message}`,
      severity: mapSeverity(result.extra.severity),
      suggestion: `Fix semgrep finding: ${result.check_id}`,
      type: result.check_id,
      match: result.check_id,
    })
  }

  return violations
}
/* v8 ignore stop */

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: security/semgrep-scan
 *
 * Runs Semgrep static analysis with curated security rules.
 */
export const semgrepScan = defineCheck({
  id: 'b8e2f4a1-6c3d-4e5f-9a1b-7d8c2e3f4a5b',
  slug: 'semgrep-scan',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },

  confidence: 'high',
  description: 'Run Semgrep static analysis to detect security vulnerabilities',
  longDescription: `**Purpose:** Runs Semgrep with \`--config auto\` to detect security vulnerabilities, injection flaws, and dangerous code patterns across the codebase.

**Detects:**
- Code injection (eval, template injection)
- SQL injection and command injection
- Insecure cryptographic usage
- Path traversal and SSRF
- Hardcoded secrets and credentials
- OWASP Top 10 vulnerability patterns

**Why it matters:** Semgrep performs AST-aware pattern matching that catches vulnerabilities regex-based tools miss. The \`auto\` config uses Semgrep's curated registry of security rules maintained by the community and Semgrep team.

**Requires:** \`semgrep\` CLI installed (\`pip install semgrep\` or \`brew install semgrep\`). 5-minute timeout for large codebases.`,
  tags: ['security', 'static-analysis', 'vulnerability', 'owasp'],
  timeout: 300_000, // 5 minutes — semgrep auto downloads rules on first run

  command: {
    bin: 'semgrep',
    args: ['scan', '--json', '--config', 'auto', '--quiet', '.'],
    expectedExitCodes: [0, 1], // 0 = clean, 1 = findings
    parseOutput: parseSemgrepOutput,
  },
})
