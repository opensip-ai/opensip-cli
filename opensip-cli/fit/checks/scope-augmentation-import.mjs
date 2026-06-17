/**
 * @fileoverview scope-augmentation-import — first-party Tool descriptors that
 *               contribute a RunScope subscope must import their augmentation.
 *               Project-local SELF-check.
 *
 * WHY: Tool subscopes are installed at runtime via `contributeScope()`, while
 * TypeScript sees the corresponding `scope.<tool>` slot only if the package's
 * `scope-augmentation.ts` module is loaded. The side-effect import is easy to
 * miss in a large `tool.ts`, so this check pins the convention for the
 * first-party tool descriptors.
 */
import { defineCheck } from '@opensip-cli/fitness';

const TOOL_DESCRIPTOR_RE = /packages\/(?:fitness|graph|simulation)\/engine\/src\/tool\.ts$/;
const CONTRIBUTE_SCOPE_RE = /\bcontributeScope\b/;
const SCOPE_AUGMENTATION_IMPORT_RE = /import\s+['"]\.\/scope-augmentation\.js['"];?/;

export function analyzeScopeAugmentationImport(content, filePath) {
  if (!TOOL_DESCRIPTOR_RE.test(filePath)) return [];
  if (!CONTRIBUTE_SCOPE_RE.test(content)) return [];
  if (SCOPE_AUGMENTATION_IMPORT_RE.test(content)) return [];

  return [
    {
      line: 1,
      filePath,
      message:
        'Tool descriptor contributes a RunScope subscope but does not side-effect import ./scope-augmentation.js.',
      severity: 'error',
      suggestion:
        "Add `import './scope-augmentation.js';` near the descriptor imports so ScopeContribution augmentation is loaded at every read site.",
      type: 'scope-augmentation-import',
    },
  ];
}

export const checks = [
  defineCheck({
    id: 'c5726cf8-48c9-4e75-a629-e2e6e03891f6',
    slug: 'scope-augmentation-import',
    description:
      'Tool descriptors with contributeScope must side-effect import their scope augmentation',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'tools', 'scope'],
    fileTypes: ['ts'],
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeScopeAugmentationImport(content, filePath),
  }),
];
