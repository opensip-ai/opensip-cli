# Phase 9: NPM publish (OIDC bootstrap for the new package)

**Goal:** Publish v2.0.0 to npm. Because Phase 0 introduces a brand-new package (`@opensip-tools/datastore`), the standard OIDC trusted-publishing flow cannot run cold — npm requires the package to exist on the registry before a trusted publisher can be configured for it. This phase walks the bootstrap workflow that creates the package, configures OIDC for it, and then publishes via the normal release flow.
**Depends on:** Phase 8 (Validation passes against the v2.0.0-rc.1 build).

This phase deliberately comes **after** Tests and Validation, deviating from the backend-plan skill's "nothing after Validation" rule. The justification is operational: NPM publish is a planned, multi-step deployment handshake unique to opensip-tools (per `RELEASING.md:114-152`), not an open-ended follow-up. Capturing it here keeps the release contract auditable in one document.

The workflow has a human-in-the-loop step: the maintainer creates a temporary NPM token (which can't and shouldn't be committed) and the agent executes the bootstrap script with that token in env, after which the maintainer configures trusted publishers via the npmjs.com web UI and deletes the token.

---

## Task 9.1: Maintainer generates a short-lived NPM token

**Files:** [no files modified — out-of-band human action]

**Context:** OIDC trusted publishing requires a pre-existing npm package. New packages must be created with explicit credentials first. Per `RELEASING.md:132-134`, this is a granular access token, scoped to `@opensip-tools/*`, with publish permission and 1-day expiry.

**Steps (maintainer, out-of-band):**

1. Go to npmjs.com → account settings → access tokens.
2. Create a **Granular Access Token** with:
   - Scope: `@opensip-tools/*` packages
   - Permissions: publish
   - Expiry: 1 day (short-lived; will be deleted after this phase regardless)
3. Share the token value with the agent via the chat interface (secure input). **Do not commit it anywhere.**

**Verification:** Token value is shared with the agent. Agent confirms receipt without echoing the token in subsequent output.

**Commit:** none (no code change).

---

## Task 9.2: Run the bootstrap publish script

**Files:** [no files modified — runtime publish action]
- Invokes: `tools/bootstrap-publish.sh`

**Context:** The script (per `RELEASING.md:138-146` and the script header at `tools/bootstrap-publish.sh`) is idempotent. It iterates all 18 workspace packages in dependency order (mirroring `.github/workflows/release.yml` publish order), skips any whose current `package.json` version is already on npm, and for each missing version: `pnpm pack` → `npm publish <tarball>` using the supplied token. At the end it prints a list of newly-created packages with direct links to their npmjs.com settings pages.

For this release, **the new package is `@opensip-tools/datastore`.** Already-existing packages (the other 17) are at v2.0.0 which has not yet been published either — so the script will also bootstrap-publish v2.0.0 for them. This is correct behavior: bootstrap mode publishes without provenance (the script doesn't have OIDC); subsequent OIDC-driven releases regain provenance.

**Steps:**

1. Confirm the maintainer's token is available in the environment (via shell-level export or process env passed to the script). Do not echo it.
2. Run:
   ```bash
   NPM_TOKEN=<token> ./tools/bootstrap-publish.sh
   ```
3. Capture the script's output. The final section lists newly-created packages with links of the form `https://www.npmjs.com/package/@opensip-tools/<pkg>/access`. Surface those links to the maintainer for Task 9.3.
4. If the script errors partway, do **not** retry blindly. The script is idempotent — re-running it skips packages already published. But investigate the error first (most common: network timeout, in which case re-run is safe; auth failure means the token is wrong or expired).

**Verification:**

```bash
# Spot-check that the new package is on the registry:
npm view @opensip-tools/datastore@2.0.0
# Spot-check an existing package's new version:
npm view @opensip-tools/core@2.0.0
```

**Commit:** none (no code change; this is an external action).

---

## Task 9.3: Maintainer configures trusted publishers and deletes the token

**Files:** [no files modified — out-of-band human action]

**Context:** Trusted publisher configuration is per-package on npmjs.com and can't be automated by an agent (it requires authenticated browser session with org-admin privileges). Per `RELEASING.md:147-149` and the bootstrap script header (lines 19-26), the configuration is:

- org: `opensip-ai`
- repo: `opensip-tools`
- workflow: `release.yml`
- environment: (leave empty)

**Steps (maintainer, out-of-band):**

1. For each link the bootstrap script printed (especially `@opensip-tools/datastore`, but also verify each pre-existing package still has its trusted publisher entry — bootstrap doesn't touch existing entries, but a sweep is cheap):
   - Open the link in a browser.
   - Add a trusted publisher entry with the values above.
2. Once all newly-created packages have trusted publishers configured, **delete the npm token created in Task 9.1**. This is non-negotiable per `RELEASING.md:150` — short-lived tokens become long-lived risks if forgotten.
3. Confirm completion to the agent so the plan can advance to Task 9.4.

**Verification:** Maintainer confirms all trusted publishers are configured and the token is deleted. No mechanical verification — trust the maintainer's confirmation; a stale token only matters if it's used, and OIDC will be used going forward.

**Commit:** none.

---

## Task 9.4: Verify the normal release flow takes over

**Files:** [no files modified — release-pipeline verification]

**Context:** Per `RELEASING.md:151-152`, subsequent releases follow the normal tag-driven OIDC flow. To confirm that future releases will work without bootstrap-style intervention, run the verification script and inspect the workflow's preflight step.

**Steps:**

1. Run the verification script:
   ```bash
   node tools/verify-release.mjs
   ```
   (Verify this script exists per the `tools/` directory listing; if it produces a different command, follow its README.)
2. Inspect `.github/workflows/release.yml`'s preflight step output for the next release tag — it should no longer warn about missing trusted publishers for `@opensip-tools/datastore`.
3. **Tag the v2.0.0 release** following the existing tag-driven release procedure in `RELEASING.md`. The release workflow runs OIDC-driven publish for all packages and includes provenance.

**Verification:**

```bash
git tag v2.0.0
git push origin v2.0.0
# Then watch .github/workflows/release.yml run to completion; verify all 18 packages
# publish with provenance (visible in the npmjs.com UI under each package).
```

**Commit:** the tag itself is the artifact (`v2.0.0`).

---

## Phase 9 End-to-End Verification

```bash
# All 18 packages published at 2.0.0:
for pkg in core datastore contracts cli \
           lang-typescript lang-rust lang-python lang-go lang-java lang-cpp \
           fitness simulation graph \
           checks-typescript checks-universal checks-python checks-go checks-java checks-cpp; do
  npm view @opensip-tools/$pkg@2.0.0 version || echo "MISSING: @opensip-tools/$pkg"
done
# Trusted publishers configured for the new datastore package:
# (manual: visit https://www.npmjs.com/package/@opensip-tools/datastore/access)
# Token deleted:
# (manual: maintainer confirms at npmjs.com account settings)
```

Expected state: v2.0.0 is published; the new `@opensip-tools/datastore` package exists on npm with a trusted publisher entry; the maintainer's bootstrap token is deleted; the next release will run pure-OIDC without any manual bootstrap step.

## Why this phase exists as a distinct plan step

The skill's standard plan shape ends with Validation because the OpenSIP backend's deployment is an automated pipeline that fires post-merge. opensip-tools' deployment is **a tag-driven workflow with a one-time human-in-the-loop step for new packages.** Capturing that step in the plan rather than as a side-channel checklist:

- Makes the dependency on `@opensip-tools/datastore` (introduced in Phase 0) traceable all the way to publish.
- Prevents the "we forgot to configure the trusted publisher and the release workflow 404'd" failure documented at `RELEASING.md:120-127`.
- Gives a clean audit trail for which release introduced which new package.

When a future plan adds another new package, this phase template can be reused.
