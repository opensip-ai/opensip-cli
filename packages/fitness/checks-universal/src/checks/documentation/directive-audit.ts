// @fitness-ignore-file semgrep-justifications -- References nosemgrep patterns for directive parsing
/**
 * @fileoverview Directive Audit — surfaces suppression directives for periodic review.
 *
 * Audits all suppression directives in the codebase for periodic review:
 * - TypeScript: `@ts-expect-error`
 * - ESLint: `eslint-disable`, `eslint-disable-next-line`, `eslint-disable-line`
 * - Fitness: `@fitness-ignore-file`, `@fitness-ignore-next-line`
 * - Graph: `@graph-ignore-file`, `@graph-ignore-next-line`
 * - Semgrep: `nosemgrep`
 *
 * The four grammar parsers live in `./_directives/`. This file is
 * purely the orchestration layer: filter files, dispatch to parsers,
 * map directives onto CheckViolations.
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

import { parseESLintDirectives } from './_directives/eslint.js';
import { parseFitnessDirectives } from './_directives/fitness.js';
import { parseGraphDirectives } from './_directives/graph.js';
import { parseSemgrepDirectives } from './_directives/semgrep.js';
import { parseTypeScriptDirectives } from './_directives/typescript.js';

import type { DirectiveInfo } from './_directives/types.js';

// =============================================================================
// CONSTANTS
// =============================================================================

// Quick check markers — if none match, skip detailed parsing.
const DIRECTIVE_MARKERS = [
  '@ts-expect-error',
  'eslint-disable',
  '@fitness-ignore',
  '@graph-ignore',
  'nosemgrep',
];

// =============================================================================
// HELPERS
// =============================================================================

function hasDirectiveMarkers(content: string): boolean {
  return DIRECTIVE_MARKERS.some((marker) => content.includes(marker));
}

function collectFileDirectives(content: string, filePath: string, file: string): DirectiveInfo[] {
  const directives: DirectiveInfo[] = [
    ...parseTypeScriptDirectives(content, filePath, file),
    ...parseESLintDirectives(content, filePath, file),
    ...parseFitnessDirectives(content, filePath, file),
    ...parseGraphDirectives(content, filePath, file),
    ...parseSemgrepDirectives(content, filePath, file),
  ];

  directives.sort((a, b) => a.line - b.line);
  return directives;
}

function isTypeScriptFile(filePath: string): boolean {
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

function getFileName(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
}

function directiveToViolation(directive: DirectiveInfo): CheckViolation {
  const reasonPart = directive.reason ? ` -- ${directive.reason}` : '';
  const suggestion = directive.reason
    ? `Review if this suppression is still needed: ${directive.reason}`
    : 'Review if this suppression is still needed. Add a reason comment if keeping.';

  return {
    filePath: directive.filePath,
    line: directive.line,
    column: 0,
    message: `[${directive.source}/${directive.scope}] ${directive.rule}${reasonPart}`,
    severity: 'warning',
    suggestion,
    match: directive.raw,
    type: `directive-${directive.source}`,
  };
}

// =============================================================================
// ANALYSIS
// =============================================================================

/**
 * Analyze all files for suppression directives. Uses `analyzeAll`
 * mode because directive auditing is naturally cross-file.
 */
async function analyzeAllFiles(files: FileAccessor): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = [];

  // @lazy-ok -- validations inside loop depend on file content from await
  for (const filePath of files.paths) {
    if (!isTypeScriptFile(filePath)) {
      continue;
    }

    try {
      const content = await files.read(filePath);
      const file = getFileName(filePath);

      if (!hasDirectiveMarkers(content)) {
        continue;
      }

      const directives = collectFileDirectives(content, filePath, file);

      for (const directive of directives) {
        violations.push(directiveToViolation(directive));
      }
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return violations;
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: documentation/directive-audit
 *
 * Audits all suppression directives (TypeScript, ESLint, fitness-ignore,
 * semgrep) in the codebase for periodic review. This is an
 * informational check that surfaces directives as warnings for audit
 * purposes.
 *
 * Run via: `pnpm sip fit --check directive-audit`
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
- Graph directives: \`@graph-ignore-file\` and \`@graph-ignore-next-line\` with \`graph:<rule>\` ID and \`--\` reason separator
- Semgrep directives: \`nosemgrep\` with optional \`:\` rule ID and \`--\` reason separator
- Classifies each directive by source, scope (file/next-line/same-line), rule, and reason
- Only processes TypeScript files (\`.ts\`, \`.tsx\`), skips files without directive markers for performance

**Why it matters:** Suppression directives accumulate over time and may outlive the conditions that justified them, silently weakening quality gates.

**Scope:** General best practice. Cross-file analysis via \`analyzeAll\` scanning all TypeScript files. Disabled by default; run manually for periodic audits.`,
  tags: ['documentation', 'audit', 'directives', 'maintenance'],
  fileTypes: ['ts', 'tsx'],
  disabled: true, // Run manually for periodic audits

  analyzeAll: analyzeAllFiles,
});
