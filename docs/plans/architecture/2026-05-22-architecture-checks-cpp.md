---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/checks-cpp"
package: "@opensip-tools/checks-cpp"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/checks-cpp

## Summary

`@opensip-tools/checks-cpp` is the smallest fitness pack in the
workspace: one check (`cpp-clang-tidy`), one barrel, three test files.
It is the canonical example of the `command` analysis mode in
`defineCheck` — it shells out to the user's locally-installed
`clang-tidy`, reads stdout, and converts each diagnostic line to a
`CheckViolation`. Because it is a pure passthrough (no rule curation,
no embedded `--checks=…`), the design is intentionally thin and the
surface area to audit is small.

The pack-shape is internally consistent with siblings (`checks-go`,
`checks-java`, `checks-python`): identical layout
(`src/index.ts`, `src/checks/`, `src/__tests__/`), identical barrel
shape (`checks` tuple + named re-exports + `metadata` literal),
identical tsconfig/vitest config. The `command` mode is well-suited to
clang-tidy and the parser is correctly factored as a pure function and
exported for unit testing — both things siblings using `analyze` mode
do not need.

The findings below are mostly small. The most material one is that the
parser captures the file path in regex group 1 but never reads it, so
violations land in the framework with `filePath = ''`, losing
file-level grouping in reports. The second is structural: the regex
parser is brittle compared to clang-tidy's available structured
outputs (`-export-fixes <yaml>`), and primitive-obsessing on
`{line, column, severity, lintName}` strings rather than capturing
clang-tidy's richer signal shape (notes attached to diagnostics, fix
hints, applicable lint URL).

## Existing patterns (correct usage)

- **Pure parser exported separately from the check.** `parseClangTidyOutput`
  is a top-level function with primitive in/out (`stdout, stderr,
  exitCode, files, cwd → CheckViolation[]`) and is unit-tested in
  `parse.test.ts` and `clang-tidy.test.ts` without spawning a subprocess.
  The check definition itself is exercised end-to-end in `run.test.ts`.
  This split is exactly what `command` mode invites: a thin wiring layer
  around a pure function. The Go/Java/Python checks use the same
  factoring for `analyze` (e.g. `analyzeFmtPrint`), so the convention is
  consistent across the language packs.
  - Files: `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts`,
    `packages/fitness/checks-cpp/src/__tests__/parse.test.ts`,
    `packages/fitness/checks-cpp/src/__tests__/clang-tidy.test.ts`,
    `packages/fitness/checks-cpp/src/__tests__/run.test.ts`.

- **`expectedExitCodes` declares clang-tidy's protocol.**
  `expectedExitCodes: [0, 1]` correctly tells the framework that
  exit 1 with diagnostics on stdout is normal, not a tool failure.
  Without this, `command-executor.ts` would treat exit 1 as
  "Command exited with unexpected code" and discard the violations.
  - Files: `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:66`,
    `packages/fitness/engine/src/framework/command-executor.ts:84-94`.

- **Per-check `timeout: 30_000` cap.** clang-tidy can stall on
  unfamiliar TUs (cold-spawn + system-header scan); the 30s cap
  delegates abort plumbing to `executeCommand` → `execAbortable` →
  process-group `SIGKILL`, and `run.test.ts` documents the contract
  explicitly (clean abort = success). Sibling packs that use
  `analyze` mode don't need timeouts; `checks-cpp` correctly does.
  - Files: `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:58`,
    `packages/fitness/checks-cpp/src/__tests__/run.test.ts:13-49`.

- **`scope: { languages: ['cpp'], concerns: [] }` matches the cpp
  language adapter.** The lang-cpp adapter's id is `'cpp'` with
  aliases `['c', 'c++']`, and its file extensions cover both C and
  C++. The check's empty `concerns` correctly declares "any concern".
  - Files: `packages/languages/lang-cpp/src/adapter.ts:14-21`.

- **`args: (files) => [...files, '--quiet']` defers to user's
  `.clang-tidy`.** The check is a deliberate passthrough — it does not
  inject `--checks=…`, so the user's repo-level `.clang-tidy` is the
  source of truth. This is the right call for an MVP and the file
  header documents it.
  - Files: `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:1-8,61`.

- **No subpath imports from the engine.** The check imports
  `defineCheck` and `CheckViolation` from the `@opensip-tools/fitness`
  barrel — the layering rule from `CLAUDE.md` ("subpath exports are
  strongly discouraged") is honoured.

- **Pack-shape consistency with siblings.** `package.json` (deps,
  scripts, exports), `tsconfig.json`, and `vitest.config.ts` mirror
  `checks-go`/`checks-java`/`checks-python` exactly. The barrel
  follows the same pattern (named tuple `checks`, named re-exports,
  `metadata` literal).

## Findings

### Parser captures the file path but discards it — violations lose `filePath`

- **Files / code:**
  - `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:12,21-46`
  - `packages/fitness/engine/src/framework/define-check.ts:158-189` (`executeCommandMode` passes
    `defaultFilePath = undefined`)
  - `packages/fitness/engine/src/framework/define-check.ts:51-79` (`toSignal` falls back to
    `''` when both `violation.filePath` and `defaultFilePath` are missing)
- **Pattern / principle:** Information loss across an adapter boundary.
  The regex `^(.+?):(\d+):(\d+):\s+(warning|error|note):\s+(.+?)(?:\s+\[([\w\-,.]+)\])?$`
  captures the file path as group 1, but the parser body only reads
  groups 2 (line), 4 (severity), 5 (message), 6 (lint name). `match[1]`
  is never assigned to `violation.filePath`. Combined with command
  mode's `defaultFilePath = undefined`, every clang-tidy violation
  ends up as a `Signal` with `code.file = ''`.
- **Status:** Active bug. Confirmed by reading both the parser source
  and `executeCommandMode` — there is no other code path that fills
  `filePath` for command-mode violations.
- **Why it matters:**
  - Reports group findings by file (dashboard, SARIF export, gate
    diffs); empty file paths collapse all clang-tidy diagnostics into
    one synthetic "no file" bucket.
  - Per-check exemptions (`@fitness-ignore-file`) need a real file
    path to attach to.
  - SARIF output (`packages/fitness/engine` → external consumers)
    expects each result to have a physicalLocation; an empty URI is
    a downstream defect.
  - The semgrep sibling check in `checks-universal` does this
    correctly:
    `filePath: path.isAbsolute(result.path) ? result.path : path.join(cwd, result.path)`
    (`packages/fitness/checks-universal/src/checks/security/semgrep-scan.ts:79`).
- **Recommendation:** Capture group 1 and resolve to absolute under
  `cwd`. Sketch:
  ```ts
  const rawPath = match[1]
  const filePath = rawPath
    ? (path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath))
    : undefined
  violations.push({ /* …existing… */, filePath, column: Number.parseInt(match[3], 10) })
  ```
  Also pick up `match[3]` for `column`, which the parser currently
  drops (group 3 is captured but never read; `CheckViolation.column`
  is optional and clang-tidy provides it for free). Update
  `parse.test.ts` / `clang-tidy.test.ts` with assertions on `filePath`
  and `column`.

### Brittle regex parsing of clang-tidy's textual output

- **Files / code:**
  - `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:11-12,21-46`
- **Pattern / principle:** Adapter pattern over an external tool.
  The job of an adapter is to translate the foreign tool's data model
  into ours. Using the human-readable diagnostic format as the wire
  format is the *least* robust option clang-tidy offers — its output
  format isn't a documented contract and varies subtly across
  versions (Windows path drive letters with `:`, multi-line messages,
  trailing build-warning lines like `N warnings generated.`, ANSI
  color when not piped, header/inline-include diagnostic prefixes).
  The regex's first capture group `(.+?)` matches the file path
  non-greedily up to the first `:` — on Windows, `C:\proj\foo.cpp:42:10`
  will capture `C` and assign line `\proj\foo.cpp` (which then fails
  `Number.parseInt`).
- **Status:** Latent fragility. Tests cover the happy path and use
  POSIX-style paths exclusively; nothing exercises Windows paths,
  multi-line `note:` chains, or `clang-tidy --quiet`'s actual
  out-of-band lines (`clang-tidy: warning: ignoring -Wunused-…`).
  Comment in code already flags one of these (note continuations are
  "kept simple for MVP").
- **Why it matters:**
  - clang-tidy supports structured output via
    `-export-fixes=<file.yaml>`, which emits a YAML schema with
    `Diagnostics: [{DiagnosticName, Message, FileOffset, Replacements,
    Notes, …}]`. Parsing that is far more reliable than regex over the
    rendered console output and gives access to richer metadata
    (notes-as-children, fix replacements, file offsets).
  - The same engineering pattern is already proven in the codebase:
    `parseSemgrepOutput` consumes JSON with explicit type
    declarations (`SemgrepResult`, `SemgrepOutput`) and a tiny
    `mapSeverity` helper. That's the more durable shape.
  - Primitive obsession: today's `CheckViolation` from this parser is
    a flattened string (`[lint-name] message`); we lose the
    fine-grained dimensions (`lintName`, `notes[]`, fix replacements)
    that downstream consumers (dashboard, gate, SARIF) could surface
    if we kept them as fields.
- **Status:** Design-direction observation, not a bug today.
- **Recommendation:** When the check moves beyond MVP, switch to
  `clang-tidy --export-fixes=<tmp>.yaml` and parse YAML with a
  declared type (mirroring `SemgrepOutput`). Surface `notes` and
  `replacements` via `CheckViolation.fix`. Keep the regex parser as a
  fallback only if a clang-tidy version doesn't support
  `-export-fixes`. Until that work happens, at minimum add a Windows
  path test case and tighten the regex (use a character class that
  excludes `:` only after the optional drive letter, or anchor on
  `: (warning|error|note):` and split backwards from there).

### `note:` lines silently dropped instead of attached to prior diagnostic

- **Files / code:**
  - `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:14-19,37`
  - JSDoc says "note lines are attached to the prior diagnostic when
    possible (kept simple for MVP — current implementation skips them)."
- **Pattern / principle:** Code/doc divergence. The contract documented
  in the JSDoc is not the contract implemented. `if (severity === 'note')
  continue` unconditionally discards them.
- **Status:** Documented-but-not-implemented behaviour. Tests assert
  the *current* (skip) behaviour, which means the JSDoc is the false
  one. Either the doc or the code needs to change.
- **Why it matters:**
  - clang-tidy uses `note:` to point to the actual misuse site (e.g.
    a warning at the function declaration with a `note:` at the call
    site). Dropping notes loses real navigational value.
  - Future maintainers reading the JSDoc will assume notes are
    associated and design around that — they aren't.
- **Recommendation:** Pick one:
  - **Quick fix** (no behaviour change): update JSDoc to "note: lines
    are dropped" — honest and matches the test suite.
  - **Better fix** (small behaviour change): track the previous
    non-note violation and append note text into its `suggestion`
    field, e.g. `suggestion: 'See clang-tidy docs … (note: <text>)'`.
    `CheckViolation` doesn't carry related-locations, so this is the
    only honest place to surface notes without expanding the type.
  - **Best fix** (structural): adopt `-export-fixes` YAML, where notes
    are first-class children of diagnostics, and feed them through a
    `relatedLocations: ReadonlyArray<{file, line, message}>` field on
    `CheckViolation`. This is a fitness-engine change, not a
    checks-cpp change, so it lives in the same future workstream as
    the brittle-regex finding above.

### Static `args` constant declared at module scope without need

- **Files / code:**
  - `packages/fitness/checks-cpp/src/checks/clang-tidy-passthrough.ts:11-12`
    (`CLANG_TIDY_LINE` regex)
  - `command.args: (files) => [...files, '--quiet']`
- **Pattern / principle:** Minor. The `args` closure allocates a new
  array on every invocation but `'--quiet'` is constant; pulling
  flags into a `const QUIET_ARGS = ['--quiet'] as const` and then
  `args: (files) => [...files, ...QUIET_ARGS]` is a tiny readability
  win and aligns with how `semgrep-scan.ts` builds its arg list. This
  is paint-not-glue territory.
- **Status:** Micro-style observation.
- **Why it matters:** Almost nothing — runs once per check
  invocation. Mentioned only because the pack is so small that style
  consistency with `semgrep-scan.ts` (a peer command-mode example) is
  achievable.
- **Recommendation:** Optional cleanup. Skip unless the pack grows a
  second clang-tidy-backed check that wants the same flags.

## Non-findings considered and dismissed

- **"Pack should have a `display/` directory like checks-typescript."**
  Dismissed. The display map is optional and falls back to
  kebab-to-title-case (per `CLAUDE.md` and `getDisplayName` in
  `packages/fitness/engine/src/cli/fit.ts:291`). With one check, the
  fallback is fine, and the smaller sibling packs (checks-go, -java,
  -python) deliberately omit the directory too. Adding one for a
  single slug would be ceremony without payoff.

- **"Pack should embed a curated `--checks=…` set."**
  Dismissed. The file header explicitly chooses passthrough as the MVP
  contract, deferring rule selection to the user's `.clang-tidy`. That
  is a defensible product decision: clang-tidy ships with hundreds of
  rules across competing taxonomies (`hicpp-*`, `modernize-*`,
  `cppcoreguidelines-*`), and curating them is a separate exercise from
  shipping a working passthrough. Worth revisiting when a sister
  "clang-tidy-recommended" check is added; not a flaw in this one.

- **"Should use `--export-fixes` instead of stdout regex" — flagged
  but not as a finding here.** Surfaced as a recommendation in the
  brittle-regex finding above; not a separate finding because today's
  parser does work for simple cases and the test suite covers them.
  The MVP-vs-future distinction is what makes this an evolution
  recommendation rather than a current-state defect.

- **"Why does `_stderr` / `_exitCode` / `_files` / `_cwd` get
  underscore-prefixed and ignored?"** Dismissed. The `command` mode
  contract requires the parser signature `(stdout, stderr, exitCode,
  files, cwd) => CheckViolation[]` — see
  `packages/fitness/engine/src/framework/check-config.ts:140-151`.
  Underscoring unused parameters is the standard ESLint convention
  here. A future implementation that consumes `cwd` (to resolve
  relative file paths from clang-tidy) would flip the underscore off
  — and that work is captured under the `filePath` finding.

- **"Pack lacks fixtures directory."** Dismissed. Command-mode checks
  test the parser directly with synthetic stdout strings — there's no
  filesystem to fixture, and `run.test.ts` deliberately hits a
  non-existent path to exercise the not-installed branch. This is
  appropriate for command mode.

- **"`scope.languages: ['cpp']` should also list `'c'`."** Dismissed.
  The lang-cpp adapter declares `aliases: ['c', 'c++']`, and the
  registry is alias-aware — declaring a single canonical language id
  is the convention. The check's tag list also includes `'cpp'` for
  filtering.

- **"`description` and `tags` are too terse / missing
  `longDescription`."** Dismissed. Sibling checks vary widely in
  long-description verbosity (semgrep-scan has a very long one,
  no-fmt-print has none). Adding marketing copy is not a structural
  finding.
