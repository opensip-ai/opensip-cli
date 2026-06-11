---
status: active
last_verified: 2026-06-11
owner: opensip-tools
---

# ADR-0037: File-targeting resolution is a host runtime substrate, not a fitness-private capability

```yaml
id: ADR-0037
title: File-targeting resolution is a host runtime substrate, not a fitness-private capability
date: 2026-06-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0010, ADR-0023]
tags: [config, targeting, discovery, parity]
enforcement: mechanizable
enforcement-reason: >
  Two guards: (1) a non-fitness fixture tool resolves a named target's files via
  `scope.targets` with NO `@opensip-tools/fitness` import (the adoption proof);
  (2) a fitness per-check file-set golden test is byte-identical pre/post (the
  migration is behavior-preserving). A dependency-cruiser rule pins the new
  `@opensip-tools/targeting` package's deps to `config` + `glob`/`minimatch` and
  forbids a `core` tool-vocabulary import.
```

**Decision:** The **generic half** of file targeting — named file-sets
(`include`/`exclude` globs), `globalExcludes`, glob expansion, and tag/scope target
matching — becomes a **host runtime substrate** (`@opensip-tools/targeting`) any
tool consumes via `scope.targets`, finishing what ADR-0023 started when it moved
the targeting *types* into the host `@opensip-tools/config` layer "explicitly
anticipating cross-tool use" but left the *runtime* in fitness. The
**check-domain half** stays in fitness: the check-slug `checkOverrides`, the
`checkOverrides > scope-match > fileCache` precedence (`resolveFilesForCheck`), the
content `fileCache`, and the unknown-target cross-validation. Fitness becomes a
thin consumer of the substrate rather than its owner.

**Alternatives:**

- **Fold the runtime into `@opensip-tools/config`.** Rejected: `config` owns
  config-*document* parsing/loading; growing it a `glob`/`minimatch`/fs-walk
  dependency puts filesystem discovery in the config-parsing layer — the wrong
  concern boundary. (Note: `config` is *not* types-only — that is `contracts`; the
  objection is the new dependency, not a types-only rule.)
- **Put it in `core`.** Rejected: `core` is a strict kernel — no glob, no
  file-walking. A small peer package alongside `lang-*`/`output` is the
  layer-clean home.
- **Generalize the whole resolution path, including `checkOverrides` + the 3-tier
  precedence + the content `fileCache`.** Rejected: `checkOverrides` is keyed by
  *check slug* and the content cache is a check concern (graph/sim have neither a
  per-unit override nor a content-cache concept). Lifting them would invent a
  "unit" abstraction no tool needs; the substrate exposes file-set resolution, and
  each tool keeps its own unit→target binding.
- **Leave it in fitness; let other tools re-derive glob expansion.** Rejected: it
  is the stated-but-unfinished cross-tool intent of ADR-0023, and re-deriving glob
  expansion per tool is exactly the duplication the host is meant to absorb.

**Rationale:**

ADR-0023 already relocated the targeting *vocabulary* to the host
(`config/src/document/targeting.ts`) with a header that says a project shipping
only `graph` should resolve scope "through the same model" — but the runtime never
followed, so today the model is real only for fitness (grep confirms zero external
importers of `TargetRegistry`/`resolveTargetFiles`). The file-set layer (named
sets, `globalExcludes`, glob→dedup→sort, tag/scope matching) is pure, generic path
logic; only the *binding* (which unit declares which scope) is tool-shaped. The
clean cut is therefore: substrate = file-set resolution; fitness = check binding.
The move also lets a latent dead-code defect be retired — fitness's
`resolver.ts:resolveTargetFiles` never applied `globalExcludes`, but it is
production-dead (only caller is its own unit test), so the substrate ships one
`resolveTargets` that always applies both excludes and the dead path is deleted,
not fixed.

**Consequences:**

- **New `@opensip-tools/targeting` package** (peer of `lang-*`/`output`; deps:
  `core` — the generic `Registry<T>` base only, NOT its tool vocabulary (the
  enforcement gate above forbids the latter) — plus `config` types and
  `glob`/`minimatch`). Holds `TargetRegistry` (register/get/byTag),
  `resolveTargets(names) → files`, `applyGlobalExcludes`, `preResolveAllTargets`.
- **`scope.targets`** — the host builds the registry once per run from the loaded
  config document and exposes it on `RunScope`, mirroring `scope.toolConfig` /
  `scope.languages`. Any tool reads it; no tool re-loads config.
- **Fitness migrates to consumer.** `resolveFilesForCheck`, the check-slug
  `checkOverrides` cross-validation (`targets/loader.ts`), and `file-cache.ts` stay
  in fitness and read `scope.targets` for the glob mechanics.
- **`findByScope` (languages + concerns) — lean: stays in fitness.** `concerns` is
  intrinsically a check-scope concept; the substrate ships only
  `resolveTargets`/`findByTag`/`applyGlobalExcludes`, keeping it free of any "unit
  declares languages+concerns" assumption. Revisit only if a concrete second
  consumer wants scope matching (the spec records this as the one open call).
- **`globalExcludes` is now applied uniformly** (the dead inconsistent path is
  deleted; a regression test pins uniform exclusion).
- **Graph adoption is a separate, optional follow-up.** Landing the substrate +
  fitness migration is a behavior-preserving refactor whose immediate value is
  *enabling* (proven by the fixture-tool test); the concrete payoff arrives when
  graph honors `globalExcludes`/`targets:` (a later change) or a third-party tool
  adopts it. sim does no file discovery and is untouched.

**Related specs / ADRs:** Finishes ADR-0023 (config consolidation moved the
targeting types host-side; this supplies the runtime the types anticipated). Relates
to ADR-0010 (`lang-*` canonical parse substrate — language canonicalization the
substrate reads via the scope is a kernel/LanguageRegistry concern, not imported as
tool vocabulary). The implementing spec is
`docs/plans/specs/generic-targeting-runtime.md` (local-only).
