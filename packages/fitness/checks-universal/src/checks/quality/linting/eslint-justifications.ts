/**
 * @fileoverview ESLint Justifications check
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

// =============================================================================
// CONSTANTS
// =============================================================================

const ISSUE_TYPE_MISSING_JUSTIFICATION = 'missing-justification' as const;
const ISSUE_TYPE_GENERIC_JUSTIFICATION = 'generic-justification' as const;
const ISSUE_TYPE_MALFORMED = 'malformed' as const;

// =============================================================================
// PRE-COMPILED REGEX PATTERNS
// =============================================================================

// Generic justification patterns - pre-compiled for safety
const GENERIC_TODO_PATTERN = /^todo$/i;
const GENERIC_FIX_PATTERN = /^fix\s?(?:this|later|me)?$/i;
const GENERIC_TEMPORARY_PATTERN = /^temporary$/i;
const GENERIC_TEMP_PATTERN = /^temp$/i;
const GENERIC_WIP_PATTERN = /^wip$/i;
const GENERIC_IGNORE_PATTERN = /^ignore$/i;
const GENERIC_SKIP_PATTERN = /^skip$/i;
const GENERIC_DISABLED_PATTERN = /^disabled?$/i;
const GENERIC_HACK_PATTERN = /^hack$/i;
const GENERIC_WORKAROUND_PATTERN = /^workaround$/i;
const GENERIC_NEEDED_PATTERN = /^needed$/i;
const GENERIC_REQUIRED_PATTERN = /^required$/i;
const GENERIC_NECESSARY_PATTERN = /^necessary$/i;
const GENERIC_LEGACY_PATTERN = /^legacy$/i;
const GENERIC_OLD_CODE_PATTERN = /^old\s?code$/i;
const GENERIC_QUICK_FIX_PATTERN = /^quick\s?fix$/i;
const GENERIC_HOTFIX_PATTERN = /^hotfix$/i;
const GENERIC_WILL_FIX_PATTERN = /^will\s?fix$/i;
const GENERIC_TO_BE_FIXED_PATTERN = /^to\s?be\s?fixed$/i;
const GENERIC_NOT_SURE_PATTERN = /^not\s?sure$/i;
const GENERIC_UNCLEAR_PATTERN = /^unclear$/i;

const GENERIC_JUSTIFICATIONS = [
  GENERIC_TODO_PATTERN,
  GENERIC_FIX_PATTERN,
  GENERIC_TEMPORARY_PATTERN,
  GENERIC_TEMP_PATTERN,
  GENERIC_WIP_PATTERN,
  GENERIC_IGNORE_PATTERN,
  GENERIC_SKIP_PATTERN,
  GENERIC_DISABLED_PATTERN,
  GENERIC_HACK_PATTERN,
  GENERIC_WORKAROUND_PATTERN,
  GENERIC_NEEDED_PATTERN,
  GENERIC_REQUIRED_PATTERN,
  GENERIC_NECESSARY_PATTERN,
  GENERIC_LEGACY_PATTERN,
  GENERIC_OLD_CODE_PATTERN,
  GENERIC_QUICK_FIX_PATTERN,
  GENERIC_HOTFIX_PATTERN,
  GENERIC_WILL_FIX_PATTERN,
  GENERIC_TO_BE_FIXED_PATTERN,
  GENERIC_NOT_SURE_PATTERN,
  GENERIC_UNCLEAR_PATTERN,
];

// ESLint suppression patterns - pre-compiled with bounded quantifiers to avoid ReDoS
const ESLINT_DISABLE_NEXT_LINE_PATTERN = /\/\/\s{0,5}eslint-disable-next-line\s{1,5}([^\n]{1,500})/;
const ESLINT_DISABLE_LINE_PATTERN = /\/\/\s{0,5}eslint-disable-line\s{1,5}([^\n]{1,500})/;
const ESLINT_DISABLE_INLINE_PATTERN = /\/\/\s{0,5}eslint-disable\s{1,5}([^\n]{1,500})/;
const ESLINT_DISABLE_BLOCK_PATTERN =
  /\/\*\s{0,5}eslint-disable(?:\s{1,5}([^*]{1,400}))?\s{0,5}\*\//;
// Rationale capture caps at MAX_JUSTIFICATION_LENGTH so the boundary
// the regex enforces matches the explicit length check at line 160.
// Previously the regex capped at 400 while the constant was 500 —
// rationales between 401 and 500 chars matched the disable pattern
// (which accepts up to 500) but failed the rationale regex, producing
// a misleading "Malformed ESLint suppression comment" error instead
// of the accurate "too long" message. Aligning both to 500 closes
// that gap.
const JUSTIFICATION_PATTERN =
  /^([\w/@-]{1,100}(?:\s{0,3},\s{0,3}[\w/@-]{1,100}){0,9})(?:\s{1,5}--\s{1,5}([^\n]{1,500}))?$/;
const MAX_JUSTIFICATION_LENGTH = 500;

// Track multi-line block disable/enable pairs
const BLOCK_DISABLE_START_PATTERN = /\/\*\s{0,5}eslint-disable(?:\s{1,5}([^*]{1,400}))?\s{0,5}$/;
const BLOCK_DISABLE_END_PATTERN = /^\s{0,10}\*\//;
const BLOCK_ENABLE_PATTERN = /\/\*\s{0,5}eslint-enable/;

// Other patterns
const COMMENTED_OUT_PATTERN = /^\s{0,20}\/\/\s{0,5}\/\//;

// =============================================================================
// TYPES
// =============================================================================

type IssueType =
  | typeof ISSUE_TYPE_MISSING_JUSTIFICATION
  | typeof ISSUE_TYPE_GENERIC_JUSTIFICATION
  | typeof ISSUE_TYPE_MALFORMED;

interface ESLintSuppressionIssue {
  line: number;
  type: IssueType;
  rule?: string;
  comment: string;
  message: string;
}

interface BlockState {
  inMultiLineBlock: boolean;
  blockStartLine: number;
  blockRules: string | null;
}

// =============================================================================
// ANALYSIS FUNCTIONS
// =============================================================================

/**
 * Validates generic justification patterns
 */
function isGenericJustification(justification: string): boolean {
  const trimmed = justification.trim();
  return GENERIC_JUSTIFICATIONS.some((pattern) => pattern.test(trimmed));
}

/**
 * Determine suppression type from matches
 */
function getSuppressionType(hasNextLine: boolean, hasDisableLine: boolean): string {
  if (hasNextLine) {
    return 'eslint-disable-next-line';
  }
  if (hasDisableLine) {
    return 'eslint-disable-line';
  }
  return 'eslint-disable';
}

/**
 * Check inline ESLint suppressions (disable-next-line, disable-line, disable)
 */
function checkInlineSuppressions(line: string, lineNumber: number): ESLintSuppressionIssue[] {
  const issues: ESLintSuppressionIssue[] = [];

  // Check for disable-next-line, disable-line, and standalone disable
  const disableNextLineMatch = ESLINT_DISABLE_NEXT_LINE_PATTERN.exec(line);
  const disableLineMatch = ESLINT_DISABLE_LINE_PATTERN.exec(line);
  const disableMatch = ESLINT_DISABLE_INLINE_PATTERN.exec(line);

  const match = disableNextLineMatch ?? disableLineMatch ?? disableMatch;
  const suppressionType = getSuppressionType(
    disableNextLineMatch !== null,
    disableLineMatch !== null,
  );

  if (!match) {
    return issues;
  }

  const afterRule = match[1];
  if (!afterRule) {
    return issues;
  }

  // Limit input length to prevent ReDoS
  const trimmedAfterRule = afterRule.trim();
  if (trimmedAfterRule.length > MAX_JUSTIFICATION_LENGTH) {
    issues.push({
      line: lineNumber,
      type: ISSUE_TYPE_MALFORMED,
      comment: line.trim(),
      message: `ESLint justification too long (max ${MAX_JUSTIFICATION_LENGTH} characters)`,
    });
    return issues;
  }

  const justificationMatch = JUSTIFICATION_PATTERN.exec(trimmedAfterRule);

  if (!justificationMatch?.[1]) {
    issues.push({
      line: lineNumber,
      type: ISSUE_TYPE_MALFORMED,
      comment: line.trim(),
      message: 'Malformed ESLint suppression comment',
    });
    return issues;
  }

  const [, rule, justification] = justificationMatch;

  if (!justification) {
    issues.push({
      line: lineNumber,
      type: ISSUE_TYPE_MISSING_JUSTIFICATION,
      rule,
      comment: line.trim(),
      message: `ESLint suppression for '${rule}' missing justification. Add: // ${suppressionType} ${rule} -- [specific reason why this rule doesn't apply]`,
    });
  } else if (isGenericJustification(justification)) {
    issues.push({
      line: lineNumber,
      type: ISSUE_TYPE_GENERIC_JUSTIFICATION,
      rule,
      comment: line.trim(),
      message: `Generic justification for '${rule}': "${justification}". Replace with specific reason (e.g., "Third-party API returns untyped data" or "Validated by Zod schema above")`,
    });
  }

  return issues;
}

/**
 * Check single-line block ESLint suppressions
 */
function checkBlockSuppressions(line: string, lineNumber: number): ESLintSuppressionIssue | null {
  const blockDisableMatch = ESLINT_DISABLE_BLOCK_PATTERN.exec(line);
  if (!blockDisableMatch) {
    return null;
  }

  const rules = blockDisableMatch[1];
  if (rules && !rules.includes('--')) {
    return {
      line: lineNumber,
      type: ISSUE_TYPE_MISSING_JUSTIFICATION,
      comment: line.trim(),
      message: `Block-level ESLint disable missing justification. Add: /* eslint-disable ${rules} -- [specific reason] */`,
    };
  }

  return null;
}

/* v8 ignore start -- block-state machine has many edge-case branches; covered indirectly via integration */
/**
 * Process a line for suppressions
 */
function processLineForSuppressions(
  line: string,
  lineNumber: number,
  state: BlockState,
  issues: ESLintSuppressionIssue[],
): void {
  // Skip commented-out suppressions
  if (COMMENTED_OUT_PATTERN.test(line)) {
    return;
  }

  // Check for multi-line block start
  const blockStartMatch = BLOCK_DISABLE_START_PATTERN.exec(line);
  if (blockStartMatch && !state.inMultiLineBlock) {
    state.inMultiLineBlock = true;
    state.blockStartLine = lineNumber;
    state.blockRules = blockStartMatch[1] ?? null;
    return;
  }

  // Check for multi-line block end
  if (state.inMultiLineBlock && BLOCK_DISABLE_END_PATTERN.test(line)) {
    if (state.blockRules && !state.blockRules.includes('--')) {
      issues.push({
        line: state.blockStartLine,
        type: ISSUE_TYPE_MISSING_JUSTIFICATION,
        comment: `Multi-line eslint-disable block`,
        message: `Multi-line ESLint disable block missing justification. Add: /* eslint-disable ${state.blockRules} -- [specific reason] */`,
      });
    }
    state.inMultiLineBlock = false;
    state.blockStartLine = 0;
    state.blockRules = null;
    return;
  }

  // Check for block enable (closes any open block)
  if (BLOCK_ENABLE_PATTERN.test(line)) {
    state.inMultiLineBlock = false;
    state.blockStartLine = 0;
    state.blockRules = null;
    return;
  }

  // Check inline suppressions
  const inlineIssues = checkInlineSuppressions(line, lineNumber);
  issues.push(...inlineIssues);

  // Check single-line block suppressions
  const blockIssue = checkBlockSuppressions(line, lineNumber);
  if (blockIssue) {
    issues.push(blockIssue);
  }
}
/* v8 ignore stop */

/**
 * Validates ESLint suppressions in a file
 */
function validateESLintSuppressions(content: string): ESLintSuppressionIssue[] {
  const issues: ESLintSuppressionIssue[] = [];
  const lines = content.split('\n');
  const state: BlockState = {
    inMultiLineBlock: false,
    blockStartLine: 0,
    blockRules: null,
  };

  for (const [i, line] of lines.entries()) {
    if (!line) continue;

    processLineForSuppressions(line, i + 1, state, issues);
  }

  // If we ended with an open block, report it
  if (state.inMultiLineBlock && state.blockRules && !state.blockRules.includes('--')) {
    issues.push({
      line: state.blockStartLine,
      type: ISSUE_TYPE_MISSING_JUSTIFICATION,
      comment: `Unclosed multi-line eslint-disable block`,
      message: `Unclosed multi-line ESLint disable block missing justification`,
    });
  }

  return issues;
}

// =============================================================================
// HELPERS
// =============================================================================

// @graph-ignore-next-line graph:near-duplicate-function-body -- eslint and semgrep checks use parallel suggestion tables for different suppression vocabularies.
function getSuggestionForIssueType(issueType: IssueType): string {
  switch (issueType) {
    case ISSUE_TYPE_MISSING_JUSTIFICATION: {
      return 'Add a justification after -- explaining why this rule is suppressed';
    }
    case ISSUE_TYPE_GENERIC_JUSTIFICATION: {
      return 'Replace generic justification with a specific explanation of why this rule does not apply here';
    }
    default: {
      return 'Fix the malformed eslint directive format: // eslint-disable-next-line rule-name -- reason';
    }
  }
}

function getSeverityForIssueType(issueType: IssueType): 'error' | 'warning' {
  return issueType === ISSUE_TYPE_GENERIC_JUSTIFICATION ? 'warning' : 'error';
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: quality/eslint-justifications
 *
 * Ensures all ESLint suppressions have proper justifications.
 * Missing justifications are errors; generic justifications are warnings.
 *
 */
export const eslintJustifications = defineCheck({
  id: '92d8f5de-dc11-40eb-aaf4-e77159975825',
  slug: 'eslint-justifications',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Ensures all ESLint suppressions have proper justifications',
  longDescription: `**Purpose:** Enforces that every \`eslint-disable\` directive includes a meaningful, specific justification explaining why the rule is suppressed.

**Detects:**
- Missing justifications on \`eslint-disable-next-line\`, \`eslint-disable-line\`, inline \`eslint-disable\`, and block \`/* eslint-disable */\` comments
- Generic justifications matching patterns like \`todo\`, \`fix later\`, \`temporary\`, \`hack\`, \`workaround\`, \`needed\`, \`legacy\`, etc. (21 patterns total)
- Malformed suppression comments and justifications exceeding 500 characters
- Multi-line block disable/enable pairs without justifications

**Why it matters:** Unjustified suppressions hide technical debt and make it impossible to determine whether a suppression is still necessary. Requiring specific reasons ensures suppressions are intentional and reviewable.

**Scope:** Analyzes each file individually. General best practice.`,
  tags: ['compliance', 'documentation', 'quality'],
  fileTypes: ['ts', 'tsx'],

  analyze: (content: string, filePath: string): CheckViolation[] => {
    const violations: CheckViolation[] = [];

    // Early exit optimization: skip files without any suppressions
    if (!content.includes('eslint-disable')) {
      return violations;
    }

    const issues = validateESLintSuppressions(content);

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
