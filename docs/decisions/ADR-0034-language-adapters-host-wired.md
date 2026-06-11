---
status: active
last_verified: 2026-06-11
owner: opensip-tools
---

# ADR-0034: Language adapters are host-wired, not plugin-discovered

```yaml
id: ADR-0034
title: Language adapters are host-wired, not plugin-discovered
date: 2026-06-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0010, ADR-0027, ADR-0029, ADR-0030]
tags: [languages, plugins, parity, bootstrap]
enforcement: not-mechanizable
enforcement-reason: >
  Documents a sanctioned exception to the unified plugin path rather than a
  rule that code could violate. The exception's boundary IS mechanized from the
  other side: `no-bootstrap-tool-import` confines static first-party imports in
  the host to register-language-adapters.ts, and the §8 invariant-1 acceptance
  tests (fit/sim/graph-external-load) prove TOOLS take no such shortcut.
```

**Decision:** The six bundled `@opensip-tools/lang-*` language adapters are
statically imported and registered by the host composition root
(`packages/cli/src/bootstrap/register-language-adapters.ts`) into the kernel
`LanguageRegistry`. They deliberately do NOT travel the tool-plugin path
(manifest → `admitTool` → dynamic import → shape validation → registry), and no
external/third-party language-adapter discovery path exists. This is a
documented exception to the §8 invariant-1 parity rule ("any shortcut available
to bundled code but impossible for external code is a parity defect unless an
ADR documents it") — this is that ADR.

**Alternatives:**

- *Route language adapters through ADR-0029 generic capability discovery (like
  graph adapters and check packs).* Rejected for now: language adapters are the
  parse SUBSTRATE (ADR-0010), not a tool capability. Every tool's correctness —
  fitness checks, graph resolution, baseline fingerprints — depends on the
  adapter set being a closed, version-locked input. An ambient
  `node_modules`-discovered parser changing what the engine sees would silently
  invalidate caches (ADR-0015) and baseline identities (ADR-0003) without any
  engine-version change to key the invalidation.
- *Declare the adapters as a capability domain owned by a "languages"
  pseudo-tool but pin discovery to the bundled scope.* Rejected: adds a
  manifest/admission ceremony with no admission decision to make (the set is
  closed by design), and invents a tool id with no command surface.

**Rationale:** The tool-plugin path exists so that *behavioral plugins* —
things that add commands, checks, rules, scenarios — are admitted by policy and
loaded uniformly regardless of install source (ADR-0027). Language adapters are
different in kind: they define what "parsing this repository" means
(ADR-0010's single canonical parse substrate). Letting third-party code replace
or extend the substrate would make every downstream artifact
(catalogs, fingerprints, session replays) a function of ambient `node_modules`
content, defeating the determinism guarantees (ADR-0031) the substrate exists
to provide. The static import in `register-language-adapters.ts` is therefore a
*substrate constant*, not a privileged load path for a tool: it contributes no
commands, no config namespace, no `CommandOutcome`/`SignalEnvelope` surface,
and is invisible to admission policy.

**Consequences:**

- `register-language-adapters.ts` remains the ONLY production file in
  `packages/cli/src` permitted to statically value-import a first-party
  `@opensip-tools/lang-*` package. Tool runtimes (fitness/simulation/graph)
  stay behind the dynamic plugin path guarded by `no-bootstrap-tool-import`.
- Adding a language means adding a bundled `lang-*` package and registering it
  here — there is intentionally no "drop a parser in node_modules" path. A
  future decision to open the substrate to external adapters must supersede
  this ADR and define cache/baseline invalidation keyed on the adapter set.
- The §8 invariant-1 wording ("a first-party TOOL loads through the plugin
  path") is unchanged; this ADR records that language adapters are not tools
  and sit outside that invariant's scope.

**Related specs / ADRs:** ADR-0010 (lang-* canonical parse substrate),
ADR-0027 (GA parity cutover), ADR-0029 (generic capability discovery — covers
graph adapters and check packs, NOT language adapters), ADR-0030 (authored tool
discovery), `docs/internal/parity-invariant-index.md` (invariant 1).