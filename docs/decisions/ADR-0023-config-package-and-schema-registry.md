---
status: active
last_verified: 2026-06-07
owner: opensip-cli
---

# ADR-0023: A dedicated `@opensip-cli/config` package and one composed config document

```yaml
id: ADR-0023
title: A dedicated @opensip-cli/config package and one composed config document
date: 2026-06-07
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0012, ADR-0021, ADR-0022]   # output currency; versioning; flag currency; tool-scoped recipes
tags: [config, packaging, plugin-parity, contracts]
enforcement: mechanizable
enforcement-reason: >
  The `one-config-document` fitness check (planned, 2.10.0) fails CI if a config
  block is parsed outside the composed schema; a `no-config-loader-outside-config`
  dep-cruiser/fitness rule keeps YAML projection out of contracts/tools. Modeled
  on the live `cross-tool-flag-parity` check (ADR-0021).
```

**Decision:** Introduce a dedicated **`@opensip-cli/config`** package that owns
the cross-cutting configuration *machinery* — the namespaced-schema **composer**,
whole-document **validation + precedence + JSON-Schema generation** — and the
tool-agnostic *document blocks* (shared targeting, `cli`/`cloud` defaults,
user-global config I/O, config-path resolution, the scaffold template). Each tool
**contributes a namespaced Zod schema** (`ToolConfigDeclaration`) that the host
composes into **one whole-document schema**, validated once before dispatch.
Validation is **strict** (unknown keys within a known namespace are rejected) —
we are pre-GA (ADR-0012), so no backward-compatibility shim is owed. The
**§5.7 composer core** lands in **2.10.0**; the **migration of the scattered config
surface into the new package** lands in a fast-follow **2.10.1** so 2.10.0 does not
half-move config.

**Alternatives:**
- *Keep config in `contracts` + per-tool loaders (status quo).* Rejected: one file
  (`opensip-cli.config.yml`) is parsed by ≥3 independent hand-projections
  (`contracts/cli-config.ts` `projectCliDefaults`, `graph/.../graph-config.ts`
  `projectGraphConfig`, fitness loaders) with different strictness — the
  divergence north-star §4.4 names. And `cli-config.ts`'s runtime YAML projection
  is a standing violation of the "contracts is types-only" charter.
- *Put the composer in `contracts`.* Rejected: composing Zod schemas is runtime
  logic with a Zod dependency; `contracts` is a types surface and the kernel
  forbids Zod (`cli-config.ts:15`, "core is the kernel: no YAML, no project-level
  config schemas"). A dedicated package keeps Zod in exactly one place.
- *Do the full consolidation in 2.10.0.* Rejected: moving shared targeting out of
  fitness and `cli-config` out of contracts touches many importers; bundling it
  with the composer + capability + scope-registry work makes 2.10.0 too large.
  Splitting at the package boundary (create + compose in 2.10.0; migrate in 2.10.1)
  keeps each release shippable.

**Rationale:** Configuration is the surface where user-facing behaviour silently
diverges today (north-star §4.4). One composed schema gives one strictness, one
precedence order, and a single JSON-Schema for editors — the parity invariant
"one config document." A dedicated package is the only home that honours layering
(`core → config → {tools, cli}`, beside `contracts`) while carrying the Zod
dependency the kernel refuses. The package boundary also *defines done*: once
config logic lives only in `@opensip-cli/config`, the guardrail can mechanically
forbid YAML projection anywhere else.

**Consequences:**
- A **32nd publishable package** (`@opensip-cli/config`) — update `RELEASING.md`,
  `scripts/release-package-order.mjs` (and every surface ADR-0017 derives from it),
  and bootstrap its npm trusted publisher (brand-new name).
- **2.10.0** (spec: `docs/plans/specs/release-2.10.0-capability-configuration.md`):
  create the package; the composer + `ToolConfigDeclaration`; tools contribute
  namespaced schemas; strict validation; capability model (§5.3) + scope-owned
  registries (§5.11).
- **2.10.1** (follow-up plan): migrate into the package — `cli-config` out of
  `contracts` (fixes the types-only violation); shared targeting
  (`targets`/`globalExcludes`/`checkOverrides`) out of `fitness`; cloud-egress
  config; user-global config I/O (`global-config.ts`); `config-resolution.ts`; the
  scaffold template (derived from the composed schema). The generic `lib/yaml.ts`
  read primitive stays in `core`; the `configure` command UX stays in `cli`;
  per-check config (`getCheckConfig`) stays in `fitness`.
- Strict validation is a **behaviour change** for any config with stray keys —
  acceptable pre-GA; called out in the 2.10.0 / 2.10.1 CHANGELOG.

**Related specs / ADRs:** Implemented by
`docs/plans/specs/release-2.10.0-capability-configuration.md` (composer core) and
the 2.10.1 consolidation plan. Part of the tool-plugin-parity roadmap
(`docs/plans/tool-plugin-parity-roadmap.md`). Relates to ADR-0021 (the
flag-currency guardrail template), ADR-0012 (pre-GA versioning that licenses the
strict-validation break), ADR-0011 (output currency — the inner/outer split this
mirrors for config).

---

## Amendment — 2026-06-07 (2.10.1 planning): config-resolution stays in core

The decision and consequences above are unchanged. This amendment records three
boundary refinements surfaced while planning the 2.10.1 migration
(`docs/plans/ready/release-2.10.1-config-consolidation/`). They are clarifications
of *where the layer falls*, not a reversal — the package still owns the
cross-cutting config machinery and the document blocks.

The governing distinction the migration revealed: a config document has **two
separable concerns** — *locating + version-gating* it (preconditions that run
before validation; kernel-level, no Zod) versus *validating + shaping* its
content (the `@opensip-cli/config` layer). The boundary is therefore **locate +
version-gate = `core`; validate + shape = `config`.**

1. **`config-resolution.ts` STAYS in `core` — diverges from the Consequences
   "2.10.1" bullet.** That bullet lists `config-resolution.ts` among the surfaces
   migrating into the package. Planning found `resolveProjectConfigPath` /
   `PROJECT_CONFIG_FILENAME` are consumed *inside* the kernel
   (`core/src/plugins/discover.ts`, `core/src/lib/project-context.ts`), so moving
   them to `config` would invert the `core → config` layer the ADR itself
   mandates. They are filesystem **path primitives** (locate the file by ancestor
   walk; no document knowledge) — the same category as `lib/yaml.ts`, which the
   ADR already keeps in core. **Resolution:** they stay in `core`, and every
   consumer — including the config package — imports them **from `core`**. **No
   re-export from `config`:** everything already depends on `core`, so a
   re-export would be pure aliasing (a second public name for one symbol) with no
   dependency-graph benefit. _Supersedes the `config-resolution.ts` entry in the
   2.10.1 Consequences bullet only; every other surface in that bullet still
   migrates._

2. **`dashboard` is a host document-level declaration (clarification).** The
   `dashboard:` block (`editor` protocol) rides in fitness's whole-document schema
   today but is owned by neither fitness nor any Tool plugin — `dashboard` is a
   CLI-owned composition-root command. It is therefore a **host declaration** in
   `config`, structurally identical to `cli`, registered beside it. This completes
   "the tool-agnostic document blocks" the Decision names (it was simply not
   enumerated); it is not a new scope.

3. **`schemaVersion` — core keeps version-compat; the composed schema claims it
   (clarification).** `schemaVersion` is read by `core`'s
   `readConfigSchemaVersion` + `checkSchemaCompat` in the pre-action gate, *before*
   strict validation — a versioning precondition (ADR-0012 territory), not content
   validation. **Resolution:** compat logic stays in `core`; the composed
   document schema **claims** `schemaVersion` as a permissive top-level `number`
   (rather than leaning on the document-level `.catchall`), keeping the invariant
   "every top-level key is claimed" honest without pulling the pre-flight gate
   into the config layer.

**Enforcement note:** the `no-config-loader-outside-config` guardrail (2.10.1)
must exempt the `core` path primitive (`resolveProjectConfigPath`) and the generic
`lib/yaml.ts` reader — they are the allowed *locate/read* primitives, not config
projection. The guardrail forbids projecting a *document block* into a config
object outside `@opensip-cli/config`, which is the boundary this amendment
sharpens.
