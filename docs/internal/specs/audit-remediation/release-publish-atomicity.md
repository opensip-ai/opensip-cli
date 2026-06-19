# Spec: Release publish atomicity and workflow hardening

## Objective

Reduce the blast radius of a **partial npm publish** during the tag-driven release workflow, and harden the OIDC provenance job against supply-chain footguns (floating action tags, concurrent releases).

**Success criteria:**

- Consumers never observe a state where upstream `@opensip-cli/*` packages are at version `X` but `opensip-cli@X` (unscoped CLI) is missing from the registry.
- A failed publish mid-loop does not leave `latest` pointing at an incomplete set without an obvious recovery path.
- Release workflow uses pinned action SHAs (or documents an exception) and a concurrency group.
- Recovery procedure is documented in one place (operator runbook).

## Background (verified)

From `.github/workflows/release.yml:202-248`:

- 33 packages publish **sequentially** to `latest`.
- CLI (`opensip-cli`) publishes **last**.
- `publish_if_new` skips already-published versions — re-run is idempotent but **does not roll back** partial success.
- npm versions are immutable; there is no atomic multi-package transaction.

Version lockstep and topological publish order are **already correct** (generated `release-package-order.mjs` + contract tests). The gap is **atomicity of the consumer-visible release**, not ordering.

## Requirements

### R1 — Staged dist-tag promotion

1. Publish all packages to a staging tag, e.g. `release-candidate` or `next-<version>`, during the loop.
2. After **all** packages succeed, promote to `latest` in one final step (or use npm `dist-tag add` batch).
3. If any publish fails, `latest` remains on the previous complete release.

**Alternative (lighter):** Publish to `latest` but only after a dry-run manifest proves all tarballs exist locally; still vulnerable mid-loop — prefer staged tag.

### R2 — Concurrency guard

Add GitHub Actions `concurrency`:

```yaml
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

Prevents overlapping tag releases racing the same version lane.

### R3 — Pin Actions to SHAs

Replace `@v6` / `@v3` floating majors in the release job (especially `id-token: write` provenance publish) with full commit SHAs. Maintain a small comment or dependabot policy for bumps.

### R4 — Pre-publish verification gate (already partial)

Ensure release workflow keeps: clean dist, build, test:coverage:fresh, verify-release, supply-chain verify — **before** any `npm publish`.

### R5 — Operator runbook

Document:

- How to detect partial publish (`npm view` matrix script).
- Safe recovery: re-run workflow on same tag (idempotent skip).
- When to publish missing packages manually vs bump patch.

## Non-goals

- Changing the 33-package dependency order (already generated).
- pnpm OIDC publish (blocked on ecosystem support — keep npm publish tarball path).

## Implementation plan

1. Add `release-staging` dist-tag constant in `release.yml` / small script.
2. Split publish loop: all scoped packages → staging tag; final step promotes all tags to `latest`.
3. Add concurrency group + SHA pins (table in workflow header).
4. Add `scripts/verify-release-publish-surface.mjs` (optional): given version, assert all expected package names resolve on npm.
5. Update `RELEASING.md` with recovery steps (when implementing — out of scope for spec-only phase).

## Acceptance tests / checks

- [ ] Simulated failure on package 20/33 leaves `latest` unchanged (staging tag holds incomplete set or publish aborts before promotion).
- [ ] Full successful run promotes all 33 + unscoped CLI to `latest`.
- [ ] Re-run on same tag is idempotent (skips published).
- [ ] `concurrency` blocks parallel release workflows on same ref.

## Open questions

1. Staging tag name: `next` vs version-scoped `v0.1.8-rc`?
2. Should staging tags be deleted after promotion?
3. Is GitHub Release creation coupled to `latest` promotion or staging completion?

## References

- `.github/workflows/release.yml`
- `scripts/release-package-order.mjs`
- `RELEASING.md`
- Architecture audit: `docs/internal/coop/agents-log.md`