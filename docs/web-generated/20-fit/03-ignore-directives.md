---
status: current
last_verified: 2026-06-07
release: v0.1.9
title: "Ignore directives"
audience: [contributors, plugin-authors, ci-integrators]
purpose: "Inline source-level suppression — how `@fitness-ignore-next-line` and `@fitness-ignore-file` work, when to use them, and where they fit in the run."
source-files:
  - packages/fitness/engine/src/framework/directive-parsing.ts
  - packages/fitness/engine/src/framework/directive-inventory.ts
  - packages/fitness/engine/src/framework/ignore-processing.ts
related-docs:
  - ./01-recipes-and-checks.md
  - ./04-output-gate-sarif.md
  - ../10-concepts/05-architecture-gate.md
---
# Ignore directives

Sometimes a check is right and the code is right anyway. A complexity check flags a function that's deliberately complex because it's a parser. A no-`console.log` check flags `console.log` in a CLI binary that's *supposed* to print to stdout. A no-circular-imports check flags a circular import that exists for a documented reason.

Ignore directives are how you tell the framework "yes, I know — keep going." They're inline source comments scoped to a specific check and a specific location. The framework parses them, filters violations against them, and records what was suppressed.

> **What you'll understand after this:**
> - The two directive forms and their scoping rules.
> - How directives interact with neighboring linter directives.
> - Where they're applied in the pipeline (after the check runs, not before).
> - When to use a directive vs. fixing the code vs. baselining.

---

## The two forms

```ts
// @fitness-ignore-next-line <slug>      — suppress the next non-directive line
// @fitness-ignore-file <slug>           — suppress every violation in this file
```

Both expect a check slug as the second token (separated by space or tab). The slug must match the offending check's slug. Directives without a slug are ignored — there's no "ignore everything" form, by design.

The parser recognizes the directive after any of four comment openers, so the same syntax works in TypeScript/JavaScript, Markdown/HTML, and shell/YAML/Python sources — see `COMMENT_OPENERS` in [`directive-parsing.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/fitness/engine/src/framework/directive-parsing.ts):

| Opener | Languages |
|---|---|
| `//` | TypeScript, JavaScript, Rust, Go, Java, C/C++ |
| `/* … */` | Same set, plus CSS — the directive must appear on the line after `/*` or inline before `*/` |
| `<!-- … -->` | Markdown, HTML |
| `#` | Shell, YAML, Python, TOML, Dockerfile |

The doc examples below use `//`; substitute the correct opener for your file's language.

### `@fitness-ignore-next-line`

Suppresses violations of the named check on the line immediately following the directive. Tolerates a stack of neighboring linter directives (up to three) before locking onto the actual target — so you can write:

```ts
// @fitness-ignore-next-line no-console-log
// eslint-disable-next-line no-console
// @ts-expect-error -- intentional
console.log(`[startup] PID ${process.pid}`);
```

…and the fitness directive lands on the `console.log` call, even though two unrelated linter directives sit between it and the line. The recognized neighbors are listed in `KNOWN_DIRECTIVE_KEYWORDS` ([`packages/fitness/engine/src/framework/directive-parsing.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/fitness/engine/src/framework/directive-parsing.ts)): `eslint-disable-next-line`, `eslint-disable-line`, `@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `prettier-ignore`, `biome-ignore`, plus the fitness directives themselves.

### `@fitness-ignore-file`

Suppresses every violation of the named check in the entire file. Must appear in the first **50 lines** — directives buried at the bottom of a 5,000-line file aren't found.

```ts
// @fitness-ignore-file complex-function -- this is a hand-written parser; complexity is inherent
import { Lexer } from './lexer';
// ... 800 more lines of complexity ...
```

The trailing `--` justification is a convention, not part of the parser. Anything after the slug is ignored by the directive parser but is visible in code review and to humans reading the file. Justifications are encouraged.

### What's not supported

- **No block form.** There is no `@fitness-ignore-block-start` / `@fitness-ignore-block-end`. If you need to suppress a multi-line region, either move the suppression to the file level (`@fitness-ignore-file`) or pin individual lines.
- **No multi-check directives.** One directive suppresses one check. To suppress multiple, write multiple directives.
- **No wildcard suppression.** No `@fitness-ignore-next-line *`. The slug is required.
- **No expiry.** A directive doesn't know when it's stale. The fitness loop doesn't refuse a directive that points at a check no longer registered, either — the directive simply does nothing in that run.

---

## Where directives are applied

Directives are applied **after** a check runs, not before. The flow inside the framework:

```
1. Check runs, produces Signal[] for the file (no awareness of directives).
2. ignore-processing.ts walks the file content, builds the directive map:
   {
     fileIgnore: Set<slug>,
     lineIgnore: Map<slug, Set<lineNumber>>,
   }
3. The framework filters Signal[]: drop any signal whose slug
   is in fileIgnore OR whose line is in lineIgnore[slug].
4. The applied directives are recorded in DirectiveEntry[] and
   surface in the run summary as `ignoredCount`.
```

Why after, not before? Two reasons:

1. **Directives are accurate.** The check produced the violation by inspecting the line. The framework dropping it after the fact is cheap and side-effect-free; pre-filtering would require the check to know about directives, which couples every check author to the directive parser.
2. **Counts are honest.** The dashboard and the CLI both show "found 5, ignored 2" rather than "found 3." Engineers can spot a file with too many suppressions even though they don't fail the build.

The parser implementation lives in [`packages/fitness/engine/src/framework/directive-parsing.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/fitness/engine/src/framework/directive-parsing.ts). The aggregation that produces the per-run `DirectiveEntry[]` lives in [`packages/fitness/engine/src/framework/ignore-processing.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/fitness/engine/src/framework/ignore-processing.ts) and [`packages/fitness/engine/src/framework/directive-inventory.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/fitness/engine/src/framework/directive-inventory.ts).

---

## When to use a directive vs. baselining vs. fixing

Three options when a check fires. Pick by the answer to "is this code wrong?":

### The code is wrong → fix it

The default. The check exists because the team agreed the pattern is bad. Fix the code; remove the violation.

### The code is right and the check author didn't anticipate this case → directive

A specific, justified exception. The check is right *in general*; this site is the documented exception. Use a directive with a justification:

```ts
// @fitness-ignore-next-line no-console-log -- CLI startup banner is intentional
console.log(banner);
```

Directives are line-local. They're explicit. They're greppable. They survive review.

### The code is right and there are too many sites to mark → baseline

The check fires on dozens of legitimate sites because the rule landed late or because the team's view changed. Use the gate baseline (`--gate-save`) instead. The baseline grandfathers existing violations and only fails on new ones.

```bash
opensip fit --gate-save                # capture today's reality into .runtime/datastore.sqlite
opensip fit --gate-compare             # CI gate from now on
```

The baseline lives in `<project>/opensip-cli/.runtime/datastore.sqlite` (gitignored). For CI to share a baseline across runs, upload that file as a workflow artifact on main-branch builds and download it before `--gate-compare` on PR builds — see [`10-concepts/05-architecture-gate.md#ci-integration-patterns`](/docs/opensip-cli/10-concepts/05-architecture-gate/#ci-integration-patterns).

### When NOT to directive

A directive becomes a problem when:

- **It has no justification.** A directive without a comment of *why* is a smell. Future you will not remember.
- **It's repeated more than ~3 times in one file.** That's a baseline shape. Move it to the file level (`@fitness-ignore-file`) or to the gate baseline.
- **It's repeated more than ~10 times in the project.** That's a check shape. Either the check is wrong (the author should refine the rule) or the team's policy is wrong (the rule should be retired).

The dashboard's per-tool Catalog subtab and the CLI's `--verbose` detail view both surface directive counts; a check with hundreds of suppressions across the repo deserves a second look. (There is no separate top-level "Ignored" tab today — the suppressions are inlined into the same panels that show findings.)

---

## How directives appear in output

The `DirectiveEntry` shape ([`packages/fitness/engine/src/framework/directive-inventory.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/fitness/engine/src/framework/directive-inventory.ts)) carries:

- The check slug being suppressed.
- The file path.
- The directive line.
- The kind (`'next-line'` | `'file'`).
- Whether the directive matched any actual violation (i.e. did this directive *do* anything?).

The CLI's `--verbose` output groups violations by check and the table renderer surfaces an `ignored` count per row (`SignalTableRow.ignored` in [`packages/output/src/format/signal-table.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.9/packages/output/src/format/signal-table.ts), derived from `envelope.units[].ignoredCount`). The dashboard reads the same session record. The contract-stable JSON output (the `SignalEnvelope`) carries the per-unit suppression count as `units[].ignoredCount` (fitness-only), so a CI consumer can read it off `--json` directly; the full `appliedDirectives` detail (which directive matched which line) still lives only in the internal session record on disk.

A directive that didn't match any violation (e.g. the targeted check no longer fires there) is *also* tracked internally. This is how you find stale suppressions: the directive exists in the source, and the framework reports zero violations matched it. A separate housekeeping pass can flag those for cleanup.

---

## Where the example lands

For `acme-api`:

- One file, `services/api/src/cli/banner.ts`, prints to stdout intentionally. It carries `// @fitness-ignore-file no-console-log -- CLI banner output`. The `no-console-log` check produces zero violations on that file (a `console.log` call is suppressed before the count is reported).
- One legacy module, `services/api/src/legacy/parser.ts`, has a single line marked `// @fitness-ignore-next-line complex-function -- inherent state-machine complexity, see ADR-0011`. The complexity check fires elsewhere; this one site is suppressed.
- Three sites in `pipelines/etl/scripts/` use `print()` deliberately for stdout output. They carry per-line directives.

The CLI's run summary reports: "12 violations found, 5 ignored." CI gates on the 12; the 5 are visible but don't fail the build.

---

## What's next

- **[`04-output-gate-sarif.md`](/docs/opensip-cli/20-fit/04-output-gate-sarif/)** — what happens to the surviving violations: render layer, JSON output, SARIF, the gate.
- **[`../10-concepts/05-architecture-gate.md`](/docs/opensip-cli/10-concepts/05-architecture-gate/)** — the complementary mechanism for legacy violation sets.
