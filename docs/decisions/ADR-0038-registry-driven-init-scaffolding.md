---
status: active
last_verified: 2026-06-11
owner: opensip-tools
---

# ADR-0038: `init` scaffolds the registered tools, not a hardcoded fit/sim set

```yaml
id: ADR-0038
title: '`init` scaffolds the registered tools, not a hardcoded fit/sim set'
date: 2026-06-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0009, ADR-0023, ADR-0027]
tags: [cli, init, scaffolding, parity]
enforcement: mechanizable
enforcement-reason: >
  Three guards: (1) `init` output for a fit+sim project is byte-identical to today
  (golden-file test — the relocation is behavior-preserving); (2) a fixture tool
  with a `pluginLayout` + `scaffoldExamples` hook is scaffolded by `init` with NO
  `packages/cli` change (the registry-driven proof); (3) `graph` (no `pluginLayout`)
  produces no directory. A grep guard asserts no `'fit'`/`'sim'`/`'checks'`/
  `'recipes'`/`'scenarios'` literal remains in `scaffold-writer.ts`.
```

**Decision:** `init` scaffolds each **registered tool's** project layout from its
`pluginLayout` (`{domain, userSubdirs}`) plus a **tool-shipped example
contribution** (a new optional `Tool.scaffoldExamples(ctx)` hook), instead of the
CLI hardcoding `fit`/`sim` directories and owning the example `.mjs` source. The
`plugin` command is already registry-driven off `pluginLayout` and
`paths.userPluginDir(domain, kind)` is already generic; `init` is the one remaining
place the kernel-carries-no-tool-vocabulary principle (ADR-0009) leaks. A new tool
that ships a `pluginLayout` (+ examples) scaffolds with **zero CLI edits**; `graph`
(no project-local plugins, no `pluginLayout`) contributes nothing and is correctly
absent.

**Alternatives:**

- **Extend `PluginLayout` with the example templates** (static). Rejected: example
  content is *dynamic* — it varies by detected language (polyglot suffixes) and
  carries pinned, stable ids; a function (`scaffoldExamples(ctx)`) expresses that,
  a static layout field cannot. `PluginLayout` stays the pure structural
  `{domain, userSubdirs}`.
- **Keep example content + the `fitness:` config block in the CLI.** Rejected: it is
  exactly the fit/sim vocabulary ADR-0009 says the host must not carry; it is the
  one seam where adding a tool still requires a `packages/cli` change.
- **A dedicated `scaffoldConfigBlock()` hook for the config fragment.** Deferred,
  not chosen: prefer rendering the per-tool config block from the tool's existing
  `ToolConfigDeclaration` defaults (ADR-0023) — fewer sources of truth — and fall
  back to a hook only if the commented-defaults rendering cannot reproduce today's
  block faithfully (the byte-identical test decides).

**Rationale:**

The path layer is already registry-ready: `paths.userPluginDir(domain, kind)` is
generic, and `cli/src/index.ts` already aggregates `pluginLayout`s from the tool
registry for the `plugin` command — `init` simply doesn't use the same list.
`PluginLayout {domain, userSubdirs}` already exists; fitness and sim set it, graph
sets none. So the generalization is a *finishing move*, not a redesign: drive the
scaffold loop off the list the host already builds, and move the example `.mjs`
builders (and their stable ids) from `config-templates.ts` into their owning tool
packages. The result removes the last "adding a tool requires CLI changes" seam on
the authoring plane.

**Consequences:**

- **`scaffold-writer.ts` becomes a generic loop** over `pluginLayout`s; all
  `'fit'`/`'sim'`/`'checks'`/`'recipes'`/`'scenarios'` literals are removed. Example
  builders move to `fitness`/`simulation` behind `Tool.scaffoldExamples(ctx:
  {languages, slugs})`.
- **Stable ids move with the content.** `file-classifier.ts`'s stale-scaffolded
  detection must aggregate ids from the registered tools' hooks instead of importing
  the CLI-owned `EXAMPLE_CHECK_IDS` (same values → behavior-preserving). The
  classifier is a touched file, not only `scaffold-writer.ts`.
- **Newly load-bearing contract change: `init` scaffolds the *registered* set.**
  Today it always scaffolds fit/sim regardless of what is installed; registry-driven
  means the scaffolded set = the tools loaded at init time (bundled first-party
  always; a third-party tool once installed/discoverable; a tool installed *after*
  `init` scaffolds on the next `init --keep`). Strictly more correct (no phantom dirs
  for absent tools) but a deliberate behavioral change to document — and one the
  byte-identical fit+sim golden test does not exercise, so a separate "registered-set
  drives scaffolding" assertion is required.
- **Preserved verbatim:** the four-state machine (`pristine` / `fully-initialized` /
  `partial-config-only` / `partial-dir-only`), `--keep` / `--remove`, `.runtime/`
  content-ignoring, and `writeScaffoldedFile` preservation. This ADR changes *what*
  gets scaffolded, not *when/whether*.
- **Config generation:** the document header + `targets:` stay host-rendered
  (`renderDocumentHeader`); per-tool config blocks come from the tool (rendered from
  its `ToolConfigDeclaration` defaults where faithful; else a tool hook).

**Related specs / ADRs:** Applies ADR-0009 (public-API surfaces; the kernel/CLI
carries no per-tool vocabulary) to `init`, the last place it leaks. Reuses ADR-0023
(tool config declarations) for the per-tool config-block rendering, and continues
the ADR-0027 "host owns the plane, tool declares a manifest" parity model
(scaffolding becomes one more host-owned plane driven off the tool's declaration).
The implementing spec is `docs/plans/specs/registry-driven-init-scaffolding.md`
(local-only); a pre-flight task confirms whether a byte-exact init golden test
already exists and, if not, writes it against today's behavior before any refactor.
