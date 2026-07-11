/**
 * Release governance surface drift checks (Plan 02 / ADR-0017).
 *
 * Single-sourced package counts from scripts/release-package-order.mjs; prose
 * in RELEASING.md, release.yml comments, and the package catalog must not
 * carry stale literal counts.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Private package.json files that share the product version during bump. */
export const PRIVATE_VERSIONED_PACKAGE_JSON_COUNT = 2;

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
  const publishableCount = RELEASE_PACKAGE_ORDER.length;
  const scopedPublishableCount = RELEASE_PACKAGE_ORDER.filter((p) =>
    p.name.startsWith('@opensip-cli/'),
  ).length;
  const versionedPackageJsonCount = publishableCount + PRIVATE_VERSIONED_PACKAGE_JSON_COUNT;

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
      `RELEASING.md must state ${versionedPackageJsonCount} package.json files for version bumps (${publishableCount} publishable + ${PRIVATE_VERSIONED_PACKAGE_JSON_COUNT} private).`,
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
  if (segments.some((seg) => seg === '..')) return 'path-traversal';
  const base = segments[segments.length - 1];
  if (segments.some((seg) => seg === '__tests__')) return 'test-directory';
  if (segments.some((seg) => seg === '__fixtures__')) return 'fixture-directory';
  if (segments.some((seg) => seg === 'coverage')) return 'coverage';
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
