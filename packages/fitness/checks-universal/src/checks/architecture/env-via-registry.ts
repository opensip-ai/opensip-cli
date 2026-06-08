/**
 * @fileoverview Environment reads must flow through the EnvRegistry (§5.12).
 *
 * Release 2.12.0 made the env surface governed: every variable is a declared
 * `EnvVarSpec` read through the `EnvRegistry` primitive (`@opensip-tools/core`),
 * so it can be documented and deprecated coherently. A raw `process.env.<NAME>`
 * read bypasses that governance — the variable never appears in the generated
 * env-surface reference, has no coercion or deprecation policy, and cannot be
 * tested through one seam.
 *
 * This check flags raw `process.env` member reads in the RUNTIME packages, with
 * `strip-strings-and-comments` so the many `process.env.*` mentions in doc
 * comments, suggestion strings, and scaffolded config templates never false-fire —
 * only real reads survive.
 *
 * SCOPE / exemptions:
 *   - The check packs (the `checks-*` packages) are excluded entirely: they
 *     DESCRIBE env patterns (regex literals, suggestions) rather than read env.
 *   - The registry itself (`env-registry.ts`) and the composed host table
 *     (`host-env-specs.ts`) are the one sanctioned `process.env` site.
 *   - Two documented PRE-SCOPE readers run before any RunScope exists and cannot
 *     route through the registry: the terminal theme (`@opensip-tools/cli-ui` has
 *     no `core` dependency) and the early colour gate in `welcome.ts`. They are
 *     allow-listed by basename.
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * A real read of a SPECIFIC variable: `process.env.<NAME>` or `process.env[...]`.
 * Deliberately NOT bare `process.env` — forwarding the whole environment to a
 * subprocess (`env: process.env`, `...process.env`, `env = process.env`) is
 * legitimate passthrough, not a governed variable read.
 */
const PROCESS_ENV_RE = /\bprocess\.env\s*(?:\.\w|\[)/

/** Check packs describe env patterns; they do not read env. Excluded wholesale. */
const CHECK_PACK_PATH = /packages\/[^/]+\/checks-/

/** Tests legitimately set/read process.env to drive the code under test. */
const TEST_PATH = /\.test\.tsx?$|\/__tests__\//

/**
 * Files where a raw `process.env` read is sanctioned: the registry primitive and
 * the composed host table (the one read site), plus the two documented pre-scope
 * readers that run before any scope exists (the theme — cli-ui has no core dep —
 * and the early colour gate in welcome.ts).
 */
const ALLOWLISTED_BASENAMES: ReadonlySet<string> = new Set([
  'env-registry.ts',
  'host-env-specs.ts',
  'theme.ts',
  'welcome.ts',
  // Pre-scope subprocess relaunch: reads NODE_OPTIONS + a relaunch sentinel before
  // any opensip module (and any scope) loads (spec §5.12 documented exception).
  'heap-preflight.ts',
])

/** Pure analysis. Exported for unit tests. */
export function analyzeEnvViaRegistry(content: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  for (const [i, line] of content.split('\n').entries()) {
    if (PROCESS_ENV_RE.test(line)) {
      violations.push({
        message:
          'Environment reads must flow through the EnvRegistry (§5.12), not raw ' +
          'process.env — the variable is otherwise ungoverned (no docs, coercion, ' +
          'or deprecation) and invisible to the generated env-surface reference.',
        severity: 'error',
        line: i + 1,
        suggestion:
          'Declare an EnvVarSpec and read it via EnvRegistry.get(). If this is a ' +
          'genuine pre-scope reader that cannot reach a registry, allow-list it ' +
          'here with a justification (see env-registry / host-env-specs / theme).',
      })
    }
  }
  return violations
}

export const envViaRegistry = defineCheck({
  id: '992a80ac-58b5-422d-8a86-12f22f82d6e5',
  slug: 'env-via-registry',
  description: 'Environment reads must flow through the EnvRegistry, not raw process.env (§5.12)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts', 'tsx'],
  contentFilter: 'strip-strings-and-comments',
  analyze: (content, filePath) => {
    if (CHECK_PACK_PATH.test(filePath) || TEST_PATH.test(filePath)) return []
    const basename = filePath.split('/').at(-1) ?? ''
    if (ALLOWLISTED_BASENAMES.has(basename)) return []
    return analyzeEnvViaRegistry(content)
  },
})
