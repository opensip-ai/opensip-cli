import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  PRIVATE_VERSIONED_PACKAGE_JSON_COUNT,
  collectGovernanceDriftProblems,
} from '../lib/release-governance-surface.mjs';
import { RELEASE_PACKAGE_ORDER } from '../release-package-order.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function read(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

test('release governance surface has no stale package-count drift', () => {
  const problems = collectGovernanceDriftProblems();
  assert.deepEqual(problems, [], problems.length > 0 ? problems.join('\n') : undefined);
});

test('publishable count matches RELEASE_PACKAGE_ORDER', () => {
  const publishableCount = RELEASE_PACKAGE_ORDER.length;
  const scopedCount = RELEASE_PACKAGE_ORDER.filter((p) =>
    p.name.startsWith('@opensip-cli/'),
  ).length;
  assert.equal(publishableCount, 42);
  assert.equal(scopedCount, 41);
  assert.equal(RELEASE_PACKAGE_ORDER.at(-1)?.name, 'opensip-cli');
});

test('RELEASING.md version surfaces distinguish publishable vs private package.json files', () => {
  const releasingMd = read('RELEASING.md');
  const publishableCount = RELEASE_PACKAGE_ORDER.length;
  const versionedCount = publishableCount + PRIVATE_VERSIONED_PACKAGE_JSON_COUNT;
  assert.match(releasingMd, new RegExp(`## The ${publishableCount} packages`));
  assert.match(releasingMd, new RegExp(`All ${publishableCount} publishable packages`));
  assert.match(releasingMd, new RegExp(`${versionedCount}\\s+\`package\\.json\` files`));
});

test('release.yml pack comment avoids stale literal package counts', () => {
  const releaseYml = read('.github/workflows/release.yml');
  assert.doesNotMatch(releaseYml, /\bpack\s+all\s+\d+\s+up\s+front\b/i);
  assert.match(
    releaseYml,
    /release-package-order\.mjs --print pack/,
    'pack loop must derive from release-package-order.mjs',
  );
});

test('package catalog verification trail matches publishable count or source-of-truth wording', () => {
  const catalog = read('docs/public/70-reference/02-package-catalog.md');
  const publishableCount = RELEASE_PACKAGE_ORDER.length;
  const hasSourceOfTruth =
    /release-package-order\.mjs/.test(catalog) ||
    new RegExp(`\\b${publishableCount}\\s+publishable\\s+packages\\b`).test(catalog);
  assert.ok(hasSourceOfTruth, 'package catalog must cite source of truth or correct count');
});

test('dependency automation config is singular when present', () => {
  const dependabot = existsSync(join(REPO_ROOT, '.github/dependabot.yml'));
  const renovate = existsSync(join(REPO_ROOT, 'renovate.json'));
  assert.ok(!(dependabot && renovate), 'only one dependency automation config may exist');
});
