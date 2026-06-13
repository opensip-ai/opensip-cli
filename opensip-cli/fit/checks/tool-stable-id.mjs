/**
 * @fileoverview tool-stable-id — Tool declarations must carry a real, stable
 *               UUID for their `id` (matching Checks' `id` hygiene model).
 *               Project-local SELF-check.
 *
 * Relocated out of `@opensip-cli/checks-*` (placement sweep) because it encodes
 * opensip-cli local facts: it is a meta-check on opensip-cli' OWN Tool-contract
 * declarations and pins ADR-0048 (the decision that a Tool's stable identity is
 * `metadata.id` (real UUID) with `metadata.name` as the human key) — plus the
 * matching `opensipTools.stableId` manifest field in this repo's package.json
 * sidecars. A consumer repo authoring Tools against a different contract version,
 * or simply not citing ADR-0048, does not share that internal seam, so the rule
 * is opensip-internal, not universal. Inert for adopters per
 * opensip-cli/fit/checks/README.md.
 *
 * WHY: Per ADR-0048 and the governing spec, the stable identity for Tools is
 * `metadata.id` (a real UUID), mirroring the naming and hygiene model for
 * Checks' `id`; the human key is `metadata.name`. A placeholder or patterned
 * UUID (e.g. the scaffold `a1b2c3d4-…` template, an all-zero block, or an
 * `…-aaaa-…` filler) defeats stable identity: it collides across tools and
 * silently breaks any keying that assumes the id is unique and durable. This
 * meta-check fires on Tool declarations in source exports (`metadata: { id: … }`)
 * and on `stableId` in package.json#opensipTools manifests (and sidecars).
 */
import { defineCheck } from '@opensip-cli/fitness';

const PLACEHOLDER_PATTERNS = [
  /a1b2c3d4-9876-4321-aaaa-10000000000[12]/,
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-0{10}[0-9a-f]{2}/,
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-aaaa-\d{12}/,
  /[0-9a-f]1[0-9a-f]2[0-9a-f]3[0-9a-f]4-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
];

const TOOL_ID_REGEX =
  /metadata:\s*\{[^}]*id:\s*['"]([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})['"]/g;
// Also catch stableId in package.json#opensipTools manifests (and sidecars)
const STABLE_ID_JSON_REGEX =
  /"stableId"\s*:\s*['"]([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})['"]/g;

export function analyzeToolStableId(content, filePath) {
  if (filePath.includes('/__fixtures__') || filePath.includes('.test.')) {
    return [];
  }

  const violations = [];
  let match;

  while ((match = TOOL_ID_REGEX.exec(content)) !== null) {
    const id = match[1];
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(id))) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push({
        message: `Tool stable id '${id}' appears to be a placeholder or patterned ID. Use a real stable UUID.`,
        severity: 'error',
        line,
        suggestion:
          'Assign a real UUID (e.g. via crypto.randomUUID or uuidgen). See ADR-0048 and the governing spec for the consistent `id` naming with Checks.',
      });
    }
  }

  // Reset lastIndex for second regex (global)
  STABLE_ID_JSON_REGEX.lastIndex = 0;
  while ((match = STABLE_ID_JSON_REGEX.exec(content)) !== null) {
    const id = match[1];
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(id))) {
      const line = content.slice(0, match.index).split('\n').length;
      violations.push({
        message: `Tool stableId '${id}' appears to be a placeholder or patterned ID. Use a real stable UUID.`,
        severity: 'error',
        line,
        suggestion:
          'Assign a real UUID in the manifest stableId (and matching runtime Tool metadata.id). See ADR-0048.',
      });
    }
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'c8e4f2b1-5a6d-4e7f-9b0c-2d3e4f5a6b7c', // real promoted ID for this meta-check
    slug: 'tool-stable-id',
    description:
      'Tool declarations must use real stable UUIDs for their `id` (matching Checks naming)',
    scope: { languages: ['typescript', 'json'], concerns: ['backend'] },
    tags: ['architecture', 'tools', 'meta'],
    fileTypes: ['ts', 'tsx', 'json'],
    contentFilter: 'strip-strings',
    analyze: (content, filePath) => analyzeToolStableId(content, filePath),
  }),
];
