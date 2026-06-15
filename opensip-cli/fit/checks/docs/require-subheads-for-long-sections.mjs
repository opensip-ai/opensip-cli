/**
 * Local-only public documentation mechanism.
 * Simple writing-quality heuristic turned into check.
 */

import { defineCheck } from '@opensip-cli/fitness';

export const requireSubheadsForLongSections = defineCheck({
  id: '313cd486-7b07-4f6c-8ddd-c2e2cdf1962a',
  slug: 'require-subheads-for-long-sections',
  description:
    'Long paragraphs or sections in public docs should have subheadings for scannability (Diátaxis-friendly flow). Heuristic: flag >120-word paragraphs without nearby ##/###.',
  tags: ['documentation', 'writing-quality', 'flow'],
  analyze(content, filePath) {
    const violations = [];
    if (!/docs\/public\//.test(filePath) || !/\.md$/.test(filePath)) return violations;
    if (/\/\/\s*public-docs-ok\b/.test(content)) return violations;

    const paras = content.split(/\n\s*\n/);
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i].trim();
      const words = p.split(/\s+/).length;
      if (words > 120 && !/^\s*#{2,3}\s/.test(p) && !paras[i - 1]?.match(/^\s*#{2,3}\s/)) {
        violations.push({
          line: content.split('\n').indexOf(p.split('\n')[0]) + 1,
          message: `Long paragraph (~${words} words) without a preceding subheading. Consider breaking with ##/### for better flow (see process doc examples).`,
          severity: 'warning',
        });
      }
    }
    return violations;
  },
});

export default requireSubheadsForLongSections;
