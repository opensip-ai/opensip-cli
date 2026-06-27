/**
 * @fileoverview no-module-level-run-state — fitness's per-run FileCache lives on
 *               `scope.fitness.fileCache` (resolved via `currentScope()`); a
 *               *production* import of the test-only barrel `fileCache` value (or
 *               the legacy `globalFileCache` alias) is a concurrency regression.
 *               Project-local SELF-check for opensip-cli.
 *
 * WHY — parallel-tool-invocations Phase 1 moved fitness's last module-level run
 * cache onto `RunScope` (ADR-0052): the per-run `FileCache` is constructed once
 * per invocation by the fitness tool's `contributeScope()` and placed at
 * `scope.fitness.fileCache`. Every production reader resolves it from the scope
 * (`currentScope()?.fitness?.fileCache`) — never from the process-global module
 * singleton. The module barrel still re-exports `export { fileCache }`
 * (`framework/file-cache.ts` → `index.ts`) but that export is now **test-only**:
 * isolated unit tests seed/clear the singleton; production must not read it. Two
 * overlapping `RunScope`s sharing one process-wide cache `Map` would let run A's
 * `clear()` evict run B's entries, so a new production import of that barrel
 * symbol re-opens the concurrency hazard the Phase 1 migration closed. This is
 * the mechanical realization of CLAUDE.md's "no module-level mutable run state"
 * guardrail and the plan's "No module-level mutable run state" design principle.
 *
 * COEXISTS WITH `no-module-singleton.mjs` — that sibling owns the
 * `export const x = new <MutableCtor>()` / module-`let` shape and *exempts*
 * `fileCache` (`framework/file-cache.ts`) **by file** so the retained-but-
 * test-only singleton DEFINITION does not trip it. This check covers the
 * non-overlapping gap that the file exemption leaves open: a production *import*
 * of that (now test-only) `fileCache` value at any OTHER tool-engine site. The
 * two are additive; neither duplicates the other's detection.
 *
 * SCOPE (path-gated): only the three tool-engine source trees
 * (`packages/{fitness,graph,simulation}/engine/src/`), excluding tests
 * (`*.test.ts` / `__tests__`), the FileCache DEFINITION file
 * (`framework/file-cache.ts`) and the package barrel (`index.ts` — the
 * sanctioned test-only re-export site). Other packages (CLI root, output,
 * dashboard, core) and adopter repos are inert — the path guard makes the check
 * a no-op outside this workspace's tool-engine layout. The dogfood `backend`
 * target's flat `packages/*\/src` glob does NOT reach the nested
 * `packages/{fitness,graph,simulation}/engine/src`, so the check is pinned to
 * `all-ts` in `opensip-cli.config.yml` (mirroring
 * `architecture-session-timing-not-host-owned`) to actually reach the files;
 * the path guard then narrows it back to the tool engines.
 *
 * WHAT IT FORBIDS (precise, not the `FileCache` CLASS): the lowercase `fileCache`
 * *value* binding pulled in by a named import (`import { fileCache }` /
 * `import { fileCache as globalFileCache }`), and any bare `globalFileCache`
 * identifier use. Explicitly ALLOWED: a type-only import
 * (`import type { FileCache }`), the `FileCache` CLASS value import
 * (`import { FileCache }` — production constructs the cache only inside
 * `contributeScope()` / the recipe service), and the per-run scope read
 * `currentScope()?.fitness?.fileCache` (a member-access `.fileCache`, not a
 * bare/imported binding — never matched). A deliberate exception carries an
 * inline `@allow-module-level-run-state <reason>` marker (mirroring
 * `@allow-module-singleton`) so it is reviewable in the diff.
 */
import { defineCheck, stripStringsAndCommentsPreservingPositions } from '@opensip-cli/fitness';

import { toolEnginePathRe } from './tool-engine-paths.mjs';

/**
 * Resolved-path fragment that identifies a tool-engine source file. The check
 * only applies inside the three tool engines; everything else (CLI root, output,
 * dashboard, core) and adopter repos are inert.
 */
const TOOL_ENGINE_PATH = toolEnginePathRe();

/**
 * Path fragments EXCLUDED from the guard even inside a tool engine: the
 * FileCache DEFINITION file (it owns `export const fileCache = new FileCache()`)
 * and the package barrel (`index.ts` — the sanctioned test-only re-export site).
 * A `file-cache.ts` definition or an `index.ts` re-export of the symbol is by
 * design, not a regression.
 */
const EXEMPT_PATH = /(?:framework\/file-cache\.ts$|(?:^|\/)index\.ts$)/;

/** Test files — the barrel `fileCache` is theirs to seed/clear. */
const TEST_PATH = /(?:\.test\.tsx?$|\/__tests__\/)/;

/**
 * A named-import clause that pulls in the lowercase `fileCache` VALUE binding.
 * Matches the binding inside `import { ... }` (NOT `import type { ... }`, which
 * is handled separately) — e.g. `import { fileCache }` and
 * `import { fileCache as globalFileCache }`. Case-sensitive, so the `FileCache`
 * CLASS import never matches. The trailing `(?![\w$])` stops the lowercase token
 * from matching a longer identifier (and `[A-Za-z_$]` is excluded BEFORE so it
 * is a standalone specifier, not the tail of e.g. `getFileCache`).
 */
const VALUE_IMPORT_OF_FILECACHE_RE = /\bimport\s*\{[^}]*\bfileCache\b(?![\w$])[^}]*\}\s*from\b/;

/** `import type { ... }` — a type-only import; `FileCache` here is allowed. */
const TYPE_IMPORT_RE = /\bimport\s+type\b/;

/**
 * The legacy `globalFileCache` alias — its presence anywhere in real code is a
 * regression (Phase 1 removed every production `?? globalFileCache` fallback).
 */
const GLOBAL_FILECACHE_RE = /\bglobalFileCache\b/;

/** Inline escape-hatch marker (requires a trailing reason after the slug). */
const ALLOW_MARKER = '@allow-module-level-run-state';

/**
 * Pure analysis over one source file's lines. Flags a production import of the
 * test-only barrel `fileCache` value or any `globalFileCache` use inside a
 * tool-engine file. Exported so the dogfood `__fixtures__` (Phase 4) — and any
 * future unit test — can exercise the detection without the Check framework,
 * matching the `analyzeDirectStdout` / `analyzeNoModuleSingleton` pattern.
 *
 * CONTENT MODEL: receives RAW content (`contentFilter: 'raw'`). It strips
 * strings + comments ITSELF (position-preserving, so line numbers stay exact)
 * for the import/identifier DETECTION — the tool-engine source carries many
 * prose mentions of `scope.fitness.fileCache` / `globalFileCache` in JSDoc and
 * inline comments that must not false-fire. It checks the `@allow-module-level-
 * run-state` escape-hatch marker against the RAW lines, because that marker
 * lives in a comment — a check that ran on already-comment-stripped content
 * (via the framework's `strip-strings-and-comments` filter) would blank the
 * marker and break the escape hatch. Detecting on stripped code while reading
 * the marker from raw is the only way to satisfy BOTH: prose tolerance AND a
 * comment-based, reviewable escape hatch. Mirrors the `raw` + own-stripping
 * pattern used by `no-tool-owned-session-timing.mjs`.
 */
export function analyzeNoModuleLevelRunState(content, filePath) {
  const norm = filePath.replaceAll('\\', '/');
  // The contract is tool-engine-scoped. The dogfood `all-ts` pin spans every
  // package's src (and tests); narrow to the three tool engines and skip the
  // definition file, the barrel re-export, and test files here.
  if (!TOOL_ENGINE_PATH.test(norm)) return [];
  if (EXEMPT_PATH.test(norm) || TEST_PATH.test(norm)) return [];

  const violations = [];
  // RAW lines carry the escape-hatch marker (a comment). The position-preserving
  // strip blanks strings + comments so the DETECTION regexes never see a prose
  // mention of `fileCache` / `globalFileCache`, while keeping line numbers exact.
  const lines = content.split('\n');
  const codeLines = stripStringsAndCommentsPreservingPositions(content).split('\n');
  for (const [i, codeLine] of codeLines.entries()) {
    const rawLine = lines[i] ?? '';
    // Inline escape hatch on this line or the line directly above — read from the
    // RAW lines (the marker is a comment, blanked in `codeLines`).
    const above = i > 0 ? (lines[i - 1] ?? '') : '';
    if (rawLine.includes(ALLOW_MARKER) || above.includes(ALLOW_MARKER)) continue;

    const importsValue =
      !TYPE_IMPORT_RE.test(codeLine) && VALUE_IMPORT_OF_FILECACHE_RE.test(codeLine);
    const usesGlobalAlias = GLOBAL_FILECACHE_RE.test(codeLine);
    if (!importsValue && !usesGlobalAlias) continue;

    violations.push({
      line: i + 1,
      message:
        "Production tool-engine code must not import the module-level 'fileCache' " +
        "value (or the 'globalFileCache' alias). The per-run FileCache lives on " +
        'scope.fitness.fileCache — resolve it via currentScope()?.fitness?.fileCache. ' +
        'The barrel export { fileCache } is test-only (parallel-tool-invocations ' +
        'Phase 1 / ADR-0052); a process-global cache shared across overlapping ' +
        'RunScopes is a concurrency regression.',
      severity: 'error',
      suggestion:
        "Read the cache from the scope ('const fc = currentScope()?.fitness?.fileCache') " +
        "or thread an injected instance, and import only the 'FileCache' TYPE/CLASS — " +
        "not the lowercase 'fileCache' value. If this is a sanctioned exception, annotate " +
        `with '// ${ALLOW_MARKER} <reason>' so it is reviewable in the diff.`,
      type: 'no-module-level-run-state',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: '062c555c-2a43-4e9d-ae37-17ab835bc238',
    slug: 'no-module-level-run-state',
    description:
      "Production tool-engine code must not import the test-only barrel 'fileCache' value / 'globalFileCache' alias; the per-run FileCache lives on scope.fitness.fileCache (parallel-tool-invocations Phase 1 / ADR-0052). Complements no-module-singleton (which exempts the fileCache definition by file).",
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture', 'scope'],
    fileTypes: ['ts', 'tsx'],
    // RAW content: the analyze function does its OWN position-preserving
    // string+comment strip for the import/identifier DETECTION (so prose
    // mentions of fileCache/globalFileCache in JSDoc never false-fire) while
    // reading the `@allow-module-level-run-state` escape-hatch marker from the
    // raw lines (the marker is a comment — the framework's
    // 'strip-strings-and-comments' filter would blank it and break the hatch).
    // See the analyzeNoModuleLevelRunState header for why both passes are needed.
    contentFilter: 'raw',
    analyze: (content, filePath) => analyzeNoModuleLevelRunState(content, filePath),
  }),
];
