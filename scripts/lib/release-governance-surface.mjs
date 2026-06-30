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
