// @fitness-ignore-file fitness-check-standards -- Uses fs to detect the shared base config on disk, not source-file content
/**
 * @fileoverview Vitest config must extend the shared base check.
 *
 * Self-activating guardrail: ONLY when a repo centralizes its vitest defaults in
 * `.config/vitest.base.{ts,mts}` does this check require every per-package
 * `vitest.config.{ts,mts}` to extend it (import the base + `mergeConfig`). A repo
 * with no shared base (most adopters) is unaffected — the check returns no
 * findings, so it never fires on an unrelated project's vitest config.
 *
 * Rationale: opensip-tools' v2.7.0 release failed at the pre-publish gate because
 * `hookTimeout` had never been set (10s default) in any of ~31 copy-pasted
 * per-package vitest configs, and a catalog-building `beforeAll` blew it on a slow
 * CI runner. The fix centralized the timeouts into `.config/vitest.base.ts`; this
 * check is the regression guard — a new package that rolls its own config
 * (omitting the base) would silently lose the shared timeouts/defaults, exactly
 * the gap that caused the failure.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/** A per-package vitest config filename this check governs. Real-run fixture
 *  exclusion is handled by the project config's `globalExcludes` (the
 *  `__fixtures__` glob), NOT here — so the per-check fixture-coverage harness,
 *  which runs from inside a fixture tree, still exercises this check. */
function isVitestConfigPath(filePath: string): boolean {
  const base = path.basename(filePath)
  return base === 'vitest.config.ts' || base === 'vitest.config.mts'
}

/** Shared-base filenames that satisfy "the repo centralizes vitest defaults". */
const BASE_REL_CANDIDATES = ['.config/vitest.base.ts', '.config/vitest.base.mts'] as const

/** Walk up from a config file to find a repo-root that holds the shared base. */
function findSharedBase(fromConfigPath: string, exists: (p: string) => boolean): boolean {
  let dir = path.dirname(path.resolve(fromConfigPath))
  for (;;) {
    if (BASE_REL_CANDIDATES.some((rel) => exists(path.join(dir, rel)))) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

/** Token a config must contain to count as "extends the base" — it appears in
 *  the base import specifier (`.../.config/vitest.base.js`). Loose by intent: any
 *  `.js`/`.ts`/`.mts` specifier and any relative depth match. */
const BASE_REFERENCE_TOKEN = 'vitest.base'

/** Input for the pure detector (fs + content injected for testability). */
export interface VitestExtendsBaseInput {
  readonly vitestConfigPaths: readonly string[]
  readonly exists: (filePath: string) => boolean
  readonly readContent: (filePath: string) => string
}

/**
 * Pure detector. Returns a violation for each `vitest.config` that does NOT
 * reference the shared base — but ONLY when a shared base exists in the repo
 * (otherwise returns `[]`, keeping the check inert for non-adopters).
 */
export function detectConfigsNotExtendingBase(input: VitestExtendsBaseInput): CheckViolation[] {
  if (input.vitestConfigPaths.length === 0) return []
  const baseExists = findSharedBase(input.vitestConfigPaths[0], input.exists)
  if (!baseExists) return []

  const violations: CheckViolation[] = []
  for (const configPath of input.vitestConfigPaths) {
    if (input.readContent(configPath).includes(BASE_REFERENCE_TOKEN)) continue
    violations.push({
      filePath: configPath,
      line: 1,
      severity: 'error',
      type: 'vitest-config-extends-base',
      message:
        'vitest.config does not extend the shared .config/vitest.base — its timeouts/defaults will diverge from the rest of the workspace (the gap that broke the v2.7.0 release).',
      suggestion:
        "Import { vitestBase } from the repo's `.config/vitest.base.js` and `export default mergeConfig(vitestBase, defineConfig({ /* include + coverage only */ }))`.",
    })
  }
  return violations
}

export const vitestConfigExtendsBase = defineCheck({
  id: 'f1b9c2e4-7a3d-4c8e-9b6f-2d5a1e8c4b07',
  slug: 'vitest-config-extends-base',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  confidence: 'high',
  description: 'Per-package vitest configs must extend the shared .config/vitest.base (when one exists)',
  longDescription: `**Purpose:** When a repo centralizes its vitest defaults in \`.config/vitest.base.{ts,mts}\`, every per-package \`vitest.config.{ts,mts}\` must extend it (import the base + \`mergeConfig\`), so shared settings like \`testTimeout\`/\`hookTimeout\` cannot silently diverge.

**Detects:**
- A \`vitest.config.ts\` / \`vitest.config.mts\` that does NOT reference the shared base, in a repo that has a \`.config/vitest.base.{ts,mts}\`.

**Self-activating / adopter-safe:** if the repo has no \`.config/vitest.base\`, the check returns no findings — it never fires on an unrelated project's vitest config.

**Why it matters:** opensip-tools' v2.7.0 release failed at the pre-publish test gate because \`hookTimeout\` was never set (10s default) across ~31 copy-pasted per-package configs and a catalog-building \`beforeAll\` blew it on a slow CI runner. Centralizing the timeouts fixed it; this check prevents a new package from re-introducing the gap by rolling its own config.`,
  tags: ['architecture', 'testing'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const vitestConfigPaths = files.paths.filter(isVitestConfigPath)
    if (vitestConfigPaths.length === 0) return []
    // Content via the framework's size-managed BATCH reader (not raw
    // fs.readFileSync, and not a sequential await loop); fs is used ONLY for base
    // existence (no content read, no OOM surface).
    const contents = await files.readMany(vitestConfigPaths)
    return detectConfigsNotExtendingBase({
      vitestConfigPaths,
      exists: (filePath) => fs.existsSync(filePath),
      readContent: (filePath) => contents.get(filePath) ?? '',
    })
  },
})
