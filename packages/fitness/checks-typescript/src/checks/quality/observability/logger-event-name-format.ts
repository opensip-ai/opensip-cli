/**
 * @fileoverview Validates logger event names follow the 3+ dot-separated segment convention
 */

import {
  defineCheck,
  isInsideStringLiteral,
  isTestFile,
  type CheckViolation,
} from '@opensip-cli/fitness';

import { scanLineOutsideTemplateLiteral } from '../../../shared/template-literal-line-scan.js';

/**
 * Validates evt format: domain.component.action (3+ segments in lowercase with underscores)
 * Also allows hyphens in segments (e.g., 'tickets.service.create-many')
 */
const EVT_FORMAT_PATTERN = /^[a-z0-9_-]{1,50}\.[a-z0-9_-]{1,50}\.[a-z0-9_.-]{1,100}$/;

/**
 * Extracts evt field value from a line — only matches single/double quoted strings, NOT template literals.
 * Template literals with interpolation (e.g., `${prefix}.action.start`) resolve at runtime
 * and cannot be statically validated.
 */
const EVT_FIELD_PATTERN = /evt\s{0,5}:\s{0,5}['"]([^'"]{1,200})['"]/;

/**
 * Patterns that indicate event constant usage (can't statically validate)
 */
const EVENT_CONSTANT_PATTERNS = [
  /evt\s*:\s*EVENT_NAMES\./,
  /evt\s*:\s*EVENTS\./,
  /evt\s*:\s*LogEvents\./,
  /evt\s*:\s*LOG_EVENTS\./,
  /evt\s*:\s*[A-Z_]+_EVENTS\./,
];

function shouldSkipLine(line: string): boolean {
  const trimmed = line.trim();
  /* v8 ignore next -- defensive AST/type guard */
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return true;
  if (EVENT_CONSTANT_PATTERNS.some((p) => p.test(line))) return true;
  return false;
}

function isEvtPropertyContext(line: string, matchIndex: number): boolean {
  /* v8 ignore next -- defensive non-negative guard */
  const beforeEvt = line.slice(0, Math.max(0, matchIndex)).trim();
  return beforeEvt.length === 0 || /^[{,]$/.test(beforeEvt);
}

function createEvtViolation(
  evtValue: string,
  evtMatch: RegExpExecArray,
  lineNum: number,
  filePath: string,
  columnOffset: number,
): CheckViolation {
  const segmentCount = evtValue.split('.').length;
  return {
    line: lineNum,
    column: columnOffset + evtMatch.index,
    message: `Logger evt '${evtValue}' has ${segmentCount} segment(s) — minimum 3 required (domain.component.action)`,
    severity: 'error',
    suggestion: `Change to a 3+ segment format, e.g., '${evtValue}.start' or restructure as 'domain.component.action'`,
    match: evtMatch[0],
    type: 'invalid-evt-segments',
    filePath,
  };
}

/**
 * Find the first segment on a line that carries an `evt:` property (skipping
 * segments that merely contain a matching-but-inapplicable pattern), and
 * return its violation if the value fails the format check. Mirrors the
 * original single-match-per-line semantics of a bare `EVT_FIELD_PATTERN.exec(line)`
 * over the whole line, applied per non-template segment instead.
 */
function findEvtViolationInSegments(
  segments: readonly { readonly text: string; readonly offset: number }[],
  lineNum: number,
  filePath: string,
): CheckViolation | undefined {
  for (const segment of segments) {
    const evtMatch = EVT_FIELD_PATTERN.exec(segment.text);
    if (!evtMatch?.[1]) continue;
    if (isInsideStringLiteral(segment.text, evtMatch.index)) continue;
    if (!isEvtPropertyContext(segment.text, evtMatch.index)) continue;

    return EVT_FORMAT_PATTERN.test(evtMatch[1])
      ? undefined
      : createEvtViolation(evtMatch[1], evtMatch, lineNum, filePath, segment.offset);
  }
  return undefined;
}

function analyzeEvtNames(content: string, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  let inTemplateLiteral = false;

  for (const [i, line] of lines.entries()) {
    /* v8 ignore next -- defensive guard */
    if (!line) continue;

    const scan = scanLineOutsideTemplateLiteral(line, inTemplateLiteral);
    inTemplateLiteral = scan.inTemplateLiteral;
    if (shouldSkipLine(line)) continue;

    const violation = findEvtViolationInSegments(scan.segments, i + 1, filePath);
    if (violation !== undefined) violations.push(violation);
  }

  return violations;
}

/**
 * Check: quality/logger-event-name-format
 *
 * Validates that all logger evt field values follow the required
 * domain.component.action format with a minimum of 3 dot-separated segments.
 * Unlike logging-standards, this check has NO path exemptions.
 */
export const loggerEventNameFormat = defineCheck({
  id: '880c2472-9dd2-47c1-a1b8-03f06407a9ed',
  slug: 'logger-event-name-format',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate logger evt fields have 3+ dot-separated segments',
  longDescription: `**Purpose:** Enforces the project convention that all logger event names (\`evt\` field) must have at least 3 dot-separated segments following the \`domain.component.action[.status]\` pattern.

**Detects:**
- \`evt\` field string values with fewer than 3 dot-separated segments (e.g., \`evt: 'cli.sync'\` should be \`evt: 'cli.sync.start'\`)
- \`evt\` values with invalid characters (must be lowercase alphanumeric with underscores/hyphens)
- Skips template literal evt values (runtime interpolation cannot be statically validated)
- Skips event constant references (\`EVENT_NAMES.foo\`) since those are validated at definition
- Skips evt fields inside string literals (suggestion/description text containing example code)

**Why it matters:** Consistent event naming enables log filtering, dashboard creation, and alert configuration. Two-segment names are ambiguous and break the \`domain.component.action\` hierarchy.

**Scope:** Codebase-specific convention. Analyzes every file with NO path exemptions — all code must follow the same evt naming rules.`,
  tags: ['quality', 'observability', 'logging', 'conventions'],
  fileTypes: ['ts'],

  analyze(content: string, filePath: string): CheckViolation[] {
    // Skip test files
    if (isTestFile(filePath)) {
      return [];
    }

    // Quick check: must have both logger and evt
    if (!content.includes('logger.') || !content.includes('evt')) {
      return [];
    }

    return analyzeEvtNames(content, filePath);
  },
});
