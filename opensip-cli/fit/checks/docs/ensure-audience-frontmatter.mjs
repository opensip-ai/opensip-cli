/**
 * Local-only public documentation mechanism (project layout under opensip-cli/fit/checks/docs/).
 * NEVER shipped.
 *
 * Enforces that guide-style pages in docs/public/ (especially in 60-guides/ and 50-extend/)
 * declare an `audience:` frontmatter field (array of roles such as "getting-started",
 * "plugin-authors", "contributors", "ci-integrators"). This improves targeting and
 * prevents "who is this for?" walls of text.
 *
 * The mechanism is a simple frontmatter + content heuristic. Allow // public-docs-ok.
 */

export const ensureAudienceFrontmatter = {
  id: 'local:public-docs-ensure-audience-frontmatter',
  slug: 'ensure-audience-frontmatter',
  description: 'Guide and extend pages should declare an audience: frontmatter array so readers know the intended persona and writers keep the page focused.',
  tags: ['documentation', 'writing-quality', 'audience', 'frontmatter'],
  analyze(content, filePath) {
    const violations = [];
    if (!/docs\/public\//.test(filePath) || !/\.md$/.test(filePath)) return violations;
    if (!/60-guides|50-extend/.test(filePath)) return violations; // only guides/extend style pages
    if (/\/\/\s*public-docs-ok\b/.test(content)) return violations;

    const hasAudience = /^audience:\s*\[/m.test(content);
    if (!hasAudience) {
      violations.push({
        line: 1,
        message: 'Missing `audience:` frontmatter array (e.g. audience: [getting-started, plugin-authors]). Add it near the top of the file so the page has a clear target reader. This improves scannability and helps the improvement process target writing-quality fixes.',
        severity: 'warning',
      });
    }
    return violations;
  },
};

export default ensureAudienceFrontmatter;
