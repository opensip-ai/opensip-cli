---
status: active
last_verified: 2026-07-15
owner: opensip-cli
---

# ADR-0166: Assemble one transport-equivalent agent catalog for CLI and MCP

```yaml
id: ADR-0166
title: Assemble one transport-equivalent agent catalog for CLI and MCP
date: 2026-07-15
status: active
supersedes: []
superseded_by: null
related: [ADR-0084, ADR-0153, ADR-0154, ADR-0159, ADR-0165]
tags: [mcp, agents, contracts, catalog, parity]
enforcement: mechanizable
enforced-by: ['script:agent-catalog-parity.test.ts', 'script:e2e-stdio.test.ts', 'script:reserved-names.test.ts', 'script:suites-reserved-names.test.ts', 'depcruise:tool-package-mcp-imports-allowlist']
enforcement-reason: >
  The parity invariant is a full-object equality claim, which a source-pattern
  fitness check cannot express: agent-catalog-parity.test.ts asserts the CLI
  adapter and the MCP read port produce a byte-identical common AgentCatalog from
  the same facts, e2e-stdio.test.ts asserts the built stdio `get_agent_catalog`
  common body (minus the additive `mcp` overlay) equals `opensip agent-catalog
  --json`, reserved-names.test.ts / suites-reserved-names.test.ts pin the
  reserved root/suite lists both transports advertise, and the
  `tool-package-mcp-imports-allowlist` dependency-cruiser rule forbids an
  `mcp -> cli` edge while scoping the new `mcp -> config` edge. See "Fitness
  check" below for why no new source check is warranted.
```

**Decision:** The common `AgentCatalog` body — entry points, `commonPatterns`,
`outputShapes`, `notes`, bounded `projectContext.targetConventions`,
`reservedNames`, and the Plan 02 `hostSupport` projection — is
**transport-equivalent** for `opensip agent-catalog --json` and MCP
`get_agent_catalog`, produced by **one pure contracts assembler**
(`assembleAgentCatalog` in `packages/contracts/src/agent-catalog.ts`) that each
composition root calls with facts it captured itself. The CLI stays the static
admission authority for host-reserved root commands and passes its local
`HOST_RESERVED_ROOT_COMMANDS` directly; MCP — which may not import that CLI-local
constant (layer DAG) and may not re-spell it (ADR-0159) — derives **equivalent**
reserved-root and internal-command facts by projecting the **complete, immutable**
`RunScope.runtimeCommands` inventory (plus Commander's implicit `help`) through
`projectAgentCatalogRuntimeFacts`, which fails closed on an incomplete inventory.
`@opensip-cli/config` retains suite-name ownership; both roots import
`RESERVED_SUITE_NAMES` from its barrel. Both roots compute the target-convention
summary **once** and pass that single precomputed array. The MCP-only `mcp`
connector overlay (version, surface epoch, tool names/count, mutation posture,
project root/scope) stays **additive and transport-local** — layered on at the
stdio tool boundary, never folded into the shared body. No `mcp -> cli` import
edge is introduced.

**Alternatives:**

- **Duplicate the CLI's reserved-root constant in MCP (or hoist it into
  contracts).** Rejected: a hand-synced copy of the mounted host surface drifts —
  exactly the failure ADR-0159 rejected when it kept command reservation
  CLI-local next to the host specs with a parity test. Two spellings of the
  reserved-root set could silently diverge; projecting from the one mounted
  inventory keeps a single source of truth.
- **Move the static host-admission authority into `@opensip-cli/contracts`.**
  Rejected: contracts is a type/helper facade, not the admission plane. ADR-0159
  places host-command reservation next to the Commander mount so the admission
  gate and the advertised list cannot drift; inverting that ownership into a
  lower layer would split the authority from the enforcement point and let the
  advertised names diverge from what admission actually rejects.
- **Project MCP facts from the complete runtime inventory and share one pure
  assembler (chosen).** MCP reads the same complete mounted-command data the host
  already captured on `RunScope.runtimeCommands` (ADR-0154) and both transports
  funnel every fact through one assembler, so a newly added common field reaches
  both surfaces or neither, and the reserved-root set is derived from the same
  ground truth without a second constant.

**Rationale:** Before this change each transport built the catalog on its own
path (`buildAgentCatalog` called separately in the CLI command and the MCP read
port), so a common field added to one path could silently miss the other, and the
reserved-root list existed only as the CLI-local `HOST_RESERVED_ROOT_COMMANDS`.
Routing both roots through `assembleAgentCatalog` makes the common body a single
projection of captured facts: the CLI adapter (`executeAgentCatalog`) and MCP
(`serveMcpStdio` → `SessionResultsReadPort`, a pure conduit that forwards the
catalog it was handed) can only differ by the facts they feed in, and the parity
test asserts full-object equality for the same admitted registry + project. MCP
obtaining reserved-root facts from `projectAgentCatalogRuntimeFacts` over the
complete inventory — rather than importing or copying the CLI constant — is the
one boundary-preserving way to give MCP the same names without an `mcp -> cli`
edge or a duplicated list. Reusing the single target-convention summary and
`RESERVED_SUITE_NAMES` from config keeps the remaining inputs single-sourced.
Plan 02 (ADR-0165) already required the common assembler to accept its exact
`hostSupport?: AgentHostSupport` input with no adapter or rename and to assert
full-object CLI/MCP equality including `hostSupport`; this decision realizes that
handoff.

**Consequences:**

- `assembleAgentCatalog` and `projectAgentCatalogRuntimeFacts` are the shared
  seam; `SessionResultsReadPort.agentCatalog()` becomes a pure conduit that
  returns the catalog assembled once at the composition root and reads no scope,
  filesystem, graph, Git, test, session, or datastore state.
- `@opensip-cli/mcp` gains a `@opensip-cli/config` dependency (for
  `RESERVED_SUITE_NAMES` only); the dependency-cruiser `mcp` import allowlist adds
  `@opensip-cli/config` as a scoped, documented layer-4→layer-3 edge. Ownership of
  the suite-name list stays in config; the value is not copied into MCP or
  contracts. The `mcp -> cli` edge remains forbidden.
- Catalog reads on **both** transports are read-only: assembly builds no graph,
  runs no analysis, invokes no Git or tests, and creates no session.
- The `mcp` connector overlay is the only MCP-only field. Agents compare the two
  transports by removing exactly the top-level `mcp` object; a stale surface
  epoch / tool list means **reconnect** the MCP connector, not `refresh_graph`
  (ADR-0153) — the overlay diagnoses connector identity, never catalog freshness.
- An incomplete `RunScope.runtimeCommands` inventory makes MCP's discovery read
  fail closed (`AGENT_CATALOG.INCOMPLETE_INVENTORY`) rather than advertise a
  partial reservation set.

**Fitness check:** No new check is warranted. The invariant is transport-parity
of an assembled object, which the runtime contract is positioned to prove
directly and a source-pattern check is not: `agent-catalog-parity.test.ts`
asserts the CLI and MCP paths produce a byte-identical common body from identical
facts; `e2e-stdio.test.ts` asserts the built stdio server's `get_agent_catalog`
common body (minus the additive `mcp` overlay) equals `opensip agent-catalog
--json`; `reserved-names.test.ts` and `suites-reserved-names.test.ts` pin the
reserved-root/suite parity both transports advertise; and the
`tool-package-mcp-imports-allowlist` dependency-cruiser rule mechanically forbids
the `mcp -> cli` edge while scoping the config edge. Together these exercise the
invariant more precisely than any pattern check over source could.

**Related specs / ADRs:** [ADR-0084](ADR-0084-mcp-server-surface.md) established
the shared catalog surface MCP serves (this makes its body transport-equivalent
to the CLI's); [ADR-0159](ADR-0159-reserved-host-command-and-suite-names.md) owns
name reservation and its rejection of a duplicated static reserved-command list
(this preserves that boundary while giving MCP equivalent facts);
[ADR-0154](ADR-0154-declarative-runtime-handler-bridge.md) owns the complete
`RunScope.runtimeCommands` inventory MCP projects from;
[ADR-0165](ADR-0165-macos-ga-support-qualification.md) defines the Plan 02
`hostSupport` projection this parity preserves as an assembler input; and
[ADR-0153](ADR-0153-faceted-compact-mcp-graph-protocol.md) owns the
reconnect-versus-`refresh_graph` rule the additive `mcp` overlay obeys.
Implementation: `docs/plans/ready/03-agent-catalog-transport-parity/` (local,
gitignored). No existing ADR is superseded.
