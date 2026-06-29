---
status: active
last_verified: 2026-06-29
owner: opensip-cli
---

# ADR-0095: AI-native guardrail platform posture

```yaml
id: ADR-0095
title: AI-native guardrail platform posture
date: 2026-06-29
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0020, ADR-0084, ADR-0085, ADR-0086, ADR-0093, ADR-0094]
tags: [product, agents, positioning, governance, guardrails]
enforcement: not-mechanizable
enforcement-reason: >
  The boundary is a product and documentation posture, not one code invariant.
  Individual pieces remain mechanized elsewhere: JSON output, sessions, MCP,
  graph/fitness gates, and suite/session provenance each have their own tests
  and ADRs. This ADR records the cross-cutting intent those mechanisms serve.
```

**Decision:** Position opensip-cli as an **AI-native guardrail platform**, not an
AI runtime. The CLI MUST NOT require model calls, embeddings, or autonomous code
mutation to deliver its core value. It SHOULD be easy for external coding agents
to consume: deterministic JSON, sessions, `agent-catalog`, MCP, graph context,
recipes, gates, suites, and future apply/verify workflows are first-class
agent-facing surfaces.

The product thesis is that humans can trust agent-written code only when the
environment provides four things:

1. **Intent** — ADRs, docs, recipes, and config explain what "good" means.
2. **Executable rules** — fitness checks, graph rules, YAGNI detectors, sim
   scenarios, and gates turn that intent into pass/fail evidence.
3. **Durable evidence** — sessions, signals, SARIF/native egress, dashboards,
   and MCP preserve what happened so humans and agents do not need to guess.
4. **Capability controls** — scoped tools, trust tiers, suite orchestration, and
   future Governor/apply-verify work constrain what automation may change and
   what proof it must produce.

Public docs may tell the concise origin story: the platform came from practical
AI-assisted development where a narrow task could create broad, unsafe repo
changes unless scope, architecture, and proof were enforced by the system. The
story is illustrative, not a runtime requirement.

**Alternatives:**

- **Generic static-analysis CLI.** Rejected as incomplete. It describes the
  mechanics but loses the reason the system exists: making AI-assisted coding
  trustworthy through enforceable guardrails.
- **AI product / autonomous coding agent.** Rejected. OpenSIP should not compete
  with model runtimes or claim judgment it does not own. It supplies evidence and
  constraints that agents consume.
- **Security scanner positioning.** Rejected. External scanner adapters are useful
  orchestration, but CVE-scale security scanning remains the domain of specialist
  scanners. OpenSIP sits above them as a gate/correlation layer.
- **Hide the AI origin story.** Rejected. Without the origin, `agent-catalog`, MCP,
  repair metadata, and agent recipes look like add-ons. With the origin, they are
  clearly part of the trust loop.

**Consequences:**

- Replace broad "not an AI tool" wording with the narrower "not an AI runtime"
  boundary. The CLI has no model dependency, but it is explicitly built for
  AI-assisted development.
- Agent-facing docs must explain the intended workflow: read existing evidence
  first, run bounded edit-loop checks, inspect graph impact, then run final gates.
- Contributor/agent guidance should treat guardrails as product behavior. Do not
  weaken checks to make a task pass; change intent and enforcement together.
- Future automation work (repair apply/verify, Governor, Cloud evidence authority)
  must preserve the trust model: scoped capability, durable evidence, explicit
  proof, and human approval where risk warrants it.

**Fitness check:** No new check. The posture is enforced by documentation and by
the existing contracts around machine output, MCP replay-only behavior, gates,
sessions, and tool trust tiers.
