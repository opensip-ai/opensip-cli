/**
 * @fileoverview env-via-registry — environment reads must flow through the
 *               EnvRegistry (§5.12). Project-local SELF-check for opensip-tools.
 *
 * Relocated out of `@opensip-tools/checks-universal` (where it shipped 2.12.0–2.12.x):
 * this check enforces opensip-tools' OWN env-governance model. It mandates reads
 * through the `EnvRegistry` primitive (`@opensip-tools/core`) and allow-lists
 * opensip-tools-internal files (`env-registry.ts` / `host-env-specs.ts` /
 * `theme.ts` / `welcome.ts` / `heap-preflight.ts`). None of that is meaningful to
 * a consumer codebase — the registry doesn't exist there and the allow-list names
 * files only this repo has. It is a tool-internal convention, not a universal one,
 * so it lives here as a dogfood self-check rather than in the shipped pack.
 *
 * Release 2.12.0 made the env surface governed: every variable is a declared
 * `EnvVarSpec` read through the registry so it can be documented and deprecated
 * coherently. A raw `process.env.<NAME>` read bypasses that — the variable never
 * appears in the generated env-surface reference, has no coercion/deprecation
 * policy, and cannot be tested through one seam.
 *
 * `strip-strings-and-comments` keeps the many `process.env.*` mentions in doc
 * comments / suggestion strings / scaffolded config templates from false-firing —
 * only real reads survive. The check packs (`checks-*`) are excluded wholesale
 * (they DESCRIBE env patterns, they don't read env); tests are excluded (they
 * legitimately drive code under test via process.env).
 */
import { defineCheck } from '@opensip-tools/fitness'

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
 * the composed host table (the one read site), plus the documented pre-scope
 * readers that run before any RunScope exists (the cli-ui theme — no `core`
 * dependency — the early colour gate in `welcome.ts`, and the heap-preflight
 * subprocess relaunch which reads NODE_OPTIONS + a relaunch sentinel before any
 * opensip module loads).
 */
const ALLOWLISTED_BASENAMES = new Set([
  'env-registry.ts',
  'host-env-specs.ts',
  'theme.ts',
  'welcome.ts',
  'heap-preflight.ts',
])

/** Pure analysis. Exported so the dogfood-integration test can exercise it. */
export function analyzeEnvViaRegistry(content) {
  const violations = []
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

export const checks = [
  defineCheck({
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
  }),
]
