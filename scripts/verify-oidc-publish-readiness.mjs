#!/usr/bin/env node
/**
 * verify-oidc-publish-readiness — pre-tag gate that catches the single most
 * recurring release failure: a publishable package whose npm OIDC trusted
 * publishing is not configured, so `stage-release`'s `npm publish --provenance`
 * dies with a 404/permission error mid-loop (after other packages already
 * published immutably). This bit `@opensip-cli/shared-analysis` across 0.8.0,
 * 0.8.1, and 0.8.2.
 *
 * npm cannot be queried for a package's trusted-publisher config anonymously,
 * so we use the reliable PROXY that OIDC publishing leaves behind: a version
 * published via OIDC carries a sigstore **provenance attestation**
 * (`dist.attestations`); a one-time token bootstrap does not. A package whose
 * HIGHEST published version has no attestation was last published OUTSIDE the
 * OIDC flow — a strong signal its trusted publisher is unset (or the config
 * regressed), which the next OIDC release would hit.
 *
 * Two subtleties, both learned by probing the real registry:
 *   - Check the HIGHEST published version, not the `latest` dist-tag: a package
 *     can OIDC-publish a new version to a staging tag while `latest` still points
 *     at an old pre-provenance release (`codebase` did exactly this). The most
 *     recent publish reflects the current config.
 *   - `dist.attestations` is only exposed by a DIRECT per-version query
 *     (`npm view pkg@ver`), not the aggregated packument's `versions` map — so
 *     the caller must resolve attestation via a per-version fetch.
 *
 * Classification (pure; network is injected):
 *   - `new`           — not on npm: needs the one-time bootstrap + trusted-
 *                       publisher ceremony before its first OIDC release.
 *   - `no-provenance` — on npm but its highest version lacks an attestation:
 *                       verify trusted publishing is configured for opensip-ai/
 *                       opensip-cli/release.yml before tagging.
 *   - `ok`            — highest version carries a provenance attestation.
 *
 * Run before tagging: `pnpm release:check-publish-readiness`. It queries the
 * public registry only (no auth, no writes) and exits non-zero on any `new` or
 * `no-provenance` package with actionable remediation.
 */

import { execFileSync } from 'node:child_process';

import { RELEASE_PACKAGE_ORDER } from './release-package-order.mjs';

const REGISTRY = 'https://registry.npmjs.org/';

/**
 * Classify one package's publish readiness from a resolved registry probe. Pure:
 * `probe` is `null` when the name is absent, else
 * `{ highestVersion, highestVersionAttested }`. No I/O — unit-tested directly.
 */
export function classifyPublishReadiness(name, probe) {
  if (probe === null || probe === undefined) {
    return {
      name,
      status: 'new',
      detail:
        'not published on npm — complete the one-time bootstrap + trusted-publisher ' +
        'setup (RELEASING.md §"One-time npm bootstrap") before its first OIDC release',
    };
  }
  if (!probe.highestVersionAttested) {
    return {
      name,
      status: 'no-provenance',
      highestVersion: probe.highestVersion,
      detail:
        `highest published version (${String(probe.highestVersion)}) has no OIDC provenance ` +
        'attestation — its last publish was a token bootstrap, not trusted publishing. Verify a ' +
        'trusted publisher (org opensip-ai, repo opensip-cli, workflow release.yml) is configured before tagging',
    };
  }
  return { name, status: 'ok', highestVersion: probe.highestVersion };
}

/** `npm view` a spec as JSON; `null` on an E404 (absent), throw on other failure. */
function npmViewOrNull(spec) {
  try {
    return JSON.parse(
      execFileSync('npm', ['view', spec, '--json', '--registry', REGISTRY], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`;
    if (/E404|404 Not Found|is not in this registry|no such package/i.test(text)) return null;
    throw new Error(`npm view ${spec} failed (not an E404): ${text.slice(0, 200)}`, { cause: error });
  }
}

/** Compare two dotted numeric versions; -1/0/1. Prerelease-agnostic (release tags only). */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

/** Resolve the registry probe for one package: absent → null, else highest version + its attestation. */
function probePackage(name) {
  const view = npmViewOrNull(name);
  if (view === null) return null;
  const versions = Array.isArray(view.versions) ? view.versions : Object.keys(view.versions ?? {});
  if (versions.length === 0) return null;
  const highest = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(cmpVersion).at(-1);
  const perVersion = npmViewOrNull(`${name}@${highest}`);
  const dist = perVersion?.dist ?? {};
  return { highestVersion: highest, highestVersionAttested: dist.attestations != null };
}

function main() {
  const results = RELEASE_PACKAGE_ORDER.map((pkg) =>
    classifyPublishReadiness(pkg.name, probePackage(pkg.name)),
  );
  const blocked = results.filter((r) => r.status !== 'ok');
  const TAGS = { ok: '✓', new: '⊕ NEW', 'no-provenance': '✗ NO-PROVENANCE' };
  for (const r of results) {
    const suffix = r.detail ? ` — ${r.detail}` : '';
    process.stdout.write(`  ${TAGS[r.status]}  ${r.name}${suffix}\n`);
  }
  if (blocked.length > 0) {
    process.stdout.write(
      `\n[verify-oidc-publish-readiness] ${String(blocked.length)} package(s) are not ` +
        'OIDC-publish-ready. Configure trusted publishing (or bootstrap new names) BEFORE ' +
        'tagging — otherwise stage-release fails mid-loop after publishing immutable versions.\n',
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `\n[verify-oidc-publish-readiness] OK — all ${String(results.length)} publishable ` +
      'packages carry OIDC provenance (trusted publishing configured).\n',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
