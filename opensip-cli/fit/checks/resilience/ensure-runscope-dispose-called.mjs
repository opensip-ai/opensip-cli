/**
 * Local-only resilience mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published @opensip-cli/checks-* packs.
 *
 * Guard: RunScope (owns per-run caches, recipe config slots, diagnostics bus, parse cache,
 * potentially contributed sub-scopes) defines dispose() for release. Production paths that
 * construct or enter a scope must ensure dispose() is invoked on all exit paths (normal,
 * error, abort, timeout). This is especially important for long-lived hosts and to keep
 * memory/ resource pressure bounded across sequential or concurrent runs.
 *
 * Allow: `// resilience-ok: scope is process-lived test harness` or similar.
 */

export const ensureRunScopeDisposeCalled = {
  id: "local:resilience-ensure-runscope-dispose-called",
  slug: "ensure-runscope-dispose-called",
  description:
    "RunScope must have its dispose() called (or guaranteed via finally/postAction) in all production construction/enter sites. Prevents unbounded growth of per-run caches and state across invocations or in SaaS hosts.",
  tags: ["resilience", "lifecycle", "dispose", "scope"],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.(ts|tsx)$/.test(filePath)) return violations;
    if (
      /node_modules|\/dist\/|\/__tests__\/|resilience\/|test-support\//.test(
        filePath,
      )
    )
      return violations;

    const lines = content.split(/\r?\n/);
    const hasEnterOrConstruct = /enterScope\s*\(|new RunScope\s*\(/.test(
      content,
    );
    if (!hasEnterOrConstruct) return violations;

    const hasDisposeCall =
      /\.dispose\s*\(\s*\)/.test(content) ||
      /scope\.dispose|currentScope\(\)\s*\?\.\s*dispose/.test(content);
    const hasPostActionOrFinallyNear =
      /postAction|finally\s*\{[\s\S]{0,200}dispose|try\s*\{[\s\S]{0,300}enterScope/.test(
        content,
      );

    if (hasEnterOrConstruct && !hasDisposeCall && !hasPostActionOrFinallyNear) {
      // Find a representative line
      for (let i = 0; i < lines.length; i++) {
        if (/enterScope\s*\(|new RunScope\s*\(/.test(lines[i])) {
          if (!/\/\/\s*resilience-ok\b/.test(lines[i])) {
            violations.push({
              line: i + 1,
              message: `Scope construction/enter without visible dispose() call or finally/postAction guard in the same file or nearby. RunScope.dispose() releases parseCache + recipeUnitConfig + any contributed state. Add postAction hook, try/finally { enter...; scope.dispose() }, or // resilience-ok with strong justification.`,
              severity: "warning",
            });
          }
          break;
        }
      }
    }

    return violations;
  },
};

export default ensureRunScopeDisposeCalled;
