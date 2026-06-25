---
status: active
last_verified: 2026-06-24
owner: opensip-cli
---

# ADR-0064: Duplicate detection is a shared substrate — tools own detection independently, never via a peer-tool dependency

```yaml
id: ADR-0064
title: Duplicate detection is a shared substrate — tools own detection independently, never via a peer-tool dependency
date: 2026-06-24
status: active
supersedes: [ADR-0063]
superseded_by: null
related: [ADR-0057, ADR-0062, ADR-0036, ADR-0061]
tags: [yagni, graph, tools, architecture, layering]
enforcement: mechanizable
enforcement-reason: >
  Structural half: a dependency-cruiser rule keeps `@opensip-cli/clone-detection`
  a leaf (no workspace deps beyond what its math needs), and the existing
  `yagni-no-graph*` rules keep yagni off the graph engine/adapters — so neither
  tool can reach the other; both reach only the shared substrate. Behavioural
  half: a cross-tool PARITY test (one fixture corpus through graph's and yagni's
  extractors) asserts identical body hashes AND identical duplicate groups — the
  single-implementation guarantee that prevents the divergence ADR-0063 deleted
  its way around.
```

## Why ADR-0063 is superseded (read this first)

ADR-0063 diagnosed a real defect — yagni's `duplicate-body-candidate` had
*re-implemented* `graph:duplicated-function-body` and **diverged** (430 yagni
warnings vs 0 graph findings on the same catalog, from different filters). Its
*remedy*, however, was wrong on three counts that only surfaced once we tried to
design the follow-on "reduction coordinator":

1. **It re-introduces the exact coupling it claims to remove.** ADR-0063 makes
   yagni a coordinator that *reuses graph's evidence*. In practice that requires
   yagni to depend on `@opensip-cli/graph` and reach into its internals
   (`runShardedGraph`, `pickAdapter`, `finalizeGraphSignals`, the adapter
   domain — confirmed: graph's shard *planning* needs the adapter loaded in the
   caller's process). That is a **tool → peer-tool internal dependency**, which
   breaks the platform's own invariant: *every tool loads as a plugin; first-party
   tools are not special* (CLAUDE.md; ADR-0061). No third-party tool could do this.

2. **It fails the "what if graph is uninstalled?" test.** Under ADR-0063 yagni's
   primary value is hollow without graph present — a coordinator *needs* its
   source tool. A tool whose usefulness depends on another specific tool being
   installed is not independent, no matter whether the bytes travel by import or
   by a host seam.

3. **Its key technical premise was unverified and is false.** ADR-0063's design
   leaned on a `graph-evidence.ts` comment claiming graph's sharded workers
   "re-bootstrap under yagni (no graph-adapter domain), so fragments never land."
   A spike refuted this: workers are spawned as `node <cliScript> graph-shard-worker
   <spec>` — the parent command (`yagni`/`graph`) never appears in the worker's
   argv; the worker bootstraps as the graph-owned `graph-shard-worker` and loads
   the adapter registry itself. The "freeze" was never inherent to a yagni-driven
   build; it came from yagni choosing the in-process exact build over the sharded
   path it could not reach.

The correct response to *re-implementation divergence* is not "delete one copy and
make the other tool depend on the survivor." It is **single-source the logic in a
substrate both tools depend on** — the platform's own rule (CLAUDE.md: *"the right
move is usually to refactor the shared piece into a substrate"*). ADR-0064 does
that. (ADR-0057 — yagni as an engine with a graph-internal seam — remains
superseded; ADR-0064 also retires its `graph-evidence.ts` seam permanently.)

## Decision

Duplicate / near-duplicate function-body detection is a **shared substrate**, not a
tool's private engine and not a cross-tool dependency. A new leaf package
**`@opensip-cli/clone-detection`** (layer 2; `node:crypto`-only) owns the single
implementation of: the body-hash + MinHash primitives (relocated **verbatim** from
graph), the detection **algorithm**, and — critically — the full curation
**policy** (test-file exclusion, line/char floors, kind exclusion, physical-identity
dedup, cross-package aggregation). It exposes pure functions over a tool-neutral
`CloneCandidate[]` and returns tool-agnostic findings (no `Signal` type leaks in).

Both **graph** and **yagni** depend *down* on this substrate; **neither depends on
the other.** graph's two rules become thin wrappers (map catalog → candidates →
`createGraphSignal`). yagni **re-owns** a duplicate detector that builds its own
TypeScript inventory in-process (via `@opensip-cli/lang-typescript`, which it
already uses) and calls the same shared functions — so `opensip yagni` produces a
complete reduction audit **with graph uninstalled.** A cross-tool parity test makes
the single-implementation guarantee enforceable.

## Alternatives

- **Keep ADR-0063 (yagni owns no detection; coordinator reuses graph)** — rejected:
  re-creates a tool→peer-tool internal dependency, fails the uninstall test, and
  rests on a refuted worker premise (see "Why superseded").
- **Accept duplication (yagni re-implements detection independently)** — rejected:
  this *is* the 430-vs-0 trap. Two copies of hash + filters drift by entropy; the
  divergence was a *filter* gap, not bad luck. Mitigable with parity tests but
  structurally fragile.
- **Host-mediated coordinator (the host runs graph and feeds yagni)** — rejected:
  the host should run tools and provide shared facilities + consistency, not pipe
  one tool's output into another's logic. Relocating the dependency to the host
  does not remove it — yagni still *needs* graph to be useful.
- **Leave duplicate detection to graph only; yagni stays config-surface** — rejected
  on the stated product requirement: `opensip yagni` must be a *complete, standalone*
  reduction audit (duplicates included), not one lane of a split.
- **Share only the hash, not the policy** — rejected: the defect was filter
  divergence, not hash divergence. Sharing the hash alone lets 430-vs-0 recur; the
  package must own the curation policy too.

## Rationale

The feasibility rests on facts verified in code:

- **The body hash is over normalized *text*** — `SHA-256(normalizeWhitespace(
  stripComments(bodyText)))` (`graph/engine/src/lang-adapter/body-digest.ts`). The
  tree-sitter node never enters the hash; graph's *TypeScript* path already uses the
  **TS compiler API** (`ts.Node`, `sourceFile.text.slice(getStart, getEnd)`) — the
  same parser yagni uses. So a second producer reproduces the hash byte-for-byte.
  No tree-sitter adoption is required.
- **`stripComments` already lives at layer 3** in `@opensip-cli/lang-typescript`,
  which both consumers already depend on. The only graph-only pieces are pure
  `node:crypto` primitives (`body-digest.ts`, `near-duplicate-signature.ts`).
- **graph's git-tracked fingerprint baseline keys on `ruleId|filePath|line|column`**
  (`baseline-strategy.ts`), *not* on bodyHash or message. A refactor that preserves
  *which* occurrences fire and *where* is byte-stable by construction — provided the
  hash primitives move by **verbatim relocation** (the bodyHash value is the catalog,
  cache, and exact-vs-sharded equivalence-guardrail identity key; any semantic edit
  invalidates all three).
- **The freeze was edge resolution (Stage 2), not body hashing (Stage 1).** yagni's
  own inventory is a single-threaded full-tree TS parse — seconds-scale, animated by
  the existing yield/spinner plumbing — not the ~40s sharded call-graph build.

So the shared substrate is mostly *relocation*, the graph migration is provably
byte-stable, and yagni becomes independently complete. The divergence is prevented
**structurally** (one implementation of hash + policy), not by deletion.

## Consequences

- **New package `@opensip-cli/clone-detection`** at layer 2 (`node:crypto`-only,
  no workspace deps). Relocate `body-digest.ts` + `near-duplicate-signature.ts`
  **verbatim** (incl. `NEAR_DUP_SIGNATURE_VERSION` and all LSH constants). It owns
  the `CloneCandidate` input type, the threshold opts, `findDuplicateBodies()` /
  `findNearDuplicates()`, and the full curation policy. `@opensip-cli/graph`
  re-exports the relocated primitives from its barrel → its five adapters change
  nothing and bodyHash stays byte-identical.
- **graph's rules become thin wrappers:** `duplicated-function-body` and
  `near-duplicate-function-body` map `Catalog → CloneCandidate[]`, call the shared
  functions, and keep their `createGraphSignal` message/severity/metadata. Output is
  byte-stable (fingerprints key on location).
- **yagni re-owns a duplicate detector** (reversing ADR-0063's deletion): a small
  `lang-typescript`-backed extractor builds `CloneCandidate[]` from the TS AST and
  calls the same shared functions, wrapping results in yagni reduction metadata.
  **yagni gains a dependency on `@opensip-cli/clone-detection` and keeps NO
  dependency on `@opensip-cli/graph`.**
- **A cross-tool parity test** (fixture corpus through both extractors → identical
  hashes + identical groups) is the standing regression guard for "one
  implementation."
- **Initial scope is TypeScript-only for yagni** (matching its single `lang-typescript`
  dependency and config focus); graph stays multi-language. The two agree on TS
  (parity-enforced); the shared algorithm is already language-agnostic, so
  multi-language yagni later is just additional extractors — no corner painted.
- **Track 1 (v0.1.12 detector deletion) stands** as the correct interim: it removed
  the *divergent* copy, the graph coupling, and the in-process build. ADR-0064 adds
  duplicate detection back the right way. The deprecated `--graph`/`graphMode`
  surface from Track 1 is removed (not revived) — yagni's new path needs no graph
  evidence mode.
- **Enforcement:** a dep-cruiser rule keeps `clone-detection` a leaf; `yagni-no-graph*`
  rules stay (yagni must not import graph engine/adapters); the parity + the existing
  fingerprint-golden / body-digest-golden / equivalence-guardrail tests gate every
  migration step.

**Related specs / ADRs:** a build spec (`docs/plans/specs/shared-clone-detection.md`,
to be written) details the package API, the byte-stable graph migration order, the
yagni TS extractor, and the parity test. Supersedes ADR-0063 (and the residual
ADR-0057 graph-evidence seam). Related: ADR-0062 (near-clone detection — the MinHash
machinery that moves into the substrate), ADR-0036 (baseline fingerprints — the
location-keyed strategy that makes the graph migration byte-stable), ADR-0061
(launch posture / extension-trust tiers — the plugin-independence invariant this
upholds).
