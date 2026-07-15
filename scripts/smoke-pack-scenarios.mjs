/**
 * @fileoverview Command-level scenario set for the packed-artifact smoke test.
 *
 * `scripts/smoke-pack.mjs` installs the freshly-packed tarballs into a throwaway
 * consumer project and then drives the installed bin through these scenarios via
 * the shared, dependency-free CLI acceptance core
 * (`scripts/cli-acceptance-core.mjs`). The scenarios are data — the core is
 * the only thing that spawns and asserts — so the release lane exercises exactly
 * the same scenario semantics as the in-repo Vitest harness.
 *
 * SINGLE SOURCE OF TRUTH (ADR: installed-artifact platform acceptance): these
 * scenarios are no longer hand-authored here. They are PROJECTED from the
 * canonical journey catalog's `release-smoke` selection
 * (`scripts/platform-acceptance/journey-catalog.mjs`), so the packed smoke and
 * the native platform-acceptance runner exercise byte-identical assertions for
 * every version/help/init/fit/graph/report/sessions/Tool/pack scenario. This
 * module only PROJECTS that subset and layers the packed-fixture paths + the
 * deny-by-default installed-tool allowlist; a parity assertion guarantees each
 * emitted scenario maps to a registered journey id and cannot diverge from the
 * catalog source.
 *
 * THIS LIST RUNS IN BOTH CI LANES. The PR lane
 * (`packages/cli/src/__tests__/packed-smoke-scenarios-e2e.test.ts`) imports this
 * exact module and drives the BUILT dist CLI through it on every PR; the release
 * lane re-runs it against the PACKED, npm-installed bytes (the half only it can
 * do — inter-package export/ABI mismatches). If you change a scenario, change it
 * in the catalog: `pnpm --filter=opensip-cli test packed-smoke-scenarios-e2e`.
 *
 * Command-surface taxonomy (packs-under-the-tool):
 *   - WHOLE Tool plugins (a `kind:"tool"` package contributing a subcommand)
 *     install via `opensip tools install <spec>` — `--project` keeps the install
 *     inside the consumer's `.runtime/plugins/tool/` (hermetic). There is no
 *     top-level `opensip plugin` command anymore.
 *   - Extension PACKS (a `kind:"fit-pack"` package contributing checks) install
 *     via the domain-bound `opensip fit plugin add <spec>` — the domain is bound
 *     from the tool (no `--domain`/`--type` flag), and fit/sim packs always land
 *     project-local in `.runtime/plugins/<domain>/`.
 *
 * Dependency-free (only imports the acceptance core + the catalog, both of which
 * only use node built-ins) so smoke-pack.mjs can import it with no build step.
 */

import {
  assertReleaseSmokeParity,
  projectReleaseSmokeScenarios,
} from './platform-acceptance/journey-catalog.mjs';

/**
 * Build the ordered packed-smoke scenario list by projecting the catalog's
 * `release-smoke` selection and layering the packed-fixture paths + the
 * deny-by-default installed-tool allowlist.
 *
 * @param {object} opts
 * @param {string} opts.expectedVersion   the consensus release version (no leading 'v')
 * @param {string} opts.consumerCwd       the throwaway consumer project dir (already has the CLI installed)
 * @param {string} opts.toolPluginTarball absolute path to the packed `kind:"tool"` fixture tarball
 * @param {string} opts.fitPackTarball    absolute path to the packed `kind:"fit-pack"` fixture tarball
 * @returns {import('./cli-acceptance-core.mjs').Scenario[]}
 */
export function buildPackedSmokeScenarios({
  expectedVersion,
  consumerCwd,
  toolPluginTarball,
  fitPackTarball,
}) {
  // Installed npm tools are deny-by-default; the tool-plugin fixture id must be
  // allowlisted for post-install scenarios that mount/run it in the host process.
  const allowInstalledEnv = { OPENSIP_CLI_ALLOW_INSTALLED_TOOLS: 'audit-demo-tool' };

  const params = {
    cwd: consumerCwd,
    expectedVersion,
    toolPluginTarball,
    fitPackTarball,
  };
  const scenarios = projectReleaseSmokeScenarios(params);
  // Guarantee the projected set is exactly the catalog source (id/name/argv):
  // no scenario can be hand-authored here or diverge from a registered journey.
  assertReleaseSmokeParity(scenarios, params);

  return scenarios.map((scenario) => ({
    ...scenario,
    env: { ...allowInstalledEnv, ...scenario.env },
  }));
}
