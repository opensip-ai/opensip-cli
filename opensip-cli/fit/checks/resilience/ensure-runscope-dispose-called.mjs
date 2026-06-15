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

import { defineCheck } from '@opensip-cli/fitness';

export const ensureRunScopeDisposeCalled = defineCheck({
  id: '29014126-1382-4609-9485-2bb0ee711f19',
  slug: 'ensure-runscope-dispose-called',
  description:
    'RunScope must have its dispose() called (or guaranteed via finally/postAction) in all production construction/enter sites. Prevents unbounded growth of per-run caches and state across invocations or in SaaS hosts.',
  tags: ['resilience', 'lifecycle', 'dispose', 'scope'],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.(ts|tsx)$/.test(filePath) || /\.d\.ts$/.test(filePath)) return violations;
    if (
      /node_modules|\/dist\/|\/__tests__\/|\.test\.ts$|resilience\/|test-support\//.test(filePath)
    )
      return violations;

    const lines = content.split(/\r?\n/);
    const hasEnterOrConstruct = /enterScope\s*\(|new RunScope\s*\(/.test(content);
    if (!hasEnterOrConstruct) return violations;

    // A BUILDER constructs the scope and hands ownership to the caller (which
    // owns dispose — e.g. the pre-action hook's postAction disposes the scope
    // built by build-per-run-scope). It is not responsible for dispose itself.
    // Detect by an explicit `return scope` / a `: RunScope` return type.
    if (/return\s+scope\b|return\s+new RunScope\b|\)\s*:\s*RunScope\b/.test(content)) {
      return violations;
    }

    const hasDisposeCall =
      /\.dispose\s*\(\s*\)/.test(content) ||
      /scope\.dispose|currentScope\(\)\s*\?\.\s*dispose/.test(content);
    const hasPostActionOrFinallyNear =
      /postAction|finally\s*\{[\s\S]{0,200}dispose|try\s*\{[\s\S]{0,300}enterScope/.test(content);

    if (hasEnterOrConstruct && !hasDisposeCall && !hasPostActionOrFinallyNear) {
      // Find a representative line
      for (let i = 0; i < lines.length; i++) {
        if (/enterScope\s*\(|new RunScope\s*\(/.test(lines[i])) {
          if (!/\/\/\s*resilience-ok\b/.test(lines[i])) {
            violations.push({
              line: i + 1,
              message: `Scope construction/enter without visible dispose() call or finally/postAction guard in the same file or nearby. RunScope.dispose() releases parseCache + recipeUnitConfig + any contributed state. Add postAction hook, try/finally { enter...; scope.dispose() }, or // resilience-ok with strong justification.`,
              severity: 'warning',
            });
          }
          break;
        }
      }
    }

    return violations;
  },
});

export default ensureRunScopeDisposeCalled;
