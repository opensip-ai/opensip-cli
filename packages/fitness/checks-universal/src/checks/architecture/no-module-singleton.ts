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
import path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';

/** A first-party package source file (excludes tests + build output). */
const PACKAGE_SRC_PATH = /packages\/[^/]+\/(?:[^/]+\/)?src\//;

/** Constructor-name shapes that denote mutable shared state. */
const MUTABLE_CTOR_RE =
  /^(?:[A-Z]\w*(?:Registry|Store|Cache|Profiler|Emitter)|EventEmitter|Map|Set|WeakMap|WeakSet)$/;

/**
 * Module-level singleton export:
 *   `export const <id> = new <Ctor>(`
 * Anchored at column 0 (a top-level export, not a nested local). Captures the
 * exported identifier and the constructed type name.
 */
const MODULE_SINGLETON_RE = /^export const ([A-Za-z_$][\w$]*) = new ([A-Za-z_$][\w$.]*)\s*\(/;

/**
 * Module-level mutable `let` binding at column 0. Captures the id and the optional
 * type annotation. A module `let` is reassignable shared state by definition; this
 * narrows to the two shapes the audit's F1/F2 took (a loaded-state marker, a
 * mutable-accumulator instance) so legit process-globals don't false-fire.
 */
// `[^=\n]` is disjoint from the absent `=`/newline terminators, so the greedy
// capture is linear (no catastrophic backtracking — the lazy form tripped slow-regex).
const MODULE_LET_RE = /^let ([A-Za-z_$][\w$]*)\s*(?::\s*([^=\n]+))?/;

/**
 * A `let` id naming cross-call LOADED-STATE — the F1 shape (`scenariosLoadedFor`,
 * `checksLoadedFor`). A per-run "have I loaded yet" marker belongs on RunScope.
 */
const LOADED_STATE_NAME_RE = /Loaded(?:For)?$/;

/**
 * A `let` TYPE annotation naming a mutable ACCUMULATOR — the F2 shape
 * (`activeCache: LanguageParseCache`). Deliberately EXCLUDES `*Registry`: the
 * CLI's per-run context holders (`cli-context.ts`) are a sanctioned bootstrap
 * seam, not a leak, and the AsyncLocalStorage scope is the per-run isolation.
 */
const MUTABLE_LET_TYPE_RE =
  /\b(?:[A-Z]\w*(?:Cache|Store|Profiler|Emitter)|EventEmitter|Map|Set|WeakMap|WeakSet)\b/;

/** Allowlisted singleton identifiers, by basename → id (ADR-0023). */
const EXEMPT_BY_FILE: Readonly<Record<string, string>> = {
  'file-cache.ts': 'fileCache',
  'memory-profiler.ts': 'memoryProfiler',
};

/** Inline escape-hatch marker (requires a trailing reason after the slug). */
const ALLOW_MARKER = '@allow-module-singleton';

/** The last path segment of a dotted constructor (e.g. `node.EventEmitter` → `EventEmitter`). */
function ctorLeaf(ctor: string): string {
  const parts = ctor.split('.');
  return parts.at(-1) ?? ctor;
}

/**
 * Pure analysis over one source file's lines. Flags each module-level
 * `export const x = new <MutableCtor>()` that is neither allowlisted nor
 * carries an `@allow-module-singleton` marker. Exported for unit tests.
 */
export function analyzeNoModuleSingleton(content: string, filePath: string): CheckViolation[] {
  const basename = path.basename(filePath);
  const exemptId = EXEMPT_BY_FILE[basename];
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    // Inline escape hatch on this line or the line directly above.
    const above = i > 0 ? (lines[i - 1] ?? '') : '';
    const suppressed = line.includes(ALLOW_MARKER) || above.includes(ALLOW_MARKER);

    const constViolation = matchConstSingleton(line, i, filePath, exemptId, suppressed);
    if (constViolation) {
      violations.push(constViolation);
      continue;
    }
    const letViolation = matchMutableLet(line, i, filePath, exemptId, suppressed);
    if (letViolation) violations.push(letViolation);
  }
  return violations;
}

/** `export const <id> = new <MutableCtor>(` — the classic module-singleton shape. */
function matchConstSingleton(
  line: string,
  i: number,
  filePath: string,
  exemptId: string | undefined,
  suppressed: boolean,
): CheckViolation | null {
  const m = MODULE_SINGLETON_RE.exec(line);
  if (!m) return null;
  const [, id, ctor] = m;
  if (!MUTABLE_CTOR_RE.test(ctorLeaf(ctor)) || id === exemptId || suppressed) return null;
  return {
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
  };
}

/**
 * `let <id>[: <MutableType>] =` at column 0 — the F1/F2 audit shapes: a per-run
 * loaded-state marker (`*Loaded`/`*LoadedFor`) or a mutable-accumulator instance
 * (`: *Cache`/`Map`/…). These belong on RunScope, not a module `let`.
 */
function matchMutableLet(
  line: string,
  i: number,
  filePath: string,
  exemptId: string | undefined,
  suppressed: boolean,
): CheckViolation | null {
  const m = MODULE_LET_RE.exec(line);
  if (!m) return null;
  const [, id, typeAnnotation] = m;
  const flagged =
    LOADED_STATE_NAME_RE.test(id) ||
    (typeAnnotation !== undefined && MUTABLE_LET_TYPE_RE.test(typeAnnotation));
  if (!flagged || id === exemptId || suppressed) return null;
  return {
    line: i + 1,
    filePath,
    message:
      `Module-level mutable 'let ${id}' holds per-run shared state (loaded-state ` +
      `marker or mutable accumulator). Two concurrent runs would share it. Move it ` +
      `onto RunScope (a scope subslot like scope.fitness.load) — the audit's F1/F2 fix.`,
    severity: 'error',
    suggestion:
      `Replace the module 'let' with a scope-owned slot: add the field to the tool's ` +
      `RunScope subscope (e.g. scope.<tool>.load) via its contributeScope() hook, and ` +
      `read it through a current<Tool>LoadState() accessor. If this is a genuine ` +
      `process-global (a sanctioned seam), annotate with '// ${ALLOW_MARKER} <reason>'.`,
    type: 'no-module-singleton',
  };
}

/**
 * Walk every package-source file in the scanned set and run
 * {@link analyzeNoModuleSingleton}. Non-package-src files contribute nothing.
 * Exported so unit tests can drive it with an in-memory `FileAccessor`.
 */
export async function analyzeAllNoModuleSingleton(files: FileAccessor): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = [];
  const candidates = files.paths.filter(
    (p) =>
      PACKAGE_SRC_PATH.test(p) &&
      p.endsWith('.ts') &&
      !p.endsWith('.test.ts') &&
      !p.includes('/__fixtures__/'), // fixtures carry DELIBERATE violations for other checks
  );
  const contents = await files.readMany(candidates);
  for (const [filePath, content] of contents) {
    violations.push(...analyzeNoModuleSingleton(content, filePath));
  }
  return violations;
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
});
