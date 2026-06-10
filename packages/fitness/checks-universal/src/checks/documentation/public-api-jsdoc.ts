// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
/**
 * @fileoverview Public API JSDoc check
 */

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

import { isInPublicApiSurface } from './_public-api-graph.js';

/**
 * Patterns for exported declarations that should have JSDoc
 */
const EXPORT_PATTERNS = [
  /^export\s+(?:async\s+)?function\s+(\w+)/,
  /^export\s+class\s+(\w+)/,
  /^export\s+interface\s+(\w+)/,
  /^export\s+type\s+(\w+)\s*=\s*(?!z\.infer)/,
  /^export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
];

/** Re-export barrels don't need JSDoc */
const REEXPORT_PATTERN = /^export\s+(?:\{|\*\s+from|type\s+\{)/;

/**
 * Determine the kind of export for messaging
 */
function getExportKind(line: string): string {
  if (line.includes('function ')) return 'function';
  if (line.includes('class ')) return 'class';
  if (line.includes('interface ')) return 'interface';
  if (line.includes('type ')) return 'type';
  if (line.includes('const ')) return 'const';
  return 'declaration';
}

/**
 * Analyze a file for missing JSDoc on public API exports.
 *
 * Only fires on files that are part of the containing package's
 * published API surface — files reachable from the package's
 * `package.json#exports` entries via `export ... from` re-export
 * chains. Internal helper files (not re-exported from the package
 * barrel) are skipped: their `export` keyword is a TypeScript
 * intra-package visibility marker, not part of the npm-published
 * public API.
 *
 * When the package surface cannot be determined (no `package.json`,
 * no `exports` field), the check falls back to its historical broad
 * behavior — every `export` is treated as public.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Inherent complexity: line-by-line export pattern matching with preceding JSDoc detection and re-export filtering
function analyzeJsdoc(content: string, filePath: string): CheckViolation[] {
  if (!isInPublicApiSurface(filePath)) return [];

  const violations: CheckViolation[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Skip re-exports (they inherit docs from the source)
    if (REEXPORT_PATTERN.test(trimmed)) continue;

    // Check if this line is an export declaration
    for (const pattern of EXPORT_PATTERNS) {
      const match = pattern.exec(trimmed);
      if (!match?.[1]) continue;

      const exportName = match[1];

      // Look backward for JSDoc comment (/** ... */)
      let hasJsdoc = false;
      for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
        const prevLine = (lines[j] ?? '').trim();
        if (prevLine === '') continue; // skip blank lines
        if (prevLine.endsWith('*/')) {
          hasJsdoc = true;
          break;
        }
        if (prevLine.startsWith('//')) continue; // skip single-line comments
        if (prevLine.startsWith('*')) continue; // inside JSDoc block
        break; // non-comment, non-blank line means no JSDoc
      }

      if (!hasJsdoc) {
        violations.push({
          line: i + 1,
          message: `Exported ${getExportKind(trimmed)} '${exportName}' is missing JSDoc documentation`,
          severity: 'warning',
          suggestion: `Add a /** ... */ JSDoc comment describing the purpose of '${exportName}'`,
          type: 'missing-jsdoc',
          match: trimmed.slice(0, 120),
        });
      }
      break; // Only match first pattern per line
    }
  }

  return violations;
}

/**
 * Check: documentation/public-api-jsdoc
 *
 * Requires JSDoc documentation on all public API exports in shared packages.
 */
export const publicApiJsdoc = defineCheck({
  id: '48d891e3-0be3-49bf-9448-723b4664b714',
  slug: 'public-api-jsdoc',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Requires JSDoc documentation on all public API exports in shared packages',
  longDescription: `**Purpose:** Ensures all public API exports in shared packages have JSDoc documentation, since these form the platform's published API surface.

**Detects:**
- Exported functions, classes, interfaces, types, and function-like constants without \`/** ... */\` JSDoc comments
- Excludes re-exports (\`export { ... } from\`, \`export * from\`) since they inherit docs from the source
- Excludes \`z.infer\` type aliases since they are self-documenting

**Why it matters:** Shared packages are consumed by the entire platform. Undocumented public APIs force consumers to read source code to understand behavior.

**Scope:** Files reachable from the package's \`package.json#exports\` entry barrels via \`export ... from\` re-export chains. Internal helper files (not re-exported from the package barrel) are skipped — their \`export\` keyword is an intra-package visibility marker, not part of the npm-published public API.

**Package shape handling:**
- Packages with an \`exports\` field — surface is the closure of those entries.
- Packages with only \`main\` / \`module\` — surface is that entry's closure.
- Binary-only packages (\`bin\` set, no \`exports\` / \`main\` / \`module\`) — empty surface; nothing is flagged.
- No containing \`package.json\` — falls back to flagging every \`export\` (historical broad behavior, used by ad-hoc fixtures).`,
  tags: ['documentation', 'api', 'quality'],
  fileTypes: ['ts'],
  analyze: analyzeJsdoc,
});
