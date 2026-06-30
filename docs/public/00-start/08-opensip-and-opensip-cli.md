---
status: current
last_verified: 2026-06-29
release: v0.1.17
title: "OpenSIP and OpenSIP CLI"
audience: [getting-started, contributors, ci-integrators]
purpose: "The product family — what OpenSIP (the autonomous platform) and opensip-cli (the open-source guardrail layer) each are, how they fit together, and the shared origin that explains why both exist."
related-docs:
  - ./01-what-is-opensip-cli.md
  - ./06-system-context.md
  - ../../decisions/ADR-0095-ai-native-guardrail-platform-posture.md
---
# OpenSIP and OpenSIP CLI

There are two products under the OpenSIP name, and they are easy to confuse.
This page draws the line between them and explains why they share a name, a
thesis, and an origin.

- **opensip-cli** — the **open-source guardrail layer**. A local-first CLI that
  turns architectural intent into deterministic, machine-readable evidence:
  fitness checks, static call-graph analysis, simulation, gates, sessions,
  SARIF, dashboards, and an MCP surface. It runs in your repo and in CI, works
  offline, and **calls no models**. This is the repository these docs describe.
- **OpenSIP** (the platform, "OpenSIP Cloud") — the **autonomous software
  maintenance platform** built *on top of* that evidence. It ingests signals
  (from the CLI, from production telemetry, from CI), turns them into tickets,
  proposes and validates fixes, and merges them when it is safe to do so —
  escalating to a human when it is not. Early access.

One sentence: **opensip-cli is the evidence-and-enforcement layer; OpenSIP is the
autonomous loop that consumes it.** You can adopt the CLI alone forever. The
platform is the optional layer above it.

## The shared origin

Both products come from a single lesson. An AI coding agent, helping with a small
end-of-day fix, ran a local script across an entire production codebase. Nothing
had been committed. In seconds, hundreds of files were rewritten — interfaces
deleted, types mutated, conventions distorted — all from a well-meaning attempt to
"fix" what it had just broken.

The takeaway was not "use AI less" or "write better prompts." It was that **AI is
a high-throughput implementation engine with weak judgment**, and that humans can
only trust agent-written code when the *environment itself* enforces correctness
rather than politely asking for it. That requires four things:

1. **Intent** — decisions and rules are written down (ADRs, docs, recipes, config).
2. **Executable rules** — that intent becomes pass/fail checks (`fit`, `graph`,
   `sim`, `yagni`, gates).
3. **Durable evidence** — what happened is preserved, not guessed (sessions, JSON,
   SARIF, dashboards, MCP).
4. **Capability controls** — automation is scoped, and must produce proof before
   it is trusted (trust tiers, suites, and the platform's Governor / apply-verify
   work).

opensip-cli productizes pillars 1–3 and the deterministic half of 4. OpenSIP
productizes the autonomous half of 4 — the loop that proposes, validates, and
merges fixes under capability constraints.

> The longer form of this origin story lives in the book *The AI-Native
> Architect*, which documents the architecture and workflow these products grew
> out of.

## How they fit together

```text
            ┌─────────────────────────────────────────────┐
            │  OpenSIP (platform / Cloud) — early access   │
            │  signals → tickets → AI fix → validate →     │
            │  merge-when-safe / escalate-when-not         │
            └───────────────▲─────────────────────────────┘
                            │  consumes evidence (signals, SARIF,
                            │  sessions, graph context)
            ┌───────────────┴─────────────────────────────┐
            │  opensip-cli (open source) — local + CI      │
            │  fit · graph · sim · yagni · gates · MCP     │
            │  deterministic evidence, no model calls      │
            └─────────────────────────────────────────────┘
```

The CLI never reaches up into the platform; evidence flows up. The platform is one
consumer of the CLI's output — coding agents (via JSON / `agent-catalog` / MCP)
and humans (via the dashboard / SARIF in GitHub) are others.

## The dividing line

| | opensip-cli | OpenSIP (platform) |
|---|---|---|
| **What it is** | Open-source guardrail CLI | Autonomous maintenance platform |
| **Where it runs** | Your repo + your CI, offline | Hosted service (early access) |
| **Calls models?** | No — deterministic only | Yes — proposes and validates fixes |
| **Changes your code?** | No — reports evidence, exits non-zero | Yes — opens PRs, merges when safe |
| **Primary output** | Checks, graph, sessions, SARIF, MCP | Tickets, validated fixes, merges |
| **Pricing** | Free, open source, forever | Metered (announced at GA) |

opensip-cli is deliberately **not an AI runtime** — it has no model dependency,
creates no embeddings, and applies no autonomous changes. It is *built for*
AI-assisted development without *being* the AI. That posture is recorded in
[ADR-0095](../../decisions/ADR-0095-ai-native-guardrail-platform-posture.md).

## For AI agents working in either repository

If you are an agent operating in **opensip-cli**: you are working on the
open-source guardrail layer. Do not add model calls or autonomous code mutation to
the CLI's core paths — that belongs in the platform, not here. Keep outputs
deterministic and agent-consumable.

If you are an agent operating in the **OpenSIP platform**: opensip-cli is a
*separate shipping product* that the platform consumes, not just a folder of
internal tooling. (Note the platform repo also contains an `opensip-cli/`
*directory* holding its own `@opensip/fit` + `@opensip/sim` packs — that is the
platform dogfooding the CLI on itself, not the CLI product's source.) The platform
builds the autonomous loop *on* the CLI's evidence; it does not reimplement the
CLI's checks.

In both repos the same rule holds: **do not weaken a guardrail to make a change
pass.** Fix the code, or change the intent and its enforcement together with a
documented decision.
