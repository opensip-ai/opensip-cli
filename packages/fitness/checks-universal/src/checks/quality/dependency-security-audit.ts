// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Dependency Security Audit check
 *
 * Runs npm/pnpm audit to detect known vulnerabilities in dependencies.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Check: quality/dependency-security-audit
 *
 * Runs security audit to detect known vulnerabilities in dependencies.
 */
export const dependencySecurityAudit = defineCheck({
  id: 'd66533d9-800b-41d6-9385-c337ee6ad383',
  slug: 'dependency-security-audit',
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'medium',
  // Disabled: upstream dependency vulnerabilities cannot be fixed here; use `pnpm audit` as a separate CI step
  disabled: true,
  description: 'Detect known security vulnerabilities in dependencies',
  longDescription: `**Purpose:** Runs \`pnpm audit --json\` to identify known security vulnerabilities in project dependencies.

**Detects:**
- Critical and high severity vulnerabilities (reported as errors)
- Moderate, low, and info severity vulnerabilities (reported as warnings)
- Parses both JSON advisory format and fallback line-by-line vulnerability counts

**Why it matters:** Vulnerable dependencies can be exploited in production. Early detection allows timely patching before deployment.

**Scope:** General best practice. Runs external tool (\`command\`): \`pnpm audit --json\`.`,
  tags: ['quality', 'security', 'dependencies', 'vulnerabilities'],
  timeout: 60_000, // 1 minute

  command: {
    bin: 'pnpm',
    args: ['audit', '--json'],
    expectedExitCodes: [0, 1], // 0 = no issues, 1 = vulnerabilities found
    /* v8 ignore start -- audit parse logic exercised via integration tests (requires pnpm audit) */
    parseOutput(stdout, _stderr, exitCode): CheckViolation[] {
      const violations: CheckViolation[] = []

      if (exitCode === 0 && !stdout.trim()) {
        return [] // No vulnerabilities
      }

      try {
        const results = parseAuditOutput(stdout)

        for (const vuln of results.violations) {
          violations.push({
            line: 1,
            message: vuln.message,
            severity: vuln.severity,
            suggestion: vuln.suggestion,
            type: vuln.type,
            match: vuln.match,
            filePath: 'package.json',
          })
        }
      } catch {
        // @swallow-ok -- pnpm audit output parsing may fail for unexpected formats, fallback to generic error below
        // If parsing fails, report a generic error
        if (exitCode !== 0) {
          violations.push({
            line: 1,
            message: 'Security audit failed to parse output',
            severity: 'error',
            suggestion: "Run 'pnpm audit' manually to check for security issues",
            type: 'audit-error',
            filePath: 'package.json',
          })
        }
      }

      return violations
    },
    /* v8 ignore stop */
  },
})

/**
 * Severity levels for audit vulnerabilities
 */
type AuditSeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical'

/**
 * Audit vulnerability from pnpm audit
 */
interface AuditVulnerability {
  name: string
  severity: AuditSeverity
  title: string
  url?: string
  via?: { name?: string; title?: string }[]
  fixAvailable?: boolean | { name: string; version: string }
}

interface ParsedViolation {
  message: string
  severity: 'error' | 'warning'
  suggestion: string
  type: string
  match: string
}

/* v8 ignore start -- audit parsing helpers exercised via integration tests */
/**
 * Map npm severity to our severity
 */
function mapSeverity(severity: string): 'error' | 'warning' {
  switch (severity.toLowerCase()) {
    case 'critical':
    case 'high': {
      return 'error'
    }
    default: {
      return 'warning'
    }
  }
}

/**
 * Build suggestion text for a vulnerability fix
 */
function buildFixSuggestion(
  pkgName: string,
  fixAvailable: AuditVulnerability['fixAvailable'],
): string {
  if (!fixAvailable) {
    return `No fix available - consider replacing ${pkgName} with an alternative package`
  }

  if (typeof fixAvailable === 'object') {
    return `Update ${pkgName} to ${fixAvailable.name}@${fixAvailable.version}: pnpm update ${pkgName}`
  }

  return `Fix available: run 'pnpm audit fix' or 'pnpm update ${pkgName}'`
}

/**
 * Create a violation from an audit vulnerability
 */
function createVulnerabilityViolation(pkgName: string, vuln: AuditVulnerability): ParsedViolation {
  return {
    message: `${pkgName}: ${vuln.title || 'Security vulnerability'}`,
    severity: mapSeverity(vuln.severity),
    suggestion: buildFixSuggestion(pkgName, vuln.fixAvailable),
    type: `security-${vuln.severity}`,
    match: pkgName,
  }
}

// Pre-compiled regex pattern - simple pattern without catastrophic backtracking
// eslint-disable-next-line sonarjs/slow-regex -- fixed alternation with no overlapping; linear match
const VULN_COUNT_PATTERN = /(\d+) (low|moderate|high|critical)/i

/**
 * Extract vulnerability count from a text line
 */
function extractVulnCount(line: string): number {
  if (!line.includes('vulnerabilit')) {
    return 0
  }

  const match = VULN_COUNT_PATTERN.exec(line)
  if (match?.[1]) {
    // @fitness-ignore-next-line numeric-validation -- regex (\d+) guarantees digit-only string; parseInt always returns valid integer
    return Number.parseInt(match[1], 10)
  }

  return 0
}

/**
 * Parse audit output using fallback line-by-line method
 */
function parseAuditFallback(output: string): { totalDeps: number; violations: ParsedViolation[] } {
  const violations: ParsedViolation[] = []
  const lines = output.split('\n')
  let vulnCount = 0

  for (const line of lines) {
    vulnCount += extractVulnCount(line)
  }

  if (vulnCount > 0) {
    violations.push({
      message: `Found ${vulnCount} vulnerabilities`,
      severity: 'warning',
      suggestion: "Run 'pnpm audit' for details and 'pnpm audit fix' to auto-fix where possible",
      type: 'security-summary',
      match: `${vulnCount} vulnerabilities`,
    })
  }

  return { totalDeps: 1, violations }
}

/**
 * Parse audit output into violations
 */
function parseAuditOutput(output: string): { totalDeps: number; violations: ParsedViolation[] } {
  const violations: ParsedViolation[] = []

  try {
    const data = JSON.parse(output) as {
      advisories?: Record<string, AuditVulnerability>
      vulnerabilities?: Record<string, AuditVulnerability>
      metadata?: { dependencies?: number; totalDependencies?: number }
    }

    const totalDeps = data.metadata?.totalDependencies ?? data.metadata?.dependencies ?? 1
    const vulns = data.vulnerabilities ?? data.advisories ?? {}

    for (const [pkgName, vuln] of Object.entries(vulns)) {
      violations.push(createVulnerabilityViolation(pkgName, vuln))
    }

    return { totalDeps, violations }
  } catch {
    return parseAuditFallback(output)
  }
}
/* v8 ignore stop */
