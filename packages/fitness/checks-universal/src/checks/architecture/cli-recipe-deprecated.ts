/**
 * @fileoverview Enforce ADR-0022: recipe defaults are tool-scoped.
 *
 * A `recipe:` key under the top-level `cli:` block of `opensip-tools.config.yml`
 * is DEPRECATED. Recipes are tool-scoped — `fit`, `graph`, and `sim` own
 * disjoint recipe namespaces — so a single tool-agnostic `cli.recipe` default is
 * applied to every tool, which leaks (e.g.) a fit recipe into `graph`/`sim`. The
 * fix is a per-tool default: `fitness.recipe`, `graph.recipe`, `simulation.recipe`.
 *
 * `cli.recipe` still WORKS (it is read as a tolerant cross-tool fallback), so
 * this is a `warning`, not an error: the run won't break, but the project should
 * migrate. This check is the visible migration driver (the runtime emits only a
 * file-level logger warning).
 *
 * DETECTION — line-oriented text scan (NOT a YAML parse). Find the top-level
 * `cli:` line, then walk its indented block (until the next top-level key) and
 * flag a `recipe:` line inside it. A `recipe:` under `fitness:` / `graph:` /
 * `simulation:` is the CORRECT tool-scoped form and is never flagged.
 *
 * SCOPE GUARD — implemented inside `analyze` by inspecting `filePath`, so the
 * check fires ONLY for `opensip-tools.config.yml` regardless of the project
 * `targets` config. Any other file returns `[]`.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/** Path fragment that identifies the project config. No-op for every other file. */
const CONFIG_FILE_SUFFIX = 'opensip-tools.config.yml'

/** A top-level `cli:` mapping key (no leading indentation). */
const TOP_LEVEL_CLI = /^cli:\s*(#.*)?$/
/** Any top-level mapping key (no leading indentation) — marks the end of a block. */
const TOP_LEVEL_KEY = /^[A-Za-z0-9_-]+:/
/** A `recipe:` mapping key with some leading indentation and a non-empty value. */
const INDENTED_RECIPE = /^\s+recipe:\s*\S/

/**
 * Pure analysis. Exported so unit tests can exercise detection without the
 * Check framework. `filePath` gates the config-file scope; `content` is the raw
 * `opensip-tools.config.yml` text.
 */
export function analyzeCliRecipeDeprecated(content: string, filePath: string): CheckViolation[] {
  if (!filePath.replaceAll('\\', '/').endsWith(CONFIG_FILE_SUFFIX)) return []

  const lines = content.split('\n')
  const violations: CheckViolation[] = []

  for (const [i, line] of lines.entries()) {
    if (!TOP_LEVEL_CLI.test(line)) continue
    // Walk the cli: block body — indented lines — until the next top-level key.
    for (let j = i + 1; j < lines.length; j += 1) {
      const bodyLine = lines[j]
      if (bodyLine.trim() === '') continue
      if (TOP_LEVEL_KEY.test(bodyLine)) break
      if (INDENTED_RECIPE.test(bodyLine)) {
        violations.push({
          line: j + 1,
          message:
            'Deprecated `cli.recipe` (ADR-0022): recipe defaults are tool-scoped. A ' +
            'single tool-agnostic default is applied to fit, graph, and sim, whose ' +
            'recipe namespaces are disjoint — so a fit recipe leaks into graph/sim.',
          severity: 'warning',
          suggestion:
            'Move the default under the owning tool: `fitness.recipe` (fit), ' +
            '`graph.recipe` (graph), and/or `simulation.recipe` (sim). cli.recipe ' +
            'still works as a tolerant fallback until removed.',
        })
      }
    }
    // Only one top-level cli: block is meaningful; stop after handling it.
    break
  }

  return violations
}

export const cliRecipeDeprecated = defineCheck({
  id: 'b7d4e1f0-9a2c-4e63-8b15-2f6c0a9d3e72',
  slug: 'cli-recipe-deprecated',
  description: 'Flag the deprecated tool-agnostic cli.recipe default; recipes are tool-scoped (ADR-0022)',
  scope: { languages: ['yaml'], concerns: ['config'] },
  tags: ['architecture', 'config', 'deprecation'],
  contentFilter: 'raw',
  analyze: (content, filePath) => analyzeCliRecipeDeprecated(content, filePath),
})
