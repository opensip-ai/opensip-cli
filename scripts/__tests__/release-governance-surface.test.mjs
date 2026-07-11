import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  collectGovernanceDriftProblems,
  readGovernanceFacts,
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

test('release order equals the derived publishable workspace set (no frozen counts)', () => {
  const facts = readGovernanceFacts();
  // Relationships between the sources, not a frozen number.
  assert.equal(RELEASE_PACKAGE_ORDER.length, facts.publishableCount);
  assert.deepEqual(
    RELEASE_PACKAGE_ORDER.map((p) => p.name).sort(),
    [...facts.publishableNames].sort(),
  );
  // Structural identities that hold regardless of package count.
  assert.equal(RELEASE_PACKAGE_ORDER.at(-1)?.name, 'opensip-cli', 'CLI publishes last');
  assert.equal(
    facts.scopedPublishableCount,
    facts.publishableCount - 1,
    'exactly one unscoped publishable package (opensip-cli)',
  );
  assert.deepEqual(
    [...facts.privateWorkspaceNames],
    ['@opensip-cli/checks-dogfood', '@opensip-cli/test-support'],
    'the two known private workspace packages',
  );
});

test('RELEASING.md version surfaces match the derived governance facts', () => {
  const facts = readGovernanceFacts();
  const releasingMd = read('RELEASING.md');
  assert.match(releasingMd, new RegExp(`## The ${facts.publishableCount} packages`));
  assert.match(releasingMd, new RegExp(`All ${facts.publishableCount} publishable packages`));
  assert.match(releasingMd, new RegExp(`${facts.versionedPackageJsonCount}\\s+\`package\\.json\` files`));
  // Must name both private workspace packages + the private root manifest.
  for (const name of [...facts.privateWorkspaceNames, facts.privateRootName]) {
    assert.match(
      releasingMd,
      new RegExp(name.replaceAll(/[/@\-.]/g, String.raw`\$&`)),
      `RELEASING.md must name ${name}`,
    );
  }
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
