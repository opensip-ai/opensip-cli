/**
 * @fileoverview Tools must use real, stable UUIDs for their `id` field in
 * ToolMetadata (matching the naming and hygiene model for Checks' `id`).
 *
 * Per ADR-0048 and the governing spec, the stable identity for Tools is
 * `metadata.id` (real UUID). The human key is `metadata.name`.
 *
 * This is a meta-check on Tool declarations (in source exports and manifests).
 */
import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /a1b2c3d4-9876-4321-aaaa-10000000000[12]/,
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[0]{10}[0-9a-f]{2}/,
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-aaaa-[0-9]{12}/,
  /[0-9a-f]1[0-9a-f]2[0-9a-f]3[0-9a-f]4-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
];

const TOOL_ID_REGEX = /metadata:\s*\{[^}]*id:\s*['"]([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})['"]/g;

export function analyzeToolStableId(content: string, filePath: string): CheckViolation[] {
  if (filePath.includes('/__fixtures__') || filePath.includes('.test.')) {
    return [];
  }

  const violations: CheckViolation[] = [];
  let match;

  while ((match = TOOL_ID_REGEX.exec(content)) !== null) {
    const id = match[1];
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(id))) {
      const line = content.substring(0, match.index).split('\n').length;
      violations.push({
        message: `Tool stable id '${id}' appears to be a placeholder or patterned ID. Use a real stable UUID.`,
        severity: 'error',
        line,
        suggestion: 'Assign a real UUID (e.g. via crypto.randomUUID or uuidgen). See ADR-0048 and the governing spec for the consistent `id` naming with Checks.',
      });
    }
  }

  return violations;
}

export const toolStableId = defineCheck({
  id: 'c8e4f2b1-5a6d-4e7f-9b0c-2d3e4f5a6b7c', // real promoted ID for this meta-check
  slug: 'tool-stable-id',
  description: 'Tool declarations must use real stable UUIDs for their `id` (matching Checks naming)',
  scope: { languages: ['typescript', 'json'], concerns: ['backend'] },
  tags: ['architecture', 'tools', 'meta'],
  fileTypes: ['ts', 'tsx', 'json'],
  contentFilter: 'strip-strings',
  analyze: (content, filePath) => analyzeToolStableId(content, filePath),
});