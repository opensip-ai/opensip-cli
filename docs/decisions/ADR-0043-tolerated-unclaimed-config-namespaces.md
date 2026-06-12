---
status: active
last_verified: 2026-06-12
owner: opensip-tools
---

# ADR-0043: Tolerate unclaimed config namespaces with a loud, suggesting warning

```yaml
id: ADR-0043
title: Tolerate unclaimed config namespaces with a loud, suggesting warning
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0041]
tags: [config, plugins, tools]
enforcement: mechanizable
enforcement-reason: >
  Composer unit tests pin all four behaviors: (1) an unclaimed top-level
  namespace warns (does not abort) and the warning carries a did-you-mean
  suggestion when edit-distance-close to a claimed namespace; (2) a namespace
  claimed by a LOADED tool with no Tool.config contribution still hard-rejects;
  (3) a claimed namespace failing its strict block validation still
  hard-rejects; (4) host-block keys remain strict.
```

**Decision:** Amend the strict-document-validation consequence of ADR-0023:
a top-level config namespace that no *loaded* tool claims is tolerated with a
loud per-run warning — naming the namespace, stating that no installed tool
claims it, and suggesting the nearest claimed namespace when one is
edit-distance-close — instead of hard-failing the run. Everything else stays
strict: a namespace claimed by a loaded tool still validates strictly against
that tool's declared schema, a loaded tool whose namespace exists but who
declares no `Tool.config` is rejected, and host-owned blocks remain strict.
This ADR does not supersede ADR-0023 (whose consolidation, precedence, and
one-reader decisions stand); it relaxes exactly one clause, for exactly one
reason: with third-party tools, a config block for a
temporarily-uninstalled tool must not brick every command in the project.

**Alternatives:**

- *Keep full strictness.* Rejected: shared config files travel between
  machines and teammates with different install sets; one uninstalled tool's
  block would make the whole CLI unusable in that checkout.
- *Silent tolerance of unclaimed namespaces.* Rejected: reopens the typo hole
  strictness exists to close — `fitnes:` would validate cleanly as a
  "presumably uninstalled tool". The loud did-you-mean warning is the floor
  that keeps typos observable.
- *Require unclaimed namespaces to be declared (`externalTools: [audit]`) for
  warning-free tolerance.* Deferred, not rejected: ships as the Phase 3
  candidate mechanism (decided when admission-time enforcement lands,
  ADR-0042/Phase 3). The floor ships first; the declaration mechanism layers
  on top without breaking it.
- *Tolerate only namespaces matching a tool id seen in any discovery source.*
  Rejected: couples shared config portability to local install state.

**Rationale:** ADR-0023 chose strict whole-document validation to fail fast on
typos when the only tools were bundled (always registered, so "unknown
namespace" could only mean a mistake). Third-party tools break that
equivalence: unknown now also legitimately means "not installed here". The
warning-with-suggestion floor preserves the typo signal (loud, named,
corrective) while removing the bricking failure mode.

**Consequences:**

- The composer's unknown-namespace path changes from reject to
  warn-and-continue; the warning is a structured log event plus a stderr line
  so non-TTY/CI runs surface it.
- `tools uninstall` need not touch project config; a left-behind block warns
  instead of breaking.
- Phase 3 revisits the declared-`externalTools` mechanism alongside Tier B
  enforcement (ADR-0042).

**Related specs / ADRs:** `docs/plans/specs/tool-management-command.md` (rev 2);
ADR-0023 (config consolidation — amended in this one clause); ADR-0041.
