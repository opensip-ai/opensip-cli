/**
 * Workspace-invariant contract test: the publishable package set + order is
 * single-sourced and every release surface agrees (ADR-0017).
 *
 * The single source of truth is `scripts/release-package-order.mjs`
 * (`RELEASE_PACKAGE_ORDER` + `discoverPublishablePackages`). This test locks the
 * SIX release surfaces against it so adding, removing, or renaming a publishable
 * package fails CI until EVERY surface is updated:
 *
 *   1. Discovered publishable workspace packages (packages/**, not `private`)
 *      == the reference set. Catches add/remove/rename at the source.
 *   2. `.github/workflows/release.yml` Pack loop  — DERIVED from the source
 *      (`--print pack`); asserts no literal per-package `pnpm --filter … pack`
 *      lines remain (robust to ordering — duplication is the failure, not order).
 *   3. `.github/workflows/release.yml` Publish loop — DERIVED (`--print names`);
 *      asserts no literal `publish_if_new <pkg>` lines remain.
 *   4. `.github/workflows/release.yml` Preflight loop — DERIVED (`--print names`);
 *      asserts no literal hand-listed `for pkg in …` package list remains.
 *   5. `scripts/bootstrap-publish.sh` — DERIVED (`--print names`); asserts the
 *      literal `PACKAGES=( … )` array is gone.
 *   6. `RELEASING.md` — still authored as prose; its "The 31 packages" table,
 *      its stated count, and its npm-verify `for p in …` loop are parsed and
 *      asserted to equal the reference set/count.
 *
 * This sits beside `plugin-kind-contract.test.ts` (the established home for
 * workspace-invariant tests that read repo files) and resolves the repo root the
 * same way.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function findRepoRoot(start: string): string {
  let dir = start;
  let prev = '';
  while (dir !== prev) {
    try {
      readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8');
      return dir;
    } catch {
      // not the root — keep walking up
    }
    prev = dir;
    dir = dirname(dir);
  }
  throw new Error(`could not locate repo root (pnpm-workspace.yaml) from ${start}`);
}

const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

interface ReleaseEntry {
  readonly unscoped: string;
  readonly name: string;
  readonly dir: string;
  readonly filter: string;
  readonly layer?: string;
}

// The source of truth is a plain Node ESM script (no workspace imports), so a
// dynamic import across the package boundary is clean. dependency-cruiser
// excludes test files + `includeOnly: '^packages/'`, so this import is not an
// architecture-layer edge.
const sourceOfTruth = (await import(
  join(REPO_ROOT, 'scripts', 'release-package-order.mjs')
)) as {
  RELEASE_PACKAGE_ORDER: ReleaseEntry[];
  discoverPublishablePackages: (repoRoot?: string) => Promise<{ name: string; dir: string }[]>;
};

const RELEASE_PACKAGE_ORDER = sourceOfTruth.RELEASE_PACKAGE_ORDER;
const referenceNames = new Set(RELEASE_PACKAGE_ORDER.map((p) => p.name));

const read = (relPath: string): string => readFileSync(join(REPO_ROOT, relPath), 'utf8');

describe('release package-order contract (ADR-0017 — workspace invariant)', () => {
  it('the source of truth is non-trivial and CLI-last (sanity)', () => {
    // Guard against a silently-passing test if the import shape ever breaks.
    expect(RELEASE_PACKAGE_ORDER.length).toBeGreaterThan(20);
    expect(RELEASE_PACKAGE_ORDER.some((p) => p.name === '@opensip-tools/core')).toBe(true);
    const last = RELEASE_PACKAGE_ORDER.at(-1);
    expect(last?.name, 'the unscoped CLI must always be published last').toBe('opensip-tools');
    expect(last?.layer).toBe('cli');
    // Exactly one CLI entry (the unscoped composition root).
    expect(RELEASE_PACKAGE_ORDER.filter((p) => p.layer === 'cli')).toHaveLength(1);
  });

  it('discovered publishable workspace packages == the reference set', async () => {
    const discovered = await sourceOfTruth.discoverPublishablePackages(REPO_ROOT);
    const discoveredNames = new Set(discovered.map((p) => p.name));

    const inWorkspaceNotRef = [...discoveredNames].filter((n) => !referenceNames.has(n)).sort();
    const inRefNotWorkspace = [...referenceNames].filter((n) => !discoveredNames.has(n)).sort();

    expect(
      inWorkspaceNotRef,
      'publishable package(s) exist in the workspace but are MISSING from ' +
        'scripts/release-package-order.mjs — add them (and to RELEASING.md):\n' +
        inWorkspaceNotRef.join('\n'),
    ).toEqual([]);
    expect(
      inRefNotWorkspace,
      'package(s) listed in scripts/release-package-order.mjs no longer exist in ' +
        'the workspace (renamed/removed?) — fix the source of truth:\n' +
        inRefNotWorkspace.join('\n'),
    ).toEqual([]);
  });

  // ----- release.yml: every loop is DERIVED, not hand-duplicated -------------

  const releaseYml = read('.github/workflows/release.yml');

  it('release.yml Pack loop is derived from the source (no literal --filter pack lines)', () => {
    // The derived loop invokes the printer.
    expect(
      releaseYml.includes('release-package-order.mjs --print pack'),
      'release.yml Pack step must derive its list via `release-package-order.mjs --print pack`',
    ).toBe(true);
    // No per-package literal pack lines may remain (those are the drift vector).
    const literalPackLines = releaseYml
      .split('\n')
      .filter((l) => /pnpm\s+--filter\s+\S+\s+pack/.test(l) && !l.includes('"$filter"'));
    expect(
      literalPackLines,
      'release.yml still contains hand-listed `pnpm --filter <pkg> pack` lines — ' +
        'these must be derived from the source of truth:\n' + literalPackLines.join('\n'),
    ).toEqual([]);
  });

  it('release.yml Publish loop is derived from the source (no literal publish_if_new <pkg> lines)', () => {
    expect(
      releaseYml.includes('release-package-order.mjs --print names'),
      'release.yml Publish step must derive its order via `release-package-order.mjs --print names`',
    ).toBe(true);
    // A literal call is `publish_if_new core` (a bareword arg). The function
    // DEFINITION (`publish_if_new() {`) and the derived call inside the loop
    // (`publish_if_new "$pkg"`) are allowed; a bareword package arg is not.
    const literalPublishLines = releaseYml
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^publish_if_new\s+[a-z]/.test(l)); // bareword pkg, not `() {` and not `"$pkg"`
    expect(
      literalPublishLines,
      'release.yml still contains hand-listed `publish_if_new <pkg>` calls — ' +
        'these must be driven from the source of truth:\n' + literalPublishLines.join('\n'),
    ).toEqual([]);
  });

  it('release.yml Preflight loop is derived from the source (no hand-listed for-loop package list)', () => {
    // The old preflight used `for pkg in core datastore … checks-rust`. The
    // derived form reads `--print names` and uses a `while read` loop. Assert no
    // `for pkg in` literal list survives. (Plain substring scan — no regex
    // backtracking; the old form always opened with the `for pkg in` keyword.)
    const hasForList = releaseYml.includes('for pkg in');
    expect(
      hasForList,
      'release.yml Preflight still hand-lists packages in a `for pkg in core …` loop — ' +
        'derive it from `release-package-order.mjs --print names` instead',
    ).toBe(false);
    // And the preflight reads the printer (the names print is shared with publish;
    // the test above already asserts its presence — re-assert for locality).
    expect(releaseYml.includes('release-package-order.mjs --print names')).toBe(true);
  });

  // ----- bootstrap-publish.sh: PACKAGES array is derived ---------------------

  it('bootstrap-publish.sh derives PACKAGES from the source (no literal array)', () => {
    const bootstrap = read('scripts/bootstrap-publish.sh');
    // The path may carry a quoted "$REPO_ROOT" prefix before the script name, so
    // accept either the quoted or bare form (plain substring — no regex).
    const derivesFromSource =
      bootstrap.includes('release-package-order.mjs" --print names') ||
      bootstrap.includes('release-package-order.mjs --print names');
    expect(
      derivesFromSource,
      'bootstrap-publish.sh must read its PACKAGES from ' +
        '`release-package-order.mjs --print names`',
    ).toBe(true);
    // The old literal array opened with `PACKAGES=(` then package barewords on
    // following lines. The derived form is `PACKAGES=()` (empty) then a
    // `while read` append loop. A non-empty literal opener is the drift vector.
    const literalArray = bootstrap.includes('PACKAGES=(\n');
    expect(
      literalArray,
      'bootstrap-publish.sh still hand-lists a literal `PACKAGES=( core … )` array — ' +
        'derive it from the source of truth instead',
    ).toBe(false);
  });

  // ----- RELEASING.md: prose table + count + verify loop match the reference -

  const releasingMd = read('RELEASING.md');

  it('RELEASING.md "The 31 packages" table names == the reference set', () => {
    // Table rows look like: `| Layer | `@opensip-tools/<name>` | `packages/…` |`
    // plus the unscoped CLI row: `| CLI | `opensip-tools` (unscoped) | … |`.
    const tableNames = new Set<string>();
    for (const m of releasingMd.matchAll(/\|\s*`(@opensip-tools\/[a-z0-9-]+)`\s*\|/g)) {
      tableNames.add(m[1]);
    }
    // The unscoped CLI row uses `opensip-tools` (no scope) before "(unscoped)".
    if (/\|\s*`opensip-tools`\s*\(unscoped\)/.test(releasingMd)) {
      tableNames.add('opensip-tools');
    }

    const inTableNotRef = [...tableNames].filter((n) => !referenceNames.has(n)).sort();
    const inRefNotTable = [...referenceNames].filter((n) => !tableNames.has(n)).sort();

    expect(
      inTableNotRef,
      'RELEASING.md table lists package(s) not in the source of truth:\n' + inTableNotRef.join('\n'),
    ).toEqual([]);
    expect(
      inRefNotTable,
      'RELEASING.md table is MISSING package(s) from the source of truth — add a row:\n' +
        inRefNotTable.join('\n'),
    ).toEqual([]);
  });

  it('RELEASING.md stated package count == the reference length', () => {
    // The runbook says "all 31 packages" / "The 31 packages" in several spots.
    // Assert the count matches RELEASE_PACKAGE_ORDER.length so a package add/
    // remove forces a prose update too.
    const count = RELEASE_PACKAGE_ORDER.length;
    const headerHasCount = new RegExp(`The ${count} packages`).test(releasingMd);
    expect(
      headerHasCount,
      `RELEASING.md must state "The ${count} packages" (the reference set size); ` +
        'update the prose count after adding/removing a package',
    ).toBe(true);
  });

  it('RELEASING.md npm-verify `for p in …` loop names == the scoped reference set', () => {
    // The verify loop iterates the 30 SCOPED packages (the unscoped CLI is
    // checked on a separate line). Extract the `for p in … ; do` body without a
    // backtracking regex: slice between the `for p in` keyword and the closing
    // `; do`, then split on whitespace.
    const forIdx = releasingMd.indexOf('for p in ');
    const doIdx = forIdx === -1 ? -1 : releasingMd.indexOf('; do', forIdx);
    expect(
      forIdx !== -1 && doIdx !== -1,
      'RELEASING.md must contain the npm-verify `for p in … ; do` loop',
    ).toBe(true);
    const loopBody = releasingMd.slice(forIdx + 'for p in '.length, doIdx);
    const tokens = loopBody
      .replaceAll('\\', ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    const loopNames = new Set(tokens.map((t) => `@opensip-tools/${t}`));

    // Reference minus the unscoped CLI (verified separately in the runbook).
    const scopedRef = new Set([...referenceNames].filter((n) => n !== 'opensip-tools'));

    const inLoopNotRef = [...loopNames].filter((n) => !scopedRef.has(n)).sort();
    const inRefNotLoop = [...scopedRef].filter((n) => !loopNames.has(n)).sort();

    expect(
      inLoopNotRef,
      'RELEASING.md verify loop lists scoped package(s) not in the source of truth:\n' +
        inLoopNotRef.join('\n'),
    ).toEqual([]);
    expect(
      inRefNotLoop,
      'RELEASING.md verify loop is MISSING scoped package(s) from the source of truth:\n' +
        inRefNotLoop.join('\n'),
    ).toEqual([]);
    // And the unscoped CLI must be verified on its own line.
    expect(
      releasingMd.includes('npm view opensip-tools version'),
      'RELEASING.md must verify the unscoped `opensip-tools` on its own line',
    ).toBe(true);
  });
});
