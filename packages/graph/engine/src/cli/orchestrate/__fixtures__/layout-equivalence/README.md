# Layout-equivalence fixtures (H2/H3)

Four structurally-VARIED fixture repos that all encode the **same logical
cross-package graph**. They prove the graph engine's cross-package resolution +
package attribution is **layout-agnostic** — it depends on each file's nearest
`package.json` (its real package `name`), never on a `packages/<segment>` path
shape.

## The one logical graph (every layout encodes exactly this)

Three logical packages — `@eq/core`, `@eq/util`, `@eq/app` — with these edges:

- `app.appRun` → `util.helpFmt` (cross-package, bare workspace import)
- `util.helpFmt` → `core.baseValue` (cross-package, bare workspace import)
- `util.helpFmt` → `util.localPad` (intra-package, RELATIVE import)
- `core.baseValue` → `core.baseValue` (self-recursive leaf)

Plus a **phantom trap**: `@eq/app` also exports a same-named `baseValue` decoy
that `@eq/util` never imports — a name-only resolver would wrongly link
`util.helpFmt → app.baseValue`. The semantic linker must pin the
`@eq/core` specifier to core's `baseValue`, never the decoy.

## The four layouts

| dir       | layout                              | package roots                                  |
| --------- | ----------------------------------- | ---------------------------------------------- |
| `flat/`   | flat `packages/<name>/`             | `packages/core`, `packages/util`, `packages/app` |
| `nested/` | nested `packages/<group>/<name>/`   | `packages/group/core`, `…/util`, `…/app`        |
| `mixed/`  | non-`packages/` monorepo            | `libs/core`, `libs/util`, `apps/app`            |
| `single/` | ONE package at the repo root        | `.` (the repo root itself; no nesting)          |

The first three are genuine multi-package repos that must produce the SAME
package attribution + coupling. `single/` collapses all three logical packages
into ONE real package (the repo root): its cross-package edges become
intra-package edges and the coupling is one self-bucket — the documented
single-package special case. In ALL FOUR the FUNCTION-level call graph (which
function calls which, by logical identity) is identical — that is the
layout-agnostic proof.

Excluded from the TypeScript build (engine `tsconfig.json`), ESLint, and the
repo's `fit:ci` dogfood (the global `**/__fixtures__/**` exclude). The harness
reads these `.ts` files as TEXT, so they are never compiled.
