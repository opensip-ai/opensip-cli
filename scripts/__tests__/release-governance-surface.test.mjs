import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  collectBundledToolDocProblems,
  collectGovernanceDriftProblems,
  collectPackageFactDocProblems,
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
    ['@opensip-cli/agent-eval', '@opensip-cli/checks-dogfood', '@opensip-cli/test-support'],
    'the known private workspace packages',
  );
});

test('RELEASING.md version surfaces match the derived governance facts', () => {
  const facts = readGovernanceFacts();
  const releasingMd = read('RELEASING.md');
  assert.match(releasingMd, new RegExp(`## The ${facts.publishableCount} packages`));
  assert.match(releasingMd, new RegExp(`All ${facts.publishableCount} publishable packages`));
  assert.match(
    releasingMd,
    new RegExp(`${facts.versionedPackageJsonCount}\\s+\`package\\.json\` files`),
  );
  // Must name every private workspace package + the private root manifest.
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

test('collectBundledToolDocProblems binds bundled-tool prose to the manifest count', () => {
  // Facts are injected; the expected count/word is DERIVED, never a test literal.
  const facts = { bundledToolPackageNames: ['a', 'b', 'c', 'd', 'e'] }; // 5 → "five"
  const stale = collectBundledToolDocProblems(
    'AGENTS.md',
    'Today it ships with four bundled tools: fit, graph, sim, yagni.',
    facts,
  );
  assert.ok(
    stale.some((p) => /five \(5\) bundled tools/.test(p)),
    'a stale count is an actionable problem',
  );
  assert.ok(
    stale.some((p) => /bundled-tools\.manifest\.json/.test(p)),
    'a missing source-of-truth citation is flagged',
  );
  // A correct, manifest-cited rendering passes with no problems — in the word
  // form OR the digit form (5), so prose voice is not over-constrained.
  for (const prose of [
    'It ships with the five bundled tools declared in bundled-tools.manifest.json.',
    'It ships with the 5 bundled tools declared in bundled-tools.manifest.json.',
  ]) {
    assert.deepEqual(collectBundledToolDocProblems('AGENTS.md', prose, facts), []);
  }
  // A missing doc is a hard problem, not a silent pass.
  assert.ok(collectBundledToolDocProblems('AGENTS.md', '', facts).some((p) => /missing/.test(p)));
});

test('the real AGENTS.md and CLAUDE.md describe the derived bundled-tool set', () => {
  const facts = readGovernanceFacts();
  for (const doc of ['AGENTS.md', 'CLAUDE.md']) {
    assert.deepEqual(
      collectBundledToolDocProblems(doc, read(doc), facts),
      [],
      `${doc} bundled-tool prose drifted from the manifest`,
    );
  }
});

test('collectPackageFactDocProblems catches a stale count and an omitted private package', () => {
  const facts = {
    publishableCount: 56,
    privateWorkspaceNames: ['@opensip-cli/test-support', '@opensip-cli/checks-dogfood'],
  };
  const stale = collectPackageFactDocProblems(
    'docs/public/README.md',
    '55 publishable workspace packages, plus the private `@opensip-cli/test-support` package.',
    facts,
  );
  assert.ok(stale.some((p) => /claims 55 publishable packages; expected 56/.test(p)));
  assert.ok(stale.some((p) => /omits @opensip-cli\/checks-dogfood/.test(p)));
  // Naming both private packages with the derived count passes.
  assert.deepEqual(
    collectPackageFactDocProblems(
      'docs/public/README.md',
      '56 publishable packages, plus `@opensip-cli/test-support` and `@opensip-cli/checks-dogfood`.',
      facts,
    ),
    [],
  );
  // Source-of-truth wording (no literal count, no private names) also passes.
  assert.deepEqual(
    collectPackageFactDocProblems(
      'docs/public/README.md',
      'See scripts/release-package-order.mjs for the authoritative inventory.',
      facts,
    ),
    [],
  );
});

test('the audited public pages match derived package + bundled-tool facts', () => {
  const facts = readGovernanceFacts();
  const readme = read('docs/public/README.md');
  assert.deepEqual(collectBundledToolDocProblems('docs/public/README.md', readme, facts), []);
  assert.deepEqual(collectPackageFactDocProblems('docs/public/README.md', readme, facts), []);
  assert.deepEqual(
    collectPackageFactDocProblems(
      'docs/public/80-implementation/06-doc-conventions.md',
      read('docs/public/80-implementation/06-doc-conventions.md'),
      facts,
    ),
    [],
  );
});

test('readGovernanceFacts fails closed on source disagreement (returns no partial facts)', () => {
  // A projected root whose workspace packages disagree with the real
  // RELEASE_PACKAGE_ORDER must THROW, never return a partially-derived object —
  // a half-true governance projection is worse than a hard failure (ADR-0151).
  const root = mkdtempSync(join(tmpdir(), 'gov-disagreement-'));
  try {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    const pkgDir = join(root, 'packages', 'ghost');
    mkdirSync(pkgDir, { recursive: true });
    // Publishable (not private) but absent from RELEASE_PACKAGE_ORDER.
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@vendor/ghost', version: '0.0.0' }),
    );
    assert.throws(() => readGovernanceFacts(root), /RELEASE_PACKAGE_ORDER/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dependency automation config is singular when present', () => {
  const dependabot = existsSync(join(REPO_ROOT, '.github/dependabot.yml'));
  const renovate = existsSync(join(REPO_ROOT, 'renovate.json'));
  assert.ok(!(dependabot && renovate), 'only one dependency automation config may exist');
});
