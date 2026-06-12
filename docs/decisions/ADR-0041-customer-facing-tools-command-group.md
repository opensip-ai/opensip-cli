---
status: active
last_verified: 2026-06-12
owner: opensip-tools
---

# ADR-0041: Make `tools` the customer-facing whole-tool management surface

```yaml
id: ADR-0041
title: Make `tools` the customer-facing whole-tool management surface
date: 2026-06-12
status: active
supersedes: []
superseded_by: null
related: [ADR-0027, ADR-0042, ADR-0043]
tags: [cli, plugins, tools, ux]
enforcement: mechanizable
enforcement-reason: >
  The command-surface-parity snapshot test pins the group's shape (subcommands
  only; no flag aliases; no `tool` singular group). The one-validator invariant
  is pinned by the rejection-parity acceptance test (a fixture rejected by
  `tools validate` is rejected by bootstrap admission, and vice versa) shipped
  with the implementation. `tools list`'s zero-dynamic-import rule is pinned by
  the throwing-module-top-level fixture test.
```

**Decision:** Add a first-class `opensip-tools tools` command group
(`list | install | uninstall | validate | data purge`) as the documented,
customer-facing surface for whole Tool plugins. `plugin` remains the
lower-level fit/sim/tool machinery that `tools` is implemented over —
`tools` reuses the tool-host setup, npm helpers, marker detection,
provenance, and the existing bootstrap admission pipeline
(`loadToolManifest → admitTool → importToolRuntime → isValidTool →
assertManifestMatchesTool`) factored into one callable validator shared by
`tools validate`, `tools install`, bootstrap admission, and the bundled-tool
tests.

**Alternatives:**

- *Keep `plugin add --domain tool` as the documented surface.* Rejected:
  consumers must learn plugin-domain vocabulary to install a whole tool, and
  tool developers have no pre-publish conformance check at all.
- *Replace `plugin` outright.* Rejected for this phase: fit/sim pack
  management genuinely is domain-scoped plugin machinery; collapsing both
  surfaces at once couples a UX change to a migration.
- *A second, independent validator for `tools validate`.* Rejected: divergence
  between what `validate` accepts and what bootstrap admits is precisely the
  failure mode to design out. One implementation, four consumers.
- *Flag-style aliases (`tool --install --url …`) and a `tool` singular alias.*
  Rejected: every alias doubles the surface the parity snapshot and
  spec-derived completion must track, for zero expressiveness. Group named
  `tools` (plural) on the `sessions` precedent.

**Rationale:** The admission pipeline already enforces the Tool contract at
bootstrap; the missing piece is purely a user-invocable framing of it (plus
atomic stage-validate-activate install). Building the UX as a veneer over the
existing machinery keeps the 3.0.0 parity property intact — install source
stays a provenance/trust posture, never a lifecycle difference. Trust posture:
`tools validate` and `tools install` execute untrusted code (npm install
scripts fire before any verdict; module top-level runs on load); both sit
behind the same consent gate as today's installs, the subprocess used for
validation is a crash boundary, not a security boundary, and the docs say so
plainly. `tools list` never dynamic-imports a tool runtime (manifest +
provenance data only).

**Consequences:**

- `plugin add --domain tool` is hidden from `--help` (still functional) one
  minor release after `tools` stabilizes; removal, if ever, is a major-version
  decision.
- One purge vocabulary: `tools data purge <tool-id>` is the per-tool umbrella
  (sessions + baselines + tool state, via repository APIs); `sessions purge`
  stays whole-history.
- The spec's phased sequencing applies: veneer first, persistence plane second,
  admission-time storage enforcement last (ADR-0042).

**Related specs / ADRs:** `docs/plans/specs/tool-management-command.md` (rev 2);
ADR-0027 (3.0.0 parity GA cutover); ADR-0042 (storage contract);
ADR-0043 (config-namespace tolerance).
