# `@opensip-cli/agent-eval`

This workspace-private, never-published package measures how effectively a
coding agent can recover useful codebase context through OpenSIP's public CLI
and MCP surfaces. It compares deterministic, scripted OpenSIP playbooks with a
control arm limited to ordinary file search, glob, and read operations.

The harness is a surface-quality proxy. It measures answer correctness,
false-empty answers, evidence volume, and retrieval cost under frozen tasks. It
does not measure adoption, model reasoning quality, prompt quality, or how often
real users choose a feature.

## Running it

Build artifacts are a hard prerequisite because the harness treats OpenSIP as
a black box. Runs currently require macOS or Linux. The harness combines a root
process group with bounded `/bin/ps` sampling so it can clean up detached
descendants it observes before they are reparented. This is not OS-enforced
containment: a child can create a new session and leave the root lineage between
samples. If inherited stdio does not close, the harness force-settles the run as
failed instead of hanging, but it cannot prove cleanup of an unobserved escape.
Observed PID identities combine the second-resolution process start time with
process group, session, and a fingerprint of the full command/executable. Those
facets reduce accidental PID-reuse collisions but cannot eliminate the remaining
same-second collision window without a native kernel identity.
Windows fails closed until the harness has Job Object containment:

```sh
pnpm agent-eval --list
pnpm agent-eval --smoke
pnpm agent-eval
pnpm agent-eval --task impact-estimate.customer-ts --arm opensip
pnpm agent-eval --json ./my-evaluation.json
```

`--task` is repeatable. `--arm` accepts `control`, `opensip`, or `both`. Every
evaluation writes an immutable JSON report and a same-named Markdown summary;
explicit `--json` paths never suppress the Markdown companion. Default outputs
land in the gitignored `results/` directory with the UTC timestamp, CLI
version, and Git SHA in the filename. A report from a dirty worktree or a source
revision that changed during execution is explicitly non-promotable and its
default filename carries a `-dirty` suffix. Clean reports are the only artifacts
whose SHA identifies all measured source. Every report also carries a required
`contractFingerprint`: a SHA-256 digest of the selected task truth and committed
fixture bytes. Versioned arm strategies are deliberately excluded because their
versions are recorded on each arm. Fingerprinting and disposable execution both
consume the same bounded Git-visible regular-file inventory; ignored install,
build, environment, and log artifacts are neither hashed nor copied.

Dogfood native reads/searches/globs are likewise restricted to a bounded Git-
visible path view. Git provenance also runs a bounded ignored-file query for every
language source, package/build manifest, and graph configuration class that graph
discovery can consume, outside its known excluded directories. Any match marks the
report dirty and non-promotable. This protects the reused OpenSIP catalog arm when
graph-relevant ignored input would otherwise sit outside the commit SHA.

Reports retain normalized facts, byte counts, and bounded setup metadata. They
record that the MCP project root was verified without persisting the absolute
root itself, and retain only stderr byte/truncation metadata rather than raw
stderr content. The JSON `sourceState` and `promotionEligible` fields, and their
Markdown equivalents, prevent calibration runs from being mistaken for clean
promotion evidence.

Dogfood tasks reuse the repository's existing catalog and never rebuild it.
Run `pnpm graph` first when evaluating `*.dogfood` tasks.

## What the metrics mean

- **Incorrect none** counts a complete empty response where the strategy
  declared that evidence exists. Failed, truncated, incomplete, and genuinely
  empty-complete responses remain distinct.
- **Negative proof** is accepted only when the same-leg prefix is transport-
  exhaustive, every projection-relevant step explicitly attests a lossless
  response projection, and the proof-bearing step attests that its semantic
  domain is exhausted. Durable `proofRelevance` and `proofClosure` diagnostics
  record those decisions and bounded reason codes. Missing projection
  attestations fail closed; only an independent setup/state step may opt out as
  `irrelevant`. A terminal search over a truncated, lossy, unresolved, or still-
  open frontier cannot certify absence. Proof assessors validate the same
  projection boundary as their extractors, including successful manifest
  parsing and every node at a bounded traversal depth.
- **Response bytes** is the headline cross-arm unit: UTF-8 bytes returned by
  the steps actually consumed before early exit.
- **Turns** is deterministic tool-call count. It approximates agent turns but
  is not a literal model-turn measurement.
- **Time to first useful context** is accumulated step time until a fact used
  by the answer first appears.
- **Setup** reports `init`, graph-build, MCP-handshake, and mandatory catalog-
  probe time separately from retrieval cost; the Markdown summary also shows
  catalog-probe response bytes.
- **Recovery** reports the calls, bytes, and time in a staleness recovery leg;
  it never contaminates primary cost.

Wall-clock values are diagnostic. Assertion outcomes, incorrect-none counts,
call counts, and response bytes are the deterministic comparison surface.

The impact baseline deliberately separates file correctness from structural
proof. Every known direct, test, barrel, dynamic, and cross-package caller must
be returned as a file and have response-derived supporting evidence at the
ground-truth confidence. An owner-only unresolved call is retained as a
diagnostic, but it counts as reverse-caller proof only when its bounded target
hashes match the response-derived target handle. Unlinked dynamic callers stay
failed or inconclusive rather than receiving inferred graph confidence. Barrel
and dynamic callers additionally require a response-derived symbol. Native text
search is not allowed to synthesize graph confidence, so those structural
assertions — and the workspace control arm's unrelated-package over-selection —
preserve a measured **quality baseline** instead of being patched over with
ground truth. Those tasks are tagged `quality-baseline`: the tools already
exist on the current surface, and remaining failures measure completeness,
confidence, and proof honesty — not tool absence.

The two staleness tasks use the small `customer-staleness` fixture rather than
the broader TypeScript customer. Its complete reverse inventory isolates the
catalog-invalidation question: a degraded traversal cannot be mistaken for a
stale catalog served as fresh. Both edit classes then measure an explicit
`refresh_graph` recovery leg.

## Promotion protocol

Use the harness when promoting an agent-facing context capability:

1. On `main`, build the same checkout and run the relevant tasks on the same
   machine and in the same working session as the proposed change. Confirm the
   report says `sourceState: "clean"` and `promotionEligible: true`.
2. On the slice branch, repeat the run with the same tasks and arms.
   The branch report must also be clean and promotion-eligible; dirty reports
   remain useful for local calibration but are not valid before/after evidence.
3. Confirm both reports have the same selected task ids and exactly the same
   `contractFingerprint`. A mismatch means the question, assertions, edit
   contract, or fixture bytes changed and the runs are not a valid promotion
   comparison; review the source diff and establish a new baseline instead.
4. Attach both clean JSON and Markdown artifacts to a review under
   `docs/plans/reviews/`.
5. Compare correctness first. A promotion must introduce no new incorrect
   `none` outcomes and must not regress required facts.
6. Compare response bytes, turns, and time to first useful context against the
   control arm and the recorded before-run. Treat setup and recovery as
   separately disclosed costs.

Tasks, fixtures, assertions, and ground truth stay frozen across a promotion.
Only strategies change when the public surface changes, and every strategy
version names the MCP surface epoch it targets. The contract fingerprint makes
accidental question/assertion/fixture drift visible across revisions. There are intentionally no
committed metric thresholds yet; the first promotion cycles establish which
task-specific thresholds are stable enough to enforce.

## Authoring tasks and fixtures

- Author the control strategy first, as a competent stock coding agent would
  search. Both arms must start only from the question or universally
  discoverable roots such as manifests and README files.
- Follow indirect references through response-derived caller names and bounded
  search context when a direct text match is not a competent stopping point.
- Bind follow-up arguments from prior normalized response facts. Never copy a
  symbol ID, declaration ID, caller path, package name, or fallback command out
  of ground truth into an extractor.
- Keep every search, walk, page, read, and response explicitly bounded. An
  empty or incomplete result is evidence; do not fabricate a fallback fact to
  make an arm pass.
- Add customer fixtures under `__fixtures__/` with no OpenSIP config, runtime
  directory, agent guidance, credentials, or generated build output. Pin every
  assertion-relevant fact in the colocated ground-truth integrity suite.
- Keep fixture lockfiles executable in isolation. Validate TypeScript fixtures
  from temporary copies with a frozen offline install before build/test; never
  rely on the monorepo's hoisted toolchain.
- Register new tasks in `src/tasks/index.ts`. Its uniform test owns vocabulary,
  deep-freeze, binding, fixture-resolution, and ground-truth invariants.
- Keep dogfood tasks read-only: no edits, `refresh_graph`, or repair tools.

After a new task family is stable, perform a manual calibration by pointing a
real coding agent at the fixture and comparing its investigation with the
scripted playbook. That sanity check can reveal an unrealistic strategy, but it
does not replace the deterministic promotion report.

## Design records

- [ADR-0157](../../docs/decisions/ADR-0157-agent-eval-black-box-harness.md)
  keeps this package outside the runtime it measures and makes its zero-import
  boundary executable.
- [ADR-0158](../../docs/decisions/ADR-0158-agent-eval-deterministic-measurement.md)
  records the control-first two-arm methodology, frozen answer contracts, and
  immutable report-artifact plane used by the promotion protocol.
