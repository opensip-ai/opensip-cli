---
status: active
last_verified: 2026-06-07
owner: opensip-tools
---

# ADR-0023: A dedicated `@opensip-tools/config` package and one composed config document

```yaml
id: ADR-0023
title: A dedicated @opensip-tools/config package and one composed config document
date: 2026-06-07
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0012, ADR-0021, ADR-0022]   # output currency; versioning; flag currency; cli.recipe deprecation
tags: [config, packaging, plugin-parity, contracts]
enforcement: mechanizable
enforcement-reason: >
  The `one-config-document` fitness check (planned, 2.10.0) fails CI if a config
  block is parsed outside the composed schema; a `no-config-loader-outside-config`
  dep-cruiser/fitness rule keeps YAML projection out of contracts/tools. Modeled
  on the live `cross-tool-flag-parity` check (ADR-0021).
```

**Decision:** Introduce a dedicated **`@opensip-tools/config`** package that owns
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
  (`opensip-tools.config.yml`) is parsed by ≥3 independent hand-projections
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
config logic lives only in `@opensip-tools/config`, the guardrail can mechanically
forbid YAML projection anywhere else.

**Consequences:**
- A **32nd publishable package** (`@opensip-tools/config`) — update `RELEASING.md`,
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
