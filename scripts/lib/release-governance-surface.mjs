/**
 * Release governance surface drift checks (Plan 02 / ADR-0017).
 *
 * Single-sourced package counts from scripts/release-package-order.mjs; prose
 * in RELEASING.md, release.yml comments, and the package catalog must not
 * carry stale literal counts.
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('./workspace-package-manifests.cjs');
const { readProductionToolPackageInventory } = require('./workspace-tool-package-inventory.cjs');

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The private, version-bumped root manifest (`@opensip-cli/root`), which is NOT
 * a workspace package. */
const PRIVATE_ROOT_NAME = '@opensip-cli/root';
const BUNDLED_MANIFEST = 'packages/cli/src/bootstrap/bundled-tools.manifest.json';

function byCodePoint(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * One immutable projection over the canonical package/Tool authorities:
 * `readWorkspacePackageManifests`, `RELEASE_PACKAGE_ORDER`,
 * `readProductionToolPackageInventory`, and `bundled-tools.manifest.json`.
 * Generators and drift checks consume this instead of recomputing or freezing
 * literal counts. Fails closed on any disagreement between the sources (ADR-0151).
 *
 * @param {string} [repoRoot]
 */
export function readGovernanceFacts(repoRoot = REPO_ROOT) {
  const records = readWorkspacePackageManifests(repoRoot);
  const workspaceNames = records.map((r) => r.name).sort(byCodePoint);
  const privateNames = records
    .filter((r) => r.private)
    .map((r) => r.name)
    .sort(byCodePoint);
  const publishableNames = records
    .filter((r) => !r.private)
    .map((r) => r.name)
    .sort(byCodePoint);
  const releaseOrderNames = RELEASE_PACKAGE_ORDER.map((p) => p.name);

  // RELEASE_PACKAGE_ORDER must equal the publishable workspace set.
  const publishableSet = new Set(publishableNames);
  const orderSet = new Set(releaseOrderNames);
  if (orderSet.size !== releaseOrderNames.length) {
    throw new Error('RELEASE_PACKAGE_ORDER contains a duplicate package');
  }
  for (const name of releaseOrderNames) {
    if (!publishableSet.has(name)) {
      throw new Error(
        `RELEASE_PACKAGE_ORDER includes ${name}, not a publishable workspace package`,
      );
    }
  }
  for (const name of publishableNames) {
    if (!orderSet.has(name)) {
      throw new Error(
        `publishable workspace package ${name} is missing from RELEASE_PACKAGE_ORDER`,
      );
    }
  }
  for (const name of privateNames) {
    if (orderSet.has(name)) {
      throw new Error(`private workspace package ${name} must not appear in RELEASE_PACKAGE_ORDER`);
    }
  }
  if (workspaceNames.includes(PRIVATE_ROOT_NAME)) {
    throw new Error(
      `${PRIVATE_ROOT_NAME} is the private root manifest and must not be a workspace package`,
    );
  }

  // Bundled Tool facts cross-checked against the production Tool inventory.
  const bundledRaw = readRepoFile(BUNDLED_MANIFEST);
  const bundled = bundledRaw ? JSON.parse(bundledRaw) : {};
  const bundledToolPackageNames = Array.isArray(bundled.bundledPackages)
    ? [...bundled.bundledPackages]
    : [];
  const toolInventory = readProductionToolPackageInventory(repoRoot);
  const toolByName = new Map(toolInventory.map((t) => [t.name, t]));
  for (const name of bundledToolPackageNames) {
    const rec = toolByName.get(name);
    if (!rec) {
      throw new Error(`bundled manifest names ${name}, absent from the production Tool inventory`);
    }
    if (rec.bundled !== true) {
      throw new Error(
        `bundled manifest names ${name}, but the Tool inventory does not classify it bundled`,
      );
    }
  }

  // Versioned package.json files = every publishable + every private workspace
  // package (all share the product version) + the private root manifest.
  const versionedPackageJsonCount = publishableNames.length + privateNames.length + 1;

  return Object.freeze({
    workspacePackageNames: Object.freeze(workspaceNames),
    workspacePackageCount: records.length,
    publishableNames: Object.freeze(publishableNames),
    publishableCount: publishableNames.length,
    releaseOrderNames: Object.freeze([...releaseOrderNames]),
    privateWorkspaceNames: Object.freeze(privateNames),
    privateWorkspaceCount: privateNames.length,
    scopedPublishableCount: publishableNames.filter((n) => n.startsWith('@opensip-cli/')).length,
    privateRootName: PRIVATE_ROOT_NAME,
    versionedPackageJsonCount,
    bundledToolPackageNames: Object.freeze(bundledToolPackageNames),
    productionToolPackageNames: Object.freeze(toolInventory.map((t) => t.name).sort(byCodePoint)),
  });
}

const STALE_COUNT_PATTERNS = [
  /\ball\s+33\b/i,
  /\ball\s+34\b/i,
  /\bthe\s+33\s+packages\b/i,
  /\bthe\s+34\s+packages\b/i,
  /\bpack\s+all\s+33\b/i,
  /\bpack\s+all\s+34\b/i,
  /\b34\s+publishable\s+packages\b/i,
  /\b33\s+publishable\s+packages\b/i,
];

function readRepoFile(relPath) {
  const abs = join(REPO_ROOT, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

/**
 * @returns {string[]} actionable drift problems (empty when clean)
 */
export function collectGovernanceDriftProblems() {
  const problems = [];
  const facts = readGovernanceFacts();
  const publishableCount = facts.publishableCount;
  const scopedPublishableCount = facts.scopedPublishableCount;
  const versionedPackageJsonCount = facts.versionedPackageJsonCount;

  const releasingMd = readRepoFile('RELEASING.md');
  const releaseYml = readRepoFile('.github/workflows/release.yml');
  const packageCatalog = readRepoFile('docs/public/70-reference/02-package-catalog.md');

  for (const pattern of STALE_COUNT_PATTERNS) {
    if (pattern.test(releasingMd)) {
      problems.push(
        `RELEASING.md contains stale package count (${pattern}). Update to ${publishableCount} publishable packages.`,
      );
    }
    if (pattern.test(releaseYml)) {
      problems.push(
        `.github/workflows/release.yml contains stale package count (${pattern}). Remove the literal count; derive from release-package-order.mjs.`,
      );
    }
    if (pattern.test(packageCatalog)) {
      problems.push(
        `docs/public/70-reference/02-package-catalog.md contains stale package count (${pattern}). Use ${publishableCount} or source-of-truth wording.`,
      );
    }
  }

  const headerPattern = new RegExp(`## The ${publishableCount} packages`);
  if (!headerPattern.test(releasingMd)) {
    problems.push(
      `RELEASING.md must contain "## The ${publishableCount} packages" (RELEASE_PACKAGE_ORDER.length).`,
    );
  }

  const publishableProse = new RegExp(`All ${publishableCount} publishable packages`);
  if (!publishableProse.test(releasingMd)) {
    problems.push(
      `RELEASING.md version-surfaces prose must say "All ${publishableCount} publishable packages".`,
    );
  }

  const readmeSurfaceProse = new RegExp(
    `Per-package\\s+\`README\\.md\`\\s+\\(×${scopedPublishableCount}\\s+scoped\\)`,
  );
  if (!readmeSurfaceProse.test(releasingMd)) {
    problems.push(
      `RELEASING.md derived-surfaces table must say "Per-package \`README.md\` (×${scopedPublishableCount} scoped)".`,
    );
  }

  const versionedProse = new RegExp(`${versionedPackageJsonCount}\\s+\`package\\.json\` files`);
  if (!versionedProse.test(releasingMd)) {
    problems.push(
      `RELEASING.md must state ${versionedPackageJsonCount} package.json files for version bumps (${publishableCount} publishable + ${facts.privateWorkspaceCount} private workspace + the private root).`,
    );
  }

  if (/\bpack\s+all\s+\d+\s+up\s+front\b/i.test(releaseYml)) {
    problems.push(
      '.github/workflows/release.yml pack-step comment must not contain a stale literal package count (e.g. "pack all 33 up front").',
    );
  }

  if (/\b\d+\s+publishable\s+packages\b/i.test(packageCatalog)) {
    const match = packageCatalog.match(/\b(\d+)\s+publishable\s+packages\b/i);
    if (match && Number.parseInt(match[1], 10) !== publishableCount) {
      problems.push(
        `docs/public/70-reference/02-package-catalog.md verification trail claims ${match[1]} publishable packages; expected ${publishableCount}.`,
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------
// Published-artifact classification (ADR-0150).
//
// Production package builds must ship runtime artifacts only. These pure
// helpers classify package-relative paths (from a real `dist/` tree OR from a
// `pnpm pack --dry-run --json` packlist) and flag anything that must not be
// published. No filesystem access — the verifier script does the I/O.
// ---------------------------------------------------------------------

/** Max normalized package-relative path length (defense against pathological input). */
export const MAX_PUBLISHED_ARTIFACT_PATH_BYTES = 4096;

/**
 * Classify a package-relative published-artifact path (POSIX or Windows
 * separators). Returns a stable reason string when the path must NOT ship in a
 * production tarball, or `null` when it is an allowed runtime artifact.
 *
 * A filename merely CONTAINING "test"/"spec" (e.g. `contest.js`, `latest.js`)
 * is allowed — only the `.test.`/`.spec.` infix and the test/fixture/coverage
 * trees are rejected.
 *
 * @param {string} relPath
 * @returns {string | null}
 */
export function classifyPublishedArtifactPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return 'empty-path';
  if (relPath.length > MAX_PUBLISHED_ARTIFACT_PATH_BYTES) return 'oversized-path';
  if (relPath.includes('\0')) return 'nul-in-path';
  const p = relPath.replaceAll('\\', '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return 'absolute-path';
  const segments = p.split('/');
  if (segments.includes('..')) return 'path-traversal';
  const base = segments.at(-1);
  if (segments.includes('__tests__')) return 'test-directory';
  if (segments.includes('__fixtures__')) return 'fixture-directory';
  if (segments.includes('coverage')) return 'coverage';
  if (/\.(test|spec)\./.test(base)) return 'test-file';
  return null;
}

/**
 * Collect forbidden-published-artifact problems for one package's file list.
 *
 * @param {string} pkgName
 * @param {readonly string[]} files package-relative paths
 * @param {string} source `dist` or `packlist` (for the diagnostic)
 * @returns {string[]}
 */
export function collectPublishedArtifactProblems(pkgName, files, source = 'dist') {
  const problems = [];
  for (const file of files) {
    const reason = classifyPublishedArtifactPath(file);
    if (reason !== null) {
      problems.push(`${pkgName}: forbidden ${source} artifact (${reason}): ${file}`);
    }
  }
  return problems;
}
