/**
 * @fileoverview no-implicit-tool-extension-defaults — createTool/defineTool must
 *               not synthesize lifecycle extension hooks when authors omit them.
 *
 * Project-local SELF-check for Plan 05 / ADR-0076.
 */
import { defineCheck } from '@opensip-cli/fitness';

const TARGET_FILES = new Set([
  'packages/core/src/tools/create-tool.ts',
  'packages/core/src/tools/define-tool.ts',
]);

const IMPLICIT_DEFAULT_PATTERNS = [
  /extensionPoints\s*\?\?/,
  /extensionPoints\s*\|\|/,
  /extensionPoints\s*:\s*\{[^}]*\binitialize\s*:/s,
  /extensionPoints\s*:\s*\{[^}]*\bcontributeScope\s*:/s,
  /extensionPoints\s*:\s*\{[^}]*\bcapabilityRegistrars\s*:/s,
];

/** Pure analysis helper for fixture tests. */
export function analyzeNoImplicitToolExtensionDefaults(content, filePath) {
  const normalized = filePath.replaceAll('\\', '/');
  if (!TARGET_FILES.has(normalized)) return [];

  const violations = [];
  for (const pattern of IMPLICIT_DEFAULT_PATTERNS) {
    const match = pattern.exec(content);
    if (match === null) continue;
    const before = content.slice(0, match.index ?? 0);
    const line = before.split('\n').length;
    violations.push({
      message:
        'Tool authoring helpers must not synthesize implicit extensionPoints lifecycle hooks. ' +
        'Safe defaults are absence, not installed no-op functions (ADR-0076).',
      severity: 'error',
      line,
      suggestion:
        'Pass extensionPoints through only when the author supplied them. ' +
        'Templates and createTool must leave extensionPoints undefined by default.',
    });
    break;
  }

  return violations;
}

export const checks = [
  defineCheck({
    id: 'a7c3e9f1-2b4d-4e8a-9f0c-1d2e3f4a5b6c',
    slug: 'dogfood-no-implicit-tool-extension-defaults',
    description:
      'createTool/defineTool must not synthesize default extensionPoints lifecycle hooks when none were supplied',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'tool-contract', 'plugins'],
    fileTypes: ['ts'],
    analyze: (content, filePath) => analyzeNoImplicitToolExtensionDefaults(content, filePath),
  }),
];
