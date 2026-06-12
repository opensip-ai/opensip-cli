/**
 * @fileoverview PR-lane execution of the RELEASE smoke scenario list.
 *
 * The release lane (`scripts/smoke-pack.mjs`) packs every workspace tarball,
 * installs them into a throwaway consumer, and drives the installed bin through
 * `buildPackedSmokeScenarios`. That pack+install half can only run at release —
 * but the scenario list itself is data, and historically it executed ONLY in
 * the release lane: a `--json` shape change could merge green and surface days
 * later as a publish blocker (it did, twice, on the 2.12.0 cycle).
 *
 * This suite closes that drift window: it runs the IDENTICAL scenario list (the
 * same `.mjs` module the release lane imports — not a copy) against the built
 * dist CLI in a fresh consumer dir on every PR. What remains release-only is
 * exactly what cannot run earlier: the packed-bytes/install mechanics
 * (inter-package export mismatches, bundled-dep resolution), which
 * `smoke-pack.mjs` still owns.
 *
 * The two plugin-install scenarios exercise real packed bytes: the fixture
 * plugins are `npm pack`ed into the consumer dir here, exactly as the release
 * lane does (offline — `npm pack <local dir>` touches no registry).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildPackedSmokeScenarios } from '../../../../scripts/smoke-pack-scenarios.mjs';

import { CLI_PKG_VERSION, distRunner } from './harness/cli-acceptance.js';

/** `npm pack` a fixture plugin dir into `destDir`; returns the tarball path. */
function packFixture(fixtureDir: string, destDir: string): string {
  const out = execFileSync('npm', ['pack', '--pack-destination', destDir, fixtureDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  const tarballName = (lines.at(-1) ?? '').trim();
  return join(destDir, tarballName);
}

let consumerCwd: string;
let toolPluginTarball: string;
let fitPackTarball: string;

beforeAll(() => {
  consumerCwd = mkdtempSync(join(tmpdir(), 'ost-pr-smoke-'));
  const fixturesDir = fileURLToPath(new URL('fixtures', import.meta.url));
  toolPluginTarball = packFixture(join(fixturesDir, 'tool-plugin'), consumerCwd);
  fitPackTarball = packFixture(join(fixturesDir, 'fit-pack-plugin'), consumerCwd);
  // The fit-pack fixture imports `@opensip-tools/fitness` (it authors via the
  // real `defineCheck`). In the release lane the consumer's node_modules
  // carries the packed workspace; here the BUILT workspace package stands in,
  // via the same resolution walk (installed plugin → up to the consumer's
  // node_modules). Node follows the symlink to its real path, so fitness's own
  // deps resolve from the workspace exactly as the packed install resolves
  // them from the consumer tree.
  mkdirSync(join(consumerCwd, 'node_modules', '@opensip-tools'), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL('../../../fitness/engine', import.meta.url)),
    join(consumerCwd, 'node_modules', '@opensip-tools', 'fitness'),
    'dir',
  );
}, 120_000);

afterAll(() => {
  rmSync(consumerCwd, { recursive: true, force: true });
});

describe('packed-smoke scenario list (release lane parity, PR lane)', () => {
  it('every release smoke scenario passes against the built CLI', () => {
    const scenarios = buildPackedSmokeScenarios({
      // The dist CLI reports the workspace version; the release lane re-runs
      // the same scenario against the packed bytes with the release tag.
      expectedVersion: CLI_PKG_VERSION,
      consumerCwd,
      toolPluginTarball,
      fitPackTarball,
    });
    const results = distRunner().runScenarios(scenarios);

    // Scenarios are order-dependent (later ones consume earlier side
    // effects), so report every failure at once instead of stopping at the
    // first — one broken early scenario otherwise hides the rest.
    const failing = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.failures.join('; ')}`);
    expect(failing).toEqual([]);
    expect(results.length).toBeGreaterThan(0);
  }, 300_000);
});
