---
name: release-prep
description: >
  Prepare an opensip-cli version release end-to-end: bump all version surfaces,
  draft CHANGELOG, regenerate derived docs, run the local release preflight lane,
  and (only when explicitly asked) commit, tag, push, and verify npm publish.
  Use when the user says "prep for release", "cut a release", "bump version",
  "release vX.Y.Z", "new version release", "release prep", "bootstrap a new
  package", "bootstrap-publish", or "remove a publishable package". NOT for
  feature merge gates — use the ship skill for that. NOT for unrelated projects.
---

# Release Prep Skill (opensip-cli)

Prepare a **tag-driven npm release** for the opensip-cli monorepo. Releases
publish **33 packages** in dependency order via OIDC trusted publishing when a
`v*` tag is pushed.

**Authoritative reference:** `RELEASING.md` (recovery, partial publish, new
package bootstrap). **Policy:** `docs/decisions/ADR-0012-versioning-and-release-policy.md`.

> **Counts are illustrative, scripts are authoritative.** Any package/file/check
> count in this skill (e.g. "33 packages") is a snapshot for orientation, not a
> source of truth. The real values come from `scripts/release-package-order.mjs`
> (publishable set), `scripts/verify-release.mjs` (the enforced checks), and
> `RELEASING.md` (the prose contract). If a count here disagrees with those, the
> scripts win — and the skill prose should be corrected.

## Scope boundaries

| In scope | Out of scope |
| -------- | ------------ |
| Version bump across all surfaces | Feature implementation or PR merge gates (`ship` skill) |
| CHANGELOG entry drafting | Unrelated project releases |
| Derived doc regeneration | Editing committed datastore migrations |
| `pnpm release:preflight` | Bumping a patch just to fix a partial npm publish |
| Commit/tag/push **only when asked** | |

**Default safety gate:** stop after preflight passes. Do **not** tag or push
unless the user explicitly requests it.

## Before you start

1. Read current version from `packages/core/package.json#version` (source of truth).
2. Confirm target version with the user if not provided. Propose semver from
   changes since the last tag (`git log $(git describe --tags --abbrev=0 2>/dev/null || echo HEAD)..HEAD --oneline`).
3. While `0.x` (pre-1.0): treat **minor bumps as potentially breaking** — peer-dep
   guidance uses `^0.y.0`, not `^1.0.0` (see ADR-0012).

## Workflow

Execute these phases in order. Fix failures before advancing.

### Phase 0 — Repo state preflight

Before bumping anything, confirm the working state is release-safe. **A release
commits directly to `main`** — this is the one workflow where the usual "branch
off main" rule is deliberately inverted, so the tree must be pristine and synced
*first*, or you risk tagging a commit CI won't reproduce.

```bash
git rev-parse --abbrev-ref HEAD            # must be: main
git status --porcelain                     # must be EMPTY — no unrelated/uncommitted changes
git fetch origin
git rev-list --left-right --count origin/main...HEAD   # must be: 0  0 (local == origin)
```

If the tree is dirty with unrelated work, stash or land it separately first — a
release commit must contain only release surfaces. If you're not on `main` or
local `main` has diverged from origin, stop and resolve before proceeding.

### Phase 1 — Mechanical version bump

```bash
node scripts/bump-version.mjs <new-version>
pnpm install --lockfile-only
pnpm docs:readmes && pnpm docs:build
node scripts/bump-version.mjs --check
```

`bump-version.mjs` owns (do not hand-edit these):
- 35 `package.json` version fields (33 publishable + root + test-support)
- `docs/public/**` `release: vX.Y.Z` frontmatter (~55 files + root README)
- Scope-qualified peer-dep ranges in docs (`"@opensip-cli/x": "^X.Y.Z"`)
- `SECURITY.md` supported-release row, curated prose markers in `CLAUDE.md`, etc.

It does **not** touch `CHANGELOG.md` or example plugin `"version"` fields.

After bump, scan for drift:

```bash
git grep -n '<old-version>' -- ':!pnpm-lock.yaml' ':!node_modules'
```

Investigate any unexpected hits; most should be fixture/test data (intentionally
left alone).

### Phase 2 — CHANGELOG (human judgment)

Add a top entry to `CHANGELOG.md`:

```markdown
## [X.Y.Z] - YYYY-MM-DD

<release narrative — Changed / Fixed / Added as appropriate>
```

Use today's date from the system (`date +%F`), never a guessed date. Draft from
`git log` since the previous release tag. Match the repo's existing
CHANGELOG voice (complete sentences, user-facing impact, not a raw commit dump).

If crossing the **1.0 boundary**, also review peer-dependency **guidance prose**
in `docs/public/10-concepts/` ("pin to 0.x line" vs "pin to majors").

### Phase 3 — Local preflight (mandatory gate)

**Never tag until this passes.** Do **not** use cached `pnpm test:coverage` —
release prep requires fresh threshold recomputation:

```bash
pnpm release:preflight --expected-version vX.Y.Z
```

This mirrors `.github/workflows/release.yml` before publish:

| Step | Command (via preflight) |
| ---- | ----------------------- |
| Install | `pnpm install --frozen-lockfile` |
| Clean + build | `pnpm -r run clean` → `pnpm build` |
| Typecheck | `pnpm typecheck` |
| Supply chain | `pnpm supply-chain:verify` |
| Lint | `pnpm lint` |
| Coverage | `pnpm test:coverage:fresh` (Turbo `--force`) |
| Dogfood | `pnpm fit:ci` + `pnpm graph:ci` |
| Drift checks | `pnpm verify-release --expected-version vX.Y.Z` |
| Pack smoke | pack all 33 packages + `scripts/smoke-pack.mjs` |

`verify-release` enforces a battery of drift checks including: version lockstep,
CHANGELOG header/date, `docs/web-generated/`, per-package READMEs, keywords,
checks-index, and publishable set == `scripts/release-package-order.mjs`. (The
exact set lives in `scripts/verify-release.mjs` — consult it for the current
list rather than trusting a count here.)

On failure: fix the root cause, re-run from the failed phase (or full preflight
if unsure). Do not skip steps.

### Phase 4 — Commit (after preflight passes)

Stage the release surfaces (version bumps, CHANGELOG, generated docs, lockfile).
**Review first, stage second** — do not `git add -A` before confirming the tree
is release-only, or you risk sweeping unrelated changes into the release commit
(Phase 0 should already guarantee this, but verify here too):

```bash
git status              # review FIRST — every change must be a release surface
git diff --stat         # show this to the user; if anything unrelated appears, STOP
git add -A              # only after confirming the tree is release-only
git commit -m "chore: release X.Y.Z"
```

If any unrelated change is present, stash or handle it separately before staging —
never fold it into the release commit. `bump-version.mjs` printed the exact
surfaces it touched; the staged set should match that plus `CHANGELOG.md` and the
regenerated docs.

### Phase 5 — Tag and push (explicit user request only)

Only when the user asks to cut/publish the release:

```bash
git tag vX.Y.Z
git push origin main vX.Y.Z
```

Watch the workflow:

```bash
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

### Phase 6 — Post-publish verification (explicit user request)

After the release workflow completes:

```bash
node scripts/verify-release-publish-surface.mjs --expected-version vX.Y.Z --tag latest
```

All 33 scoped packages + `opensip-cli` must report the expected version on
`latest`. If the workflow failed mid-loop, see `RELEASING.md` → "Partial publish
recovery" — re-run the workflow on the **same tag**; do not bump a patch version
to "fix" a partial publish.

## Reporting

End each run with a concise status table:

| Phase | Status | Notes |
| ----- | ------ | ----- |
| Repo state | ✅/❌ | on main, clean, synced |
| Bump | ✅/❌ | old → new version |
| CHANGELOG | ✅/❌ | entry date |
| Preflight | ✅/❌ | or which step failed |
| Commit | ✅/⏭️/❌ | |
| Tag/push | ⏭️/✅/❌ | only if requested |
| npm verify | ⏭️/✅/❌ | only if requested |

If preflight fails, include the failing step name and the fix applied (or
proposed fix if blocked).

## Adding a new publishable package

OIDC trusted publishing requires the package **name to already exist on npm**
before trusted publishers can be configured. Brand-new names are bootstrapped
once with a **temporary granular token**; all subsequent versions publish via
OIDC in `.github/workflows/release.yml`.

### Repo changes (before bootstrap)

Single source of truth: `scripts/release-package-order.mjs`. Add/remove there
first; `release.yml`, `bootstrap-publish.sh`, and `release-preflight` derive
their pack/publish loops from it automatically.

1. Create the workspace package (`name` is `opensip-cli` or `@opensip-cli/*`,
   **not** `private: true`). Include `files`, LICENSE/NOTICE (via sync), and
   correct layer dependencies (dependency-cruiser will enforce).
2. Add an entry to `RELEASE_PACKAGE_ORDER` in
   `scripts/release-package-order.mjs` — correct **dependency order**,
   `publishReason`, `dir`, `filter`.
3. Update `RELEASING.md` manually (CI-enforced prose):
   - Add a row to "The N packages" table
   - Update the stated count (`The 33 packages` → `The 34 packages`, etc.)
   - Add the unscoped name to the npm-verify `for p in …` loop (scoped only;
     `opensip-cli` stays on its own line)
4. Update any docs that cite the package count (e.g. `CLAUDE.md`,
   `docs/public/10-concepts/03-modular-monolith.md`) if the count changed.
5. Regenerate derived package metadata:

   ```bash
   pnpm docs:readmes && pnpm docs:keywords && pnpm licenses:sync
   ```

6. Verify the contract test passes:

   ```bash
   pnpm test --filter opensip-cli -- release-package-order
   ```

### One-time npm bootstrap (human + AI, token-sensitive)

**Roles:** the human creates and later deletes the token; configures OIDC on
npmjs.com. The agent runs the bootstrap script only.

1. **Human** creates a **granular** npm access token at
   https://www.npmjs.com/settings/<user>/tokens
   - Scope: `@opensip-cli/*` (publish permission)
   - Short-lived; delete immediately after bootstrap
2. **Human** provides the token to the agent (chat only — never commit it).
3. **Agent** runs (token via env var only — never echo, log, or write to disk
   beyond the ephemeral npmrc the script creates):

   ```bash
   NPM_TOKEN=npm_xxx ./scripts/bootstrap-publish.sh
   ```

   The script:
   - Reads package list from `release-package-order.mjs --print names`
   - **Skips** names already on npm (OIDC release handles those)
   - **Publishes** only brand-new names at the current `packages/core` version
     (without provenance — accepted one-time tradeoff)
   - Prints npm settings URLs for each newly created package

4. **Human** configures **trusted publishing** for each NEW package at its npm
   access page:
   - Organization: `opensip-ai`
   - Repository: `opensip-cli`
   - Workflow: `release.yml`
   - Environment: (leave empty)
5. **Human deletes the npm token.**
6. Future releases use the normal tag-driven OIDC flow — no token needed.

**Never:** commit the token, put it in `.env`, paste it into scripts as a file,
or run bootstrap for a name that already exists on npm (would publish without
provenance and permanently block OIDC for that version).

## Removing a publishable package

There is no removal script. npm versions are **immutable** — you cannot "un-release"
a published version. Removal means: stop publishing from this repo and deprecate on
the registry.

### Repo changes

1. Migrate or remove all in-repo consumers (workspace deps, tool registrations,
   docs references).
2. Delete the package directory **or** set `"private": true` in its
   `package.json` (private packages are excluded from the publishable set).
3. Remove its entry from `scripts/release-package-order.mjs`.
4. Update `RELEASING.md` (CI-enforced):
   - Remove the table row
   - Decrement the stated count (`The N packages`)
   - Remove the unscoped name from the npm-verify `for p in …` loop
5. Update docs that cite the package count if it changed.
6. Regenerate:

   ```bash
   pnpm docs:readmes && pnpm docs:keywords && pnpm licenses:sync
   ```

7. Verify:

   ```bash
   pnpm test --filter opensip-cli -- release-package-order
   pnpm release:preflight --expected-version v$(node -p "require('./packages/core/package.json').version")
   ```

   `verify-release` check #10 will also fail if the order file and discovered
   workspace set diverge.

### npm registry (human operator)

Deprecate the retired package so consumers see a migration message:

```bash
npm deprecate @opensip-cli/<name>@'*' "Package removed in opensip-cli vX.Y.Z — use <replacement>"
```

Do **not** unpublish or bump a patch version to "fix" a mistaken publish — see
`RELEASING.md` → "Partial publish recovery".

Document the removal in `CHANGELOG.md` under the release that stops shipping the
package.

## Common mistakes (avoid)

- Running preflight **before** bump + CHANGELOG + doc regeneration
- Using `pnpm test:coverage` instead of `release:preflight` / `test:coverage:fresh`
- Tagging without preflight passing locally
- Hand-editing `docs/web-generated/` or per-package READMEs (regenerate instead)
- Editing `workspace:*` dependency specifiers during a bump (never needed)
- Confusing this with the `ship` skill (feature PR gate, not version cut)
- Bootstrapping a package name that already exists on npm (blocks OIDC provenance)
- Logging or committing `NPM_TOKEN`
- Forgetting to update `RELEASING.md` prose after add/remove (contract test fails)

## Quick reference

```bash
# Phase 0 — repo state (must be clean, on main, synced)
git rev-parse --abbrev-ref HEAD            # main
git status --porcelain                     # empty
git fetch origin && git rev-list --left-right --count origin/main...HEAD   # 0  0

# Full prep sequence (phases 1–3)
node scripts/bump-version.mjs X.Y.Z
pnpm install --lockfile-only
pnpm docs:readmes && pnpm docs:build
node scripts/bump-version.mjs --check
# … edit CHANGELOG.md …
pnpm release:preflight --expected-version vX.Y.Z
```