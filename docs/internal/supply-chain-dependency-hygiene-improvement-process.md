# Supply Chain & Dependency Hygiene Improvement Process

**Goal**: Drive the OpenSIP CLI codebase to a state with no new high-impact supply-chain or dependency hygiene issues, and to systematically improve dependency management, trust policies, build hygiene, and vulnerability surface so that the project remains safe and maintainable.

This process follows the *exact same meta-structure and hard rules* as the Correctness Remediation Process and the Performance Improvement Process.

## Hard Rules (Non-Negotiable)
(Identical to previous processes)
- **Worktree Only**: All work must be performed inside a dedicated git worktree. The primary checkout remains untouched.
- **Final Summary Document**: Upon termination, create `final-summary.md` (or dated variant) in `docs/remediation/`.
- **No Direct Merge to Main**: The agent must never merge or push from the worktree. A human must review everything first.

## Core Principles
- Follow the four steps strictly.
- Prevention mechanisms are prioritized (local checks for dep hygiene, trust, etc.).
- Architecture-first: medium/large changes (e.g., new trust policies, changes to pnpm-workspace.yaml, enhanced supply-chain verification scripts) route through specs.
- Every round re-validates previously created mechanisms.
- Use Coverage Reports for focused delta work after the baseline.
- The process is iterative until zero new high-impact supply-chain issues are found and no new specs are required.

## The 4-Step Cycle

### Step 1: Discovery (Find Supply-Chain & Dependency Issues)
1. Run full CI gates (typecheck, lint, fit:ci, graph:ci, supply-chain:verify, etc.).
2. Execute a supply-chain-focused audit discovery process:
   - Systematic search for new or heavy transitive dependencies, policy violations (minimumReleaseAge, trustPolicy, allowBuilds), untrusted build scripts, outdated or vulnerable packages, missing provenance/attestations, excessive dependency surface (knip orphans, broad imports), violations of the supply-chain trust model.
   - Leverage existing tools: knip, dependency-cruiser, pnpm audit, verify-supply-chain.mjs, the trustPolicy and overrides in pnpm-workspace.yaml, and manual review of package.json files across packages.
   - Review for "death by a thousand small deps" and places where new deps are added without hygiene review.
3. **Mandatory re-validation**: Re-execute all previously created mechanisms (local dep hygiene checks, etc.).
4. Produce:
   - List of supply-chain and dependency hygiene issues and opportunities (with package references and blast radius).
   - Detailed **Coverage Report** (what package surfaces, dep categories, and policies were exercised; what was not covered this round).

**Baseline vs. Delta vs. Final Deep Pass**:
- Round 001 = baseline (broad discovery across the monorepo).
- Subsequent = delta-informed using prior Coverage Reports.
- Final = one heavy deep pass.

### Step 2: Create Prevention Mechanisms
For each finding or cluster:
- Create project-local mechanisms only (in `opensip-cli/fit/checks/` or local scripts — never shipped in check packs).
  - Examples: local fit checks or scripts that run on changed packages inside the worktree ("no new deps above X weight without justification", "all new direct deps must satisfy minimumReleaseAge and trustPolicy", "no new build scripts unless explicitly allowlisted").
  - Local extensions to existing verify scripts.
  - Test harnesses that assert hygiene properties on the current lockfile and package graph.
- Re-validate that the mechanism would catch the issue.

**Architectural cases**:
- If proper improvement requires medium/large architectural work (changes to the trust model, new OIDC or provenance requirements, major pnpm config overhauls, enhanced SBOM generation), create a spec.
- Pending specs do not stop the loop.

### Step 3: Resolve / Implement Improvements
- Small/medium: implement directly (full gates, including any supply-chain verification steps). Include notes on improved hygiene.
- Medium/large: create spec for human review. Avoid band-aids.

### Step 4: Repeat
Return to Step 1.

## Termination Condition
Same as previous processes: zero new high-impact issues in a full cycle + no new specs required.

**Upon termination**:
- Create final summary in `docs/remediation/`.
- Human review required before any merge.

## Artifacts and Recording
- Process definition: `docs/internal/supply-chain-dependency-hygiene-improvement-process.md` (committed).
- Per-round records and final summary: `docs/remediation/` (gitignored — ephemeral, worktree-only).
  - Records must include date, findings, Coverage Report, mechanisms (local only), specs, improvements, open items.
- All created from within the worktree.

## Invocation
To run: "Run the Supply Chain & Dependency Hygiene Improvement Process (see docs/internal/supply-chain-dependency-hygiene-improvement-process.md). Perform all work inside a dedicated git worktree. Start with round NNN using prior Coverage Reports for delta guidance."

The agent must follow the rules exactly as in the performance and correctness processes.

**Inter-cycle Merge Gate**: When running the family of improvement processes in the agreed order, the code changes from one domain (new local mechanisms + any direct fixes) must be merged to main by a human before the agent creates a worktree for the next domain. See the central note in `improvement-processes.md` ("Inter-cycle Merge Gate") for the rationale: it guarantees that each new cycle starts with an up-to-date baseline and the full accumulated set of prevention mechanisms for re-validation.

### Worktree Setup (Typical)
```bash
git worktree add ../supply-chain-remediation-$(date +%Y%m%d) -b supply-chain-dependency-hygiene-improvement
cd ../supply-chain-remediation-$(date +%Y%m%d)
# All work here.
```

## Notes on Evolution and Adaptation
Direct adaptation of the correctness and performance processes.

Leverages heavily:
- Existing knip, dependency-cruiser, pnpm policies, verify-supply-chain.mjs, and the supply-chain section of pnpm-workspace.yaml.
- The "death by a thousand small deps" and trustPolicy work already present.

Key differences:
- "Issues" are hygiene and supply-chain risks rather than runtime defects.
- Mechanisms are often scripts or local checks that gate on package.json / lockfile changes.
- Architectural work frequently touches the root pnpm configuration and release processes.

Review after baseline and final deep pass.

Initial baseline: `supply-chain-round-001-baseline.md` (in worktree).

---
*Adapted from the collaborative correctness and performance processes (2026-06).*