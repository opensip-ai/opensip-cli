// @fitness-ignore-file semgrep-justifications -- This check's own code references nosemgrep patterns for detection purposes
/**
 * @fileoverview Semgrep Justifications check
 *
 * Validates that all nosemgrep directives have proper justifications.
 * Similar to eslint-justifications, this ensures suppression directives
 * are documented with specific reasons.
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

// =============================================================================
// CONSTANTS
// =============================================================================

const CHECK_SLUG = 'semgrep-justifications';
const CHECK_ID = 'f83332d7-b3f2-463c-be54-8689a0fac5e4';

const ISSUE_TYPE_MISSING_JUSTIFICATION = 'missing-justification' as const;
const ISSUE_TYPE_GENERIC_JUSTIFICATION = 'generic-justification' as const;
const ISSUE_TYPE_MISSING_RULE = 'missing-rule' as const;

// Generic justification patterns - pre-compiled for safety
const GENERIC_JUSTIFICATIONS = [
  /^todo$/i,
  /^fix\s?(?:this|later|me)?$/i,
  /^temporary$/i,
  /^temp$/i,
  /^wip$/i,
  /^ignore$/i,
  /^skip$/i,
  /^disabled?$/i,
  /^hack$/i,
  /^workaround$/i,
  /^needed$/i,
  /^required$/i,
  /^necessary$/i,
  /^legacy$/i,
  /^old\s?code$/i,
  /^safe$/i,
  /^ok$/i,
  /^fine$/i,
  /^false\s?positive$/i, // Too generic without explanation
];

const MIN_JUSTIFICATION_LENGTH = 10;

// =============================================================================
// TYPES
// =============================================================================

type IssueType =
  | typeof ISSUE_TYPE_MISSING_JUSTIFICATION
  | typeof ISSUE_TYPE_GENERIC_JUSTIFICATION
  | typeof ISSUE_TYPE_MISSING_RULE;

interface SemgrepSuppressionIssue {
  line: number;
  type: IssueType;
  ruleId: string | null;
  comment: string;
  message: string;
}

// =============================================================================
// ANALYSIS FUNCTIONS
// =============================================================================

/**
 * Validates generic justification patterns
 */
function isGenericJustification(justification: string): boolean {
  const trimmed = justification.trim();
  if (trimmed.length < MIN_JUSTIFICATION_LENGTH) {
    return true;
  }
  return GENERIC_JUSTIFICATIONS.some((pattern) => pattern.test(trimmed));
}

/**
 * Parse a nosemgrep directive line and extract rule ID and reason.
 * Format: // nosemgrep: rule.id -- reason
 *         // nosemgrep: rule.id
 *         // nosemgrep -- reason (discouraged)
 *         // nosemgrep (discouraged)
 */
function parseNosemgrepLine(line: string): {
  isDirective: boolean;
  ruleId: string | null;
  reason: string | null;
} {
  const commentIdx = line.indexOf('//');
  if (commentIdx === -1) {
    return { isDirective: false, ruleId: null, reason: null };
  }

  const afterComment = line.slice(commentIdx + 2).trim();
  if (!afterComment.startsWith('nosemgrep')) {
    return { isDirective: false, ruleId: null, reason: null };
  }

  const afterMarker = afterComment.slice('nosemgrep'.length);

  // No rule ID and no reason: // nosemgrep
  if (afterMarker.trim() === '') {
    return { isDirective: true, ruleId: null, reason: null };
  }

  let ruleId: string | null = null;
  let reason: string | null = null;

  // Check for : separator (rule ID follows)
  if (afterMarker.startsWith(':')) {
    const afterColon = afterMarker.slice(1).trim();

    // Check for -- separator (reason follows)
    const reasonSeparator = afterColon.indexOf('--');
    if (reasonSeparator === -1) {
      ruleId = afterColon.trim() || null;
    } else {
      ruleId = afterColon.slice(0, reasonSeparator).trim() || null;
      reason = afterColon.slice(reasonSeparator + 2).trim() || null;
    }
  } else if (afterMarker.trim().startsWith('--')) {
    // Just a reason, no rule ID: // nosemgrep -- reason
    reason = afterMarker.trim().slice(2).trim() || null;
  }

  return { isDirective: true, ruleId, reason };
}

/**
 * Check a single line for nosemgrep suppression issues.
 */
function checkNosemgrepLine(line: string, lineNumber: number): SemgrepSuppressionIssue | null {
  const { isDirective, ruleId, reason } = parseNosemgrepLine(line);

  if (!isDirective) {
    return null;
  }

  // Case 1: Missing rule ID (blanket suppress)
  if (!ruleId) {
    return {
      line: lineNumber,
      type: ISSUE_TYPE_MISSING_RULE,
      ruleId: null,
      comment: line.trim(),
      message: reason
        ? `Blanket nosemgrep without rule ID. Specify which rule: // nosemgrep: specific.rule.id -- ${reason}`
        : 'Blanket nosemgrep without rule ID or justification. Add: // nosemgrep: specific.rule.id -- [reason why this is safe]',
    };
  }

  // Case 2: Missing justification
  if (!reason) {
    return {
      line: lineNumber,
      type: ISSUE_TYPE_MISSING_JUSTIFICATION,
      ruleId,
      comment: line.trim(),
      message: `nosemgrep for '${ruleId}' missing justification. Add: // nosemgrep: ${ruleId} -- [specific reason why this is safe]`,
    };
  }

  // Case 3: Generic justification
  if (isGenericJustification(reason)) {
    return {
      line: lineNumber,
      type: ISSUE_TYPE_GENERIC_JUSTIFICATION,
      ruleId,
      comment: line.trim(),
      message: `Generic justification for '${ruleId}': "${reason}". Replace with specific reason explaining why this code is safe (e.g., "Input validated by Zod schema" or "Internal CLI tool with trusted input only")`,
    };
  }

  // Valid justification
  return null;
}

/**
 * Validates nosemgrep suppressions in file content.
 */
function validateNosemgrepSuppressions(content: string): SemgrepSuppressionIssue[] {
  const issues: SemgrepSuppressionIssue[] = [];
  const lines = content.split('\n');

  for (const [i, line] of lines.entries()) {
    if (!line) continue;

    const issue = checkNosemgrepLine(line, i + 1);
    if (issue) {
      issues.push(issue);
    }
  }

  return issues;
}

// =============================================================================
// HELPERS
// =============================================================================

function getSuggestionForIssueType(issueType: IssueType): string {
  switch (issueType) {
    case ISSUE_TYPE_MISSING_JUSTIFICATION: {
      return 'Add a justification after -- explaining why this suppression is safe';
    }
    case ISSUE_TYPE_GENERIC_JUSTIFICATION: {
      return 'Replace generic justification with a specific explanation of why this code is safe';
    }
    case ISSUE_TYPE_MISSING_RULE: {
      return 'Specify the rule ID being suppressed: // nosemgrep: rule.id -- reason';
    }
    default: {
      return 'Fix the nosemgrep directive format: // nosemgrep: rule.id -- reason';
    }
  }
}

function getSeverityForIssueType(issueType: IssueType): 'error' | 'warning' {
  // Generic justifications are warnings, missing justifications/rules are errors
  return issueType === ISSUE_TYPE_GENERIC_JUSTIFICATION ? 'warning' : 'error';
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/semgrep-justifications
 *
 * Ensures all nosemgrep suppressions have proper justifications.
 * Missing justifications are errors; generic justifications are warnings.
 * Blanket suppressions (without rule IDs) are errors.
 */
export const semgrepJustifications = defineCheck({
  id: CHECK_ID,
  slug: CHECK_SLUG,
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Ensures all nosemgrep suppressions have proper justifications',
  longDescription: `**Purpose:** Enforces that every \`nosemgrep\` directive includes a specific rule ID and a meaningful justification explaining why the suppression is safe.

**Detects:**
- Blanket \`nosemgrep\` directives without a rule ID (e.g., \`// nosemgrep\` instead of \`// nosemgrep: rule.id\`)
- Missing justifications (no \`--\` separator with reason after the rule ID)
- Generic justifications matching patterns like \`todo\`, \`fix later\`, \`temp\`, \`hack\`, \`safe\`, \`ok\`, \`false positive\`, etc. (18 patterns total)
- Justifications shorter than 10 characters

**Why it matters:** Semgrep suppressions hide security and correctness findings. Without specific justifications, it is impossible to audit whether suppressions are still valid or were added carelessly.

**Scope:** Analyzes each file individually. General best practice for security suppression documentation.`,
  tags: ['compliance', 'documentation', 'security', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze: (content: string, filePath: string): CheckViolation[] => {
    const violations: CheckViolation[] = [];

    // Early exit optimization: skip files without any nosemgrep
    if (!content.includes('nosemgrep')) {
      return violations;
    }

    const issues = validateNosemgrepSuppressions(content);

    for (const issue of issues) {
      violations.push({
        filePath,
        line: issue.line,
        message: issue.message,
        severity: getSeverityForIssueType(issue.type),
        suggestion: getSuggestionForIssueType(issue.type),
        type: issue.type,
        match: issue.comment,
      });
    }

    return violations;
  },
});
