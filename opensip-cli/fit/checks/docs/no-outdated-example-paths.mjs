/**
 * Local-only public documentation mechanism.
 * Flags examples in public docs that reference old or internal-only paths for local checks
 * (e.g. old no-fixme.mjs without full structure, or paths that no longer match the improvement process layout).
 */

import { defineCheck } from '@opensip-cli/fitness';

export const noOutdatedExamplePaths = defineCheck({
  id: 'fbc3614b-28d4-4b2b-a020-bb728c680a22',
  slug: 'no-outdated-example-paths',
  description:
    'Examples showing project-local checks must use current recommended layout and not point to stale or non-existent files.',
  tags: ['documentation', 'examples', 'drift'],
  analyze(content, filePath) {
    const violations = [];
    if (!/docs\/public\//.test(filePath) || !/\.md$/.test(filePath)) return violations;
    if (/\/\/\s*public-docs-ok\b/.test(content)) return violations;

    if (
      content.includes('no-fixme.mjs') &&
      !content.includes('id:') &&
      !content.includes('slug:')
    ) {
      violations.push({
        line: content.split('\n').findIndex((l) => l.includes('no-fixme.mjs')) + 1,
        message:
          'Example uses minimal/no-fixme.mjs without showing the full modern structure (id, slug, analyze). Update example or add comment.',
        severity: 'warning',
      });
    }
    return violations;
  },
});

export default noOutdatedExamplePaths;
