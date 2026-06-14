/**
 * Local-only public documentation mechanism (project layout under opensip-cli/fit/checks/docs/).
 * NEVER shipped.
 *
 * Prevents drift: public docs (docs/public/) must not leak references to internal-only
 * improvement process details (e.g. specific local mechanisms like "no-direct-stdout-in-command-paths",
 * "inter-cycle Merge Gate", autonomous remediation records in docs/remediation/, worktree branches,
 * or the full family of <domain>-improvement-process.md files) unless explicitly intended for
 * contributor education in extend/ or implementation/ sections.
 *
 * Heuristic: flag mentions of "improvement process", specific mechanism slugs from recent cycles,
 * "docs/remediation", or "inter-cycle" in public/ .md files outside sanctioned sections.
 * Allow // public-docs-ok.
 */

export const noLeakInternalImprovementPatterns = {
  id: "local:public-docs-no-leak-internal-improvement-patterns",
  slug: "no-leak-internal-improvement-patterns",
  description:
    "Public docs must not inadvertently document or leak internal improvement process machinery (local mechanisms, inter-cycle gates, remediation records, autonomous cycles) as if they were user-facing or shipped features.",
  tags: ["documentation", "drift", "internal-vs-public"],
  analyze(content, filePath) {
    const violations = [];
    if (!/docs\/public\//.test(filePath) || !/\.md$/.test(filePath))
      return violations;
    if (/80-implementation|50-extend/.test(filePath)) return violations; // sanctioned for contributor docs
    if (/\/\/\s*public-docs-ok\b/.test(content)) return violations;

    const badPatterns = [
      /improvement process/i,
      /inter-cycle/i,
      /docs\/remediation/i,
      /no-direct-stdout-in-command-paths|require-diagnostics-lifecycle-events|fitness-requires-diagnostics-events|graph-requires-diagnostics-events/i,
      /public-documentation-remediation|observability-remediation|resilience-remediation/i,
    ];

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (badPatterns.some((re) => re.test(lines[i]))) {
        violations.push({
          line: i + 1,
          message:
            'Public docs page references an internal improvement process detail, local mechanism slug, or remediation artifact. These belong in docs/internal/ or are not user-facing. Move, remove, or add // public-docs-ok with justification if this is deliberate (e.g. high-level "the project uses local checks for self-improvement").',
          severity: "warning",
        });
        break;
      }
    }
    return violations;
  },
};

export default noLeakInternalImprovementPatterns;
