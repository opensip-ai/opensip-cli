/**
 * Local-only public documentation mechanism (project layout under opensip-cli/fit/checks/docs/).
 * NEVER shipped.
 *
 * Validates that examples in public docs/guides showing project-local checks
 * (under opensip-cli/fit/checks/) use the current expected layout and do not
 * contradict the improvement processes (e.g., no claims that local checks are only
 * for shipped packs, or outdated paths).
 *
 * Heuristic: scan for code blocks with "opensip-cli/fit/checks/" and check for
 * basic correctness (id, slug, analyze function, etc.). Flag if examples look stale
 * vs. actual mechanism files or process docs.
 * Allow // public-docs-ok.
 */

import { defineCheck } from '@opensip-cli/fitness';

export const validateLocalCheckExamples = defineCheck({
  id: 'a83b96d8-8286-4f15-88ef-032d899fb1b9',
  slug: 'validate-local-check-examples',
  description:
    'Examples of project-local checks in public docs must reflect current layout (id/slug/analyze, placed in opensip-cli/fit/checks/<category>/) and not misrepresent the local-only nature for self-improvement.',
  tags: ['documentation', 'drift', 'examples', 'local-checks'],
  analyze(content, filePath) {
    const violations = [];
    if (!/docs\/public\//.test(filePath) || !/\.md$/.test(filePath)) return violations;
    if (/\/\/\s*public-docs-ok\b/.test(content)) return violations;

    // Look for example code blocks showing local checks
    const codeBlocks = content.match(/```[\s\S]*?```/g) || [];
    for (const block of codeBlocks) {
      if (
        block.includes('opensip-cli/fit/checks/') &&
        (block.includes('export const') || block.includes('defineCheck'))
      ) {
        if (!block.includes('id:') || !block.includes('slug:') || !block.includes('analyze')) {
          violations.push({
            line: content.indexOf(block) + 1,
            message:
              'Example of local check in public docs appears incomplete or outdated (missing id/slug/analyze or proper structure). Update to match current mechanism pattern from opensip-cli/fit/checks/ or the improvement process docs.',
            severity: 'warning',
          });
        }
        if (
          block.includes('shipped') &&
          !block.includes('local-only') &&
          !block.includes('never shipped')
        ) {
          violations.push({
            line: content.indexOf(block) + 1,
            message:
              'Example claims or implies local checks are shipped/published. Local mechanisms (in opensip-cli/fit/checks/) are project-only for self-improvement and never added to published packs.',
            severity: 'warning',
          });
        }
      }
    }
    return violations;
  },
});

export default validateLocalCheckExamples;
