/**
 * @fileoverview No module-level mutable registry / loaded-state singleton
 * (release 2.10.0, ADR-0023 / Phase 3 / north-star Principle 6).
 *
 * Per-CLI-invocation state lives on `RunScope`, never in a module-level
 * `export const`. Phase 3 DELETED fitness's `defaultRegistry` /
 * `defaultRecipeRegistry` module singletons; the check/recipe/scenario/graph
 * and capability registries are all scope-owned, constructed once per run by a
 * `create*Registry()` factory the CLI bootstrap calls. This guardrail is the
 * definition of done that keeps the next release from re-introducing a shared
 * mutable singleton: it fires on a module-level
 * `export const <id> = new <Registry|EventEmitter|Map|Set|…>()` that holds
 * mutable shared state outside a factory.
 *
 * DETECTION — a top-level (column-0) `export const <id> = new <Ctor>(...)`
 * whose constructed type names a mutable-state shape:
 *   - `*Registry`        — a by-id/by-name registry (the exact thing Phase 3
 *                          scope-owned: `CheckRegistry`, `RecipeRegistry`,
 *                          `CapabilityRegistry`, …)
 *   - `*Store` / `*Cache` / `*Profiler` / `*Emitter` / `EventEmitter`
 *                        — loaded-state / mutable-accumulator shapes
 *   - `Map` / `Set` / `WeakMap` / `WeakSet`
 *                        — a module-level mutable collection
 * A `new`-of-a-plainly-immutable value (a frozen config object, a pure
 * function wrapper, a number/string) is NOT a mutable singleton and is not
 * matched (the constructor-name allowlist is deliberately narrow).
 *
 * EXEMPTIONS (ADR-0023):
 *   - `fileCache` (`framework/file-cache.ts`) and `memoryProfiler`
 *     (`framework/memory-profiler.ts`) — run-scoped utilities explicitly
 *     exempted; they are reset per run and carry no cross-run identity.
 *   - An inline `// @allow-module-singleton <reason>` marker on the export line
 *     (or the line above) — an escape hatch that REQUIRES a written reason, so
 *     any new exemption is reviewable in the diff rather than silent.
 *
 * SCOPE — opensip-tools' own monorepo sources (`packages/** /src/**`,
 * excluding tests). Adopter repos are unaffected: the path guard makes the
 * check inert outside this workspace's package layout.
 */
import path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/** A first-party package source file (excludes tests + build output). */
const PACKAGE_SRC_PATH = /packages\/[^/]+\/(?:[^/]+\/)?src\//

/** Constructor-name shapes that denote mutable shared state. */
const MUTABLE_CTOR_RE =
  /^(?:[A-Z]\w*(?:Registry|Store|Cache|Profiler|Emitter)|EventEmitter|Map|Set|WeakMap|WeakSet)$/

/**
 * Module-level singleton export:
 *   `export const <id> = new <Ctor>(`
 * Anchored at column 0 (a top-level export, not a nested local). Captures the
 * exported identifier and the constructed type name.
 */
const MODULE_SINGLETON_RE = /^export const ([A-Za-z_$][\w$]*) = new ([A-Za-z_$][\w$.]*)\s*\(/

/** Allowlisted singleton identifiers, by basename → id (ADR-0023). */
const EXEMPT_BY_FILE: Readonly<Record<string, string>> = {
  'file-cache.ts': 'fileCache',
  'memory-profiler.ts': 'memoryProfiler',
}

/** Inline escape-hatch marker (requires a trailing reason after the slug). */
const ALLOW_MARKER = '@allow-module-singleton'

/** The last path segment of a dotted constructor (e.g. `node.EventEmitter` → `EventEmitter`). */
function ctorLeaf(ctor: string): string {
  const parts = ctor.split('.')
  return parts.at(-1) ?? ctor
}

/**
 * Pure analysis over one source file's lines. Flags each module-level
 * `export const x = new <MutableCtor>()` that is neither allowlisted nor
 * carries an `@allow-module-singleton` marker. Exported for unit tests.
 */
export function analyzeNoModuleSingleton(content: string, filePath: string): CheckViolation[] {
  const basename = path.basename(filePath)
  const exemptId = EXEMPT_BY_FILE[basename]
  const violations: CheckViolation[] = []
  const lines = content.split('\n')
  for (const [i, line] of lines.entries()) {
    const m = MODULE_SINGLETON_RE.exec(line)
    if (!m) continue
    const [, id, ctor] = m
    if (!MUTABLE_CTOR_RE.test(ctorLeaf(ctor))) continue
    // ADR-0023 allowlist (by file + exact identifier).
    if (id === exemptId) continue
    // Inline escape hatch on this line or the line directly above.
    const above = i > 0 ? (lines[i - 1] ?? '') : ''
    if (line.includes(ALLOW_MARKER) || above.includes(ALLOW_MARKER)) continue
    violations.push({
      line: i + 1,
      filePath,
      message:
        `Module-level singleton 'export const ${id} = new ${ctor}()' holds mutable ` +
        `shared state. Per-run state must live on RunScope and be constructed by a ` +
        `create*Registry() factory the CLI bootstrap calls once per invocation ` +
        `(ADR-0023 / Phase 3) — not a module singleton.`,
      severity: 'error',
      suggestion:
        `Replace with a factory + scope read: 'export function create${id[0]?.toUpperCase()}${id.slice(1)}() { return new ${ctor}() }' ` +
        `attached to scope, read via current<Registry>(). If this is a genuinely ` +
        `run-scoped utility like fileCache/memoryProfiler, add it to the ADR-0023 ` +
        `exemption allowlist or annotate with '// ${ALLOW_MARKER} <reason>'.`,
      type: 'no-module-singleton',
    })
  }
  return violations
}

/**
 * Walk every package-source file in the scanned set and run
 * {@link analyzeNoModuleSingleton}. Non-package-src files contribute nothing.
 * Exported so unit tests can drive it with an in-memory `FileAccessor`.
 */
export async function analyzeAllNoModuleSingleton(files: FileAccessor): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = []
  const candidates = files.paths.filter(
    (p) => PACKAGE_SRC_PATH.test(p) && p.endsWith('.ts') && !p.endsWith('.test.ts'),
  )
  const contents = await files.readMany(candidates)
  for (const [filePath, content] of contents) {
    violations.push(...analyzeNoModuleSingleton(content, filePath))
  }
  return violations
}

export const noModuleSingleton = defineCheck({
  id: '19da4d0d-e933-40f0-87ba-ce4ab554a88e',
  slug: 'no-module-singleton',
  description:
    'No module-level mutable registry/loaded-state singleton; per-run state lives on RunScope via a factory (ADR-0023). fileCache/memoryProfiler are exempt.',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture'],
  fileTypes: ['ts'],
  // raw content: we detect a code-level `export const x = new Ctor(` at column 0,
  // so comments/strings mentioning the pattern do not false-fire.
  contentFilter: 'raw',
  analyzeAll: analyzeAllNoModuleSingleton,
})
