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

**Decision:** Make the composer's existing tolerance of unclaimed top-level
config namespaces *observable and bounded*. Today `composeConfigSchema`
deliberately tolerates unclaimed top-level keys (`.catchall(z.unknown())`,
`packages/config/src/composer.ts:81-85` — an ADR-0023 design choice;
strictness is *within* a claimed namespace) and it tolerates them **silently**
— `fitnes:` validates cleanly right now. This ADR adds two things: (1) an
unclaimed top-level namespace produces a loud per-run warning — naming the
namespace, stating that no loaded tool claims it, and suggesting the nearest
claimed namespace when one is edit-distance-close; (2) a namespace matching a
*loaded* tool that declares no `Tool.config` contribution becomes a hard
rejection (today it falls into the silent catchall). Claimed namespaces stay
strict; host-owned blocks stay strict. ADR-0023's consolidation, precedence,
and one-reader decisions stand untouched.

**Alternatives:**

- *Make unclaimed namespaces a hard error.* Rejected: shared config files
  travel between machines and teammates with different third-party install
  sets; one uninstalled tool's block would make the whole CLI unusable in that
  checkout.
- *Keep the status-quo silent tolerance.* Rejected: the typo hole is live
  today — `fitnes:` (and any misspelled namespace) validates silently as if it
  were an uninstalled tool's block. The loud did-you-mean warning is the floor
  that makes typos observable without breaking portability.
- *Require unclaimed namespaces to be declared (`externalTools: [audit]`) for
  warning-free tolerance.* Deferred, not rejected: ships as the Phase 3
  candidate mechanism (decided when admission-time enforcement lands,
  ADR-0042/Phase 3). The floor ships first; the declaration mechanism layers
  on top without breaking it.
- *Tolerate only namespaces matching a tool id seen in any discovery source.*
  Rejected: couples shared config portability to local install state.

**Rationale:** ADR-0023's within-namespace strictness catches typos *inside* a
claimed block (`fitness.faliOnErrors` rejects), but a typo'd *namespace* falls
through the document-level catchall and is silently ignored — the user's
config simply doesn't apply, with no signal. While the only tools were bundled
(always registered), every unclaimed namespace was a mistake and the silence
was at least diagnosable; with third-party tools, unclaimed namespaces become
legitimate ("not installed here") and the silent path would hide both cases
equally. The warning-with-suggestion floor separates them: legitimate blocks
warn once and continue; typos warn with a correction.

**Consequences:**

- The composer's unclaimed-namespace path changes from silent to
  warn-and-continue; the warning is a structured log event plus a stderr line
  so non-TTY/CI runs surface it.
- The loaded-tool-with-undeclared-namespace case changes from silently
  tolerated to rejected.
- `tools uninstall` need not touch project config; a left-behind block warns
  instead of breaking.
- Phase 3 revisits the declared-`externalTools` mechanism alongside Tier B
  enforcement (ADR-0042).

**Related specs / ADRs:** `docs/plans/specs/tool-management-command.md` (rev 2);
ADR-0023 (config consolidation — amended in this one clause); ADR-0041.
