---
status: active
last_verified: 2026-07-13
owner: opensip-cli
---

# ADR-0159: Reserve Host Command And Built-In Suite Names

```yaml
id: ADR-0159
title: Reserve host command and built-in suite names
date: 2026-07-13
status: active
supersedes: []
superseded_by: null
related: [ADR-0023, ADR-0093, ADR-0111, ADR-0155]
tags: [suite, cli, config, audit, plugins]
enforcement: mechanizable
enforced-by: ['script:suites-reserved-names.test.ts', 'script:reserved-names.test.ts']
enforcement-reason: >
  The config-side reservation is a Zod check on the suites record keys
  (reserved names cannot exist in a valid config document); the CLI-side
  reservation is the admission gate in reject-host-command-collisions.ts. The
  two named tests pin both, and the cli reserved-names test also asserts the
  reserved root-command list stays in parity with the mounted host surface.
```

**Decision:** Reserve well-known names on both configurable planes. (a) A
configured suite may not use a built-in suite name (today: `audit`) — the
strict config document rejects it at validation, so `opensip audit` and
`opensip suite run audit` can never diverge. (b) A Tool may not claim any
host-owned root command name or alias (the full host surface — `init`,
`report`, `sessions`, `suite`, …), not just `audit`; colliding Tools are
rejected at admission, before Commander mounting.

**Alternatives:**

- **Keep the configured override and warn loudly on both spellings.**
  Rejected: divergence between the two spellings of `audit` remains
  representable, and a warning is ignorable. The customer most likely to hit
  the divergence is the power user who configured `suites.audit`
  deliberately — exactly who a warning fails.
- **Rename the top-level command or the built-in suite.** Rejected: `audit`
  has the strongest ecosystem precedent (`npm audit`, `cargo audit`,
  `brew audit`) and is the canonical first-touch verb in the installer and
  quick-start. Renaming burns the name without removing the collision class.
- **One-off `audit` check in `validate-suite.ts`.** Rejected: repeats the
  pattern that left every host command except `audit` unguarded on the Tool
  plane; the next built-in suite or host command reintroduces the gap.
  Suite-plane validation also runs later than document validation, so an
  invalid name would survive into `opensip config validate`-clean documents.
- **Static reserved-command list in `@opensip-cli/contracts`.** Rejected: a
  hand-synced duplicate of the mounted host surface drifts. Command
  reservation stays CLI-local next to the host specs with a parity test.
  (Suite-name reservation is static — a one-element list owned by
  `@opensip-cli/config`, which owns the suites schema; the CLI imports the
  constant so the built-in suite name and the reserved list cannot drift.)

**Rationale:** One name resolving through two lookup rules is safe only if
divergence is impossible or loud. ADR-0155 pinned top-level `audit` to the
built-in definition while `suite run audit` kept ADR-0111's configured-first
resolution — deliberate, but silent: nothing warned when a configured
`suites.audit` shadowed the generic form and was ignored by the canonical
one. Making the reserved name unrepresentable in a valid config document
(the ADR-0023 strict-document posture) removes the divergence instead of
documenting it. On the Tool plane, `reject-host-command-collisions.ts`
guarded only `audit`; a third-party Tool declaring `init` or `report` as its
root command had no guard at all and would double-mount in Commander. The
same admission gate now enforces the full host surface.

**Consequences:**

- A config with `suites.audit` fails document validation with a
  `CONFIG.SUITE.RESERVED_NAME` error naming the reserved word and suggesting
  a rename (`suite run <new-name>` keeps working). This breaks configs that
  relied on ADR-0111's override under that name — accepted pre-1.0, because
  the behavior it enabled is the confusion this ADR removes.
- `opensip audit` ≡ `opensip suite run audit`, always and by construction.
- Bundling a new built-in suite requires adding its name to the reserved
  list in the same change (the parity/drift tests fail otherwise).
- Adding a new host root command automatically extends the Tool-plane
  reservation; third-party Tools claiming it are rejected at admission with
  the existing `cli.tool.host_command_collision` log event.
- The reserved names are machine-discoverable (agent-catalog / tool-author
  docs) so external Tool authors learn the constraint before trial and
  error; the discovery surface is specified in the implementation spec.

**Related specs / ADRs:** Partially amends
[ADR-0111](ADR-0111-built-in-audit-suite-preset.md) (the configured-override
behavior no longer applies to reserved names) and
[ADR-0155](ADR-0155-canonical-audit-command.md) (its Tool-plane rejection
broadens from `audit`-only to the full host surface; its consequence "a
configured `suites.audit` affects `suite run audit`" becomes unrepresentable).
Document strictness posture:
[ADR-0023](ADR-0023-config-package-and-schema-registry.md). Suite
plane: [ADR-0093](ADR-0093-host-owned-suite-plane.md). Implementation
specification: `docs/plans/specs/reserved-names.md` (local, gitignored).
