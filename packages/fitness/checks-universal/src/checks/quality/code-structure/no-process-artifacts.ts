/**
 * @fileoverview Process/planning artifact detection in comments.
 *
 * Detects "Phase 1", "Sprint 12", version stamps, and date stamps
 * left in comments. These belong in the backlog, the changelog, or
 * git history — not the source.
 *
 * Extracted from the former `comment-quality` umbrella in Phase C1.
 *
 * Migrated to defineRegexListCheck (Phase C6 / 2026-05-23 NF2). The
 * original site truncated each line to 500 chars before running the
 * regex; that ReDoS guard is unnecessary because every pattern
 * already uses bounded quantifiers (`\d{1,3}`, `\s{0,5}`,
 * `\d{1,5}`, etc.), so an unbounded line cannot trigger catastrophic
 * backtracking. The `EXCLUDE_PATTERNS` algorithm-step exemption is
 * routed through the helper's `skipLine` predicate.
 */

import { defineRegexListCheck } from '@opensip-cli/fitness';

// Exclusion: algorithm step comments like "Phase 1: Try primary
// operation" are allowed and should not fire the Phase pattern.
const ALGORITHM_PHASE_PATTERN = /\/\/\s{0,5}Phase\s{1,5}\d{1,3}\s{0,5}:\s{0,5}\w{1,50}/i;

const PHASE_FIX = 'Remove planning artifact; use backlog for tracking future work';
const SPRINT_FIX = 'Remove planning artifact; sprint references are not useful to code readers';
const VERSION_FIX = 'Remove version stamp; git history tracks this information';
const DATE_FIX = 'Remove date stamp; git history tracks this information';

/**
 * Check: quality/no-process-artifacts
 *
 * Detects process/planning artifacts (Phase X, Sprint X, version
 * stamps, date stamps) in comments.
 */
export const noProcessArtifacts = defineRegexListCheck({
  id: '3aa07a17-4bde-4f17-9296-c035809bc938',
  slug: 'no-process-artifacts',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'raw',
  confidence: 'medium',
  description: 'Detects process/planning artifacts (Phase X, Sprint X, version stamps) in comments',
  longDescription: `**Purpose:** Process/planning artifacts in source code become stale and clutter file history. Tracking belongs in the backlog, changelogs, or git history.

**Detects:**
- \`// Phase N\` (excluding algorithm step comments like \`// Phase 1: Try primary operation\`)
- \`// Sprint N\`
- Version stamps (\`// v1.2.3\`)
- "Added in vN" comments
- Date stamps (\`// Updated 2024-01-01\`)

**Why it matters:** When the planning context shifts, these comments become misleading. Trim them at authorship time and rely on the backlog and version control for the real history.`,
  tags: ['maintainability', 'code-quality', 'quality'],
  fileTypes: ['ts', 'tsx'],
  disabled: true,
  options: {
    // Comments are exactly what this check targets — do NOT skip them.
    skipCommentLines: false,
    // Original site emitted at most one violation per line via `break`
    // after the first matching pattern.
    oneViolationPerLine: true,
    // Skip lines that look like algorithm-step comments.
    skipLine: (_trimmed, rawLine) => ALGORITHM_PHASE_PATTERN.test(rawLine),
  },
  patterns: [
    {
      id: '274c1f41-817d-4b88-be5e-7907435d92f0',
      slug: 'phase-artifact',
      regex: /\/\/\s{0,5}Phase\s{1,5}\d{1,3}\s{0,5}(?:Enhancement|Implementation|:|$)/i,
      message: `Process artifact comment found. ${PHASE_FIX}`,
      severity: 'error',
      suggestion: PHASE_FIX,
    },
    {
      id: '0c6b412e-75e1-4a54-8642-ce9b27449568',
      slug: 'sprint-artifact',
      regex: /\/\/\s{0,5}Sprint\s{1,5}\d{1,5}\b/i,
      message: `Process artifact comment found. ${SPRINT_FIX}`,
      severity: 'error',
      suggestion: SPRINT_FIX,
    },
    {
      id: '939c4391-e010-45db-90d6-af3c50b6dd3c',
      slug: 'version-stamp',
      regex: /\/\/\s{0,5}v\d{1,3}\.\d{1,3}(?:\.\d{1,5})?\s{0,5}$/i,
      message: `Process artifact comment found. ${VERSION_FIX}`,
      severity: 'error',
      suggestion: VERSION_FIX,
    },
    {
      id: 'cdcdb9e5-36e3-4fc1-b315-b620354a835c',
      slug: 'added-in-version',
      regex: /\/\/\s{0,5}Added\s{1,5}in\s{1,5}v\d{1,5}\b/i,
      message: `Process artifact comment found. ${VERSION_FIX}`,
      severity: 'error',
      suggestion: VERSION_FIX,
    },
    {
      id: '5e8b6c7e-9197-4cd3-a33e-4b2247f4f65b',
      slug: 'date-stamp',
      regex: /\/\/\s{0,5}Updated?\s{1,5}\d{4}-\d{2}-\d{2}\b/i,
      message: `Process artifact comment found. ${DATE_FIX}`,
      severity: 'error',
      suggestion: DATE_FIX,
    },
  ],
});
