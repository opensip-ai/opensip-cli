---
status: active
last_verified: 2026-07-02
owner: opensip-cli
---

# ADR-0122: Agent workflow is the post-hardening product wedge

```yaml
id: ADR-0122
title: Agent workflow is the post-hardening product wedge
date: 2026-07-02
status: active
supersedes: []
superseded_by: null
related:
  - ADR-0084
  - ADR-0085
  - ADR-0086
  - ADR-0094
  - ADR-0095
  - ADR-0109
  - ADR-0110
  - ADR-0116
  - ADR-0117
tags: [product, agents, roadmap, positioning, guardrails]
enforcement: not-mechanizable
enforcement-reason: >
  This is a roadmap and positioning decision. The implementation is enforced by
  the specs and ADRs it pulls forward: impact trust, correlation, apply/verify,
  MCP/review surfaces, repair previews, evidence authority, and capability
  controls.

**Decision:** After the current hardening floor, OpenSIP's product wedge is
**agent workflow**: deterministic evidence and guardrails that let coding agents
review, edit, verify, and hand off changes without unbounded blast radius.

The one-sentence positioning is:

> OpenSIP CLI is the evidence-and-guardrail layer for AI-assisted engineering;
> OpenSIP Cloud is the autonomous maintenance loop that consumes that evidence.

This completes the wedge half left open by ADR-0095 and spec 04. The owner is
`opensip-cli`; the decision is due before the next post-hardening build choice,
and is recorded here on 2026-07-02 so the remaining Track B specs can be ordered
without another abstract "correlation vs. adapters vs. agent loop" debate.

## First Workflows

The next milestone should make these workflows obvious and reliable:

1. **Agent review before editing.** An agent reads the audit review brief, stored
   sessions, graph context, and baseline diff before proposing work. MCP is the
   preferred path for existing evidence; reruns are reserved for fresh execution.
2. **Bounded edit loop.** An agent uses changed-file scope, impact analysis,
   `agent-fast` / `agent-risk` recipes, graph blast radius, and deterministic
   repair previews to keep edits small and explainable.
3. **Final verification and handoff.** An agent runs CI-equivalent gates,
   records sessions, exports SARIF/review evidence, and optionally hands signals
   to OpenSIP Cloud for ticketing or autonomous maintenance.

## Roadmap Order

Pull forward the agent-loop spine:

1. **Spec 06 - Impact analysis trust foundation.** Needed first because an
   agent workflow is only safe when changed-file and blast-radius claims are
   trustworthy.
2. **Spec 05 phase 1 - Correlation join.** Build on the review brief and impact
   trust so risks, findings, graph entities, and sessions can be joined across
   tools.
3. **Spec 07 phase 2 - Full apply-verify loop.** Add write-capable workflows
   only after the read-side evidence and correlation substrate are stable.
4. **Spec 09 - Enterprise trust policy plane.** Narrow this around the authority
   and capability decisions needed by agent workflows and Cloud handoff.
5. **Spec 20 - Evidence authority and egress.** Implement full fidelity
   CLI-to-Cloud evidence once the trust policy shape exists; near-term slices may
   still land if they preserve local evidence and do not create a second truth.
6. **Spec 10 - Capability-resource isolation.** Follow the policy plane and
   apply/verify shape, rather than designing isolation in the abstract.

Defer or fold the other branches:

- **Spec 08 - Sandboxed extension marketplace R&D** stays deferred. A public
  third-party marketplace is not the wedge.
- **Spec 13b - Air-gap / offline / rollback** stays GTM-gated until a regulated
  or air-gapped design partner exists.
- **Spec 19 - Human triage and report surface** should fold into review brief,
  report, SARIF, or Cloud UX work unless a separate human-only triage workflow
  becomes the actual milestone.

## Proof Metrics

The wedge is working when:

- agents can answer "what changed and what is risky?" from MCP/review evidence
  without direct datastore or log inspection;
- changed-file and impacted-file runs avoid missed high-risk paths in the
  detection-quality corpus;
- repair previews are deterministic, stale-hash safe, and explain why an action
  is not applicable;
- final gates produce stable sessions, SARIF, and review evidence for the same
  underlying run;
- Cloud handoff preserves fingerprints, metadata, repair hints, and authority
  labels rather than flattening them into a lossy SARIF-only view.

## Alternatives

- **Ratcheted security scanning.** Rejected as the wedge. Security adapters and
  SARIF ergonomics matter, but OpenSIP is not a replacement for Snyk, Semgrep
  App, or other specialist security platforms. Security evidence remains one
  input to the agent workflow.
- **Architectural intelligence.** Rejected as the named wedge but retained as a
  core capability. Graph, blast radius, and correlation are valuable because
  they make agent edits safer and more explainable.
- **Trusted first-party extension platform.** Rejected as the next wedge. The
  extension trust and verifiable distribution substrate is useful, but the first
  remembered workflow should not be "install packs."
- **Public third-party marketplace.** Rejected for the next milestone. The
  capability and sandboxing costs are high, and ADR-0087 already shelves public
  ecosystem readiness until the capability model proves portable.

## Non-Goals For The Next Milestone

- Do not build model calls or autonomous mutation into opensip-cli core paths.
- Do not pull public marketplace R&D ahead of the agent-loop spine.
- Do not build Cloud-only fleet upgrade or triage orchestration in this repo.
- Do not make security-scanner replacement claims; keep external scanners as
  signal sources that OpenSIP can ingest, gate, correlate, and hand off.
- Do not add write-capable MCP/apply behavior until impact trust, correlation,
  stale-state checks, and review evidence are strong enough to bound risk.

## Consequences

- Spec 06 is the next implementation candidate once this decision lands.
- Spec 05 phase 1 and spec 07 phase 2 become the main follow-on sequence.
- Specs 09, 20, and 10 remain important enterprise work, but their first slices
  should be justified by agent workflow and Cloud handoff needs.
- Public docs should continue to explain the CLI/Cloud split from ADR-0095:
  opensip-cli produces deterministic evidence and calls no models; the platform
  consumes that evidence for autonomous maintenance.
