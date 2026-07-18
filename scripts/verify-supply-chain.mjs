#!/usr/bin/env node
//
// OpenSIP-specific package supply-chain release gate.
//
// This complements the general `package-supply-chain-policy` fitness check
// with repo-owned assertions that must hold before publishing immutable npm
// versions:
//   1. Publishable packages do not declare install-time lifecycle scripts.
//   2. The root package manager is pinned with Corepack integrity.
//   3. pnpm supply-chain settings stay explicit and fail-closed.
//   4. GitHub workflows use frozen installs.
//   5. npm publish uses OIDC/provenance and not long-lived publish tokens.
//   6. Dependency update automation stays bounded.
//   7. The release workflow emits checksums/SBOM and pinned artifact attestations.
//   8. The scheduled macOS qualification lane is pinned + least-privilege.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RELEASE_PACKAGE_ORDER, discoverPublishablePackages } from './release-package-order.mjs';
import {
  extractPublishBlocks,
  publishBlockHasProvenance,
  publishBlockReferencesLongLivedToken,
} from './lib/trusted-publish-blocks.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INSTALL_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall']);

const passes = [];
const failures = [];

const pass = (id, msg) => passes.push({ id, msg });
const fail = (id, msg) => failures.push({ id, msg });

function readText(relPath) {
  const abs = join(REPO_ROOT, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
}

function getConfigValue(content, key) {
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const match = new RegExp(String.raw`^\s*${escaped}\s*[:=]\s*([^#\n]+)`, 'm').exec(content);
  return match?.[1]?.trim().replaceAll(/^['"]|['"]$/g, '') ?? null;
}

function hasScalarValue(content, key, expected) {
  return getConfigValue(content, key)?.toLowerCase() === expected.toLowerCase();
}

function positiveNumber(content, key) {
  const value = getConfigValue(content, key);
  const parsed = value ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readJson(relPath) {
  return JSON.parse(await fs.readFile(join(REPO_ROOT, relPath), 'utf8'));
}

async function checkNoPublishedInstallHooks() {
  const publishable = await discoverPublishablePackages(REPO_ROOT);
  const offenders = [];
  for (const pkg of publishable) {
    const pkgJson = await readJson(join(pkg.dir, 'package.json'));
    const scripts = pkgJson.scripts ?? {};
    for (const scriptName of Object.keys(scripts)) {
      if (INSTALL_LIFECYCLE_SCRIPTS.has(scriptName)) {
        offenders.push(`${pkg.name} (${pkg.dir}/package.json) declares scripts.${scriptName}`);
      }
    }
  }
  if (offenders.length === 0) {
    pass(
      1,
      `publishable packages (${publishable.length}) declare no install-time lifecycle scripts.`,
    );
  } else {
    fail(
      1,
      `install-time lifecycle scripts found in publishable packages:\n    ${offenders.join('\n    ')}`,
    );
  }
}

async function checkPackageManagerPin() {
  const rootPkg = await readJson('package.json');
  const pin = rootPkg.packageManager ?? '';
  if (/^pnpm@\d+\.\d+\.\d+\+sha512\./.test(pin)) {
    pass(2, `root packageManager is integrity-pinned (${pin.split('+')[0]}).`);
  } else {
    fail(
      2,
      `root packageManager must be an exact pnpm pin with +sha512 integrity; got "${pin || '<missing>'}".`,
    );
  }
}

function checkPnpmPolicy() {
  const workspace = readText('pnpm-workspace.yaml');
  const problems = [];
  if (!/^allowBuilds:/m.test(workspace)) problems.push('allowBuilds map is missing');
  if (positiveNumber(workspace, 'minimumReleaseAge') <= 0)
    problems.push('minimumReleaseAge must be positive');
  if (!hasScalarValue(workspace, 'minimumReleaseAgeStrict', 'true'))
    problems.push('minimumReleaseAgeStrict must be true');
  if (!hasScalarValue(workspace, 'minimumReleaseAgeIgnoreMissingTime', 'false'))
    problems.push('minimumReleaseAgeIgnoreMissingTime must be false');
  if (!hasScalarValue(workspace, 'trustPolicy', 'no-downgrade'))
    problems.push('trustPolicy must be no-downgrade');
  if (!hasScalarValue(workspace, 'trustLockfile', 'false'))
    problems.push('trustLockfile must be false');
  if (!hasScalarValue(workspace, 'blockExoticSubdeps', 'true'))
    problems.push('blockExoticSubdeps must be true');
  if (hasScalarValue(workspace, 'dangerouslyAllowAllBuilds', 'true'))
    problems.push('dangerouslyAllowAllBuilds must not be true');

  if (problems.length === 0) {
    pass(3, 'pnpm supply-chain policy is explicit and fail-closed.');
  } else {
    fail(3, `pnpm-workspace.yaml supply-chain policy problems:\n    ${problems.join('\n    ')}`);
  }
}

function readWorkflowFiles() {
  const dir = join(REPO_ROOT, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => {
      const filePath = join(dir, entry.name);
      return {
        filePath,
        relPath: relative(REPO_ROOT, filePath),
        content: readFileSync(filePath, 'utf8'),
      };
    });
}

function isFrozenInstall(line) {
  return (
    /\bnpm\s+ci\b/.test(line) ||
    /\bpnpm\s+(?:install|i)\b.*--frozen-lockfile/.test(line) ||
    /\bpnpm\s+ci\b/.test(line) ||
    /\bbun\s+install\b.*--frozen-lockfile/.test(line) ||
    /\bbun\s+ci\b/.test(line)
  );
}

function isPackageManagerBootstrap(line) {
  return (
    /\bnpm\s+install\b.*\s--prefix\b.*\bnpm@\d+/.test(line) ||
    /\bnpm\s+install\s+--prefix\b.*\bnpm@\d+/.test(line)
  );
}

function isMutableInstall(line) {
  if (isPackageManagerBootstrap(line)) return false;
  return (
    /\bnpm\s+install\b/.test(line) ||
    (/\bpnpm\s+(?:install|i)\b/.test(line) && !line.includes('--frozen-lockfile')) ||
    (/\bbun\s+install\b/.test(line) && !line.includes('--frozen-lockfile'))
  );
}

function checkFrozenInstalls(workflows) {
  const mutable = [];
  let frozenCount = 0;
  for (const workflow of workflows) {
    for (const [index, rawLine] of workflow.content.split('\n').entries()) {
      const line = rawLine.trim();
      if (line.startsWith('#')) continue;
      if (isFrozenInstall(line)) frozenCount += 1;
      if (isMutableInstall(line)) mutable.push(`${workflow.relPath}:${index + 1}: ${line}`);
    }
  }

  if (mutable.length === 0 && frozenCount > 0) {
    pass(4, `GitHub workflows use frozen package installs (${frozenCount} found).`);
  } else {
    const details = [];
    if (frozenCount === 0) details.push('no frozen install command found');
    details.push(...mutable);
    fail(4, `workflow install policy problems:\n    ${details.join('\n    ')}`);
  }
}

function checkTrustedPublish(workflows) {
  const problems = [];
  for (const workflow of workflows) {
    if (!/\bnpm\s+publish\b/.test(workflow.content)) continue;
    if (!/id-token:\s*write/.test(workflow.content)) {
      problems.push(`${workflow.relPath}: npm publish without permissions.id-token: write`);
    }
    const publishBlocks = extractPublishBlocks(workflow.content);
    for (const block of publishBlocks) {
      if (!publishBlockHasProvenance(block)) {
        problems.push(`${workflow.relPath}: npm publish step lacks provenance`);
      }
      if (publishBlockReferencesLongLivedToken(block)) {
        problems.push(`${workflow.relPath}: npm publish step references long-lived npm token`);
      }
    }
  }

  if (problems.length === 0) {
    pass(5, 'npm publish workflows use OIDC/provenance and no long-lived publish token.');
  } else {
    fail(5, `trusted publishing problems:\n    ${problems.join('\n    ')}`);
  }
}

function checkDependencyAutomation() {
  const dependabot = readText('.github/dependabot.yml');
  const renovate = readText('renovate.json');
  if (!dependabot && !renovate) {
    pass(6, 'dependency update automation deferred (no config file).');
    return;
  }
  if (dependabot && renovate) {
    fail(6, 'both .github/dependabot.yml and renovate.json exist — choose one automation tool.');
    return;
  }

  const content = dependabot || renovate;
  const problems = [];
  if (/automerge:\s*true/i.test(content) && /update-types:[\s\S]*major/i.test(content)) {
    problems.push('automation config enables automerge for major updates');
  }
  if (/automergeType:\s*["']?all["']?/i.test(content)) {
    problems.push('automation config enables unsafe automergeType: all');
  }
  if (
    /ignore:\s*\[\s*\*/.test(content) ||
    /enabled:\s*false[\s\S]*package-ecosystem:\s*npm/i.test(content)
  ) {
    problems.push('automation config disables npm dependency updates');
  }

  if (problems.length === 0) {
    pass(6, 'dependency automation config is bounded (no unsafe automerge).');
  } else {
    fail(6, `dependency automation policy problems:\n    ${problems.join('\n    ')}`);
  }
}

/** Drop whole-line YAML comments so prose can't satisfy/violate a policy regex. */
function stripComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/**
 * Slice a workflow into a `Map<jobId, segment>` by its top-level (2-space
 * indented) job headers. String/regex based — no YAML dependency — so it runs on
 * a bare checkout. Comment lines never match (`#` is not an identifier char).
 */
function sliceJobs(content) {
  const headerRe = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/gm;
  const headers = [];
  for (let match = headerRe.exec(content); match !== null; match = headerRe.exec(content)) {
    headers.push({ name: match[1], start: match.index });
  }
  const jobs = new Map();
  for (const [i, header] of headers.entries()) {
    const end = i + 1 < headers.length ? headers[i + 1].start : content.length;
    jobs.set(header.name, content.slice(header.start, end));
  }
  return jobs;
}

/** Ordered-step markers must appear in this order inside one job segment. */
function collectOrderProblems(segment, jobName, orderedSteps) {
  const problems = [];
  let previousIndex = -1;
  let previousMarker = '';
  for (const marker of orderedSteps) {
    const index = segment.indexOf(marker);
    if (index === -1) {
      problems.push(`${marker} is missing from ${jobName}`);
    } else if (index < previousIndex) {
      problems.push(`${marker} must run after ${previousMarker} in ${jobName}`);
    } else {
      previousIndex = index;
      previousMarker = marker;
    }
  }
  return problems;
}

/**
 * Assert the four-job release topology (Plan 02 Phase 3): unprivileged
 * `build-release` owns repository code, gates, pack, and smoke; minimal
 * `stage-release` consumes one immutable bundle and alone owns publish OIDC +
 * attestation permissions; the pinned `qualify-macos` gate holds only
 * `contents: read`; `promote-release` alone owns release write + promotion.
 */
function checkReleaseArtifactAttestations(workflows) {
  const workflow = workflows.find((entry) => entry.relPath === '.github/workflows/release.yml');
  if (workflow === undefined) {
    fail(7, '.github/workflows/release.yml is missing.');
    return;
  }

  const problems = [];
  const content = stripComments(workflow.content);
  const jobs = sliceJobs(workflow.content);
  const build = jobs.has('build-release') ? stripComments(jobs.get('build-release')) : undefined;
  const stage = jobs.has('stage-release') ? stripComments(jobs.get('stage-release')) : undefined;
  const macos = jobs.has('qualify-macos') ? stripComments(jobs.get('qualify-macos')) : undefined;
  const promote = jobs.has('promote-release')
    ? stripComments(jobs.get('promote-release'))
    : undefined;

  if (build === undefined) problems.push('build-release job is missing');
  if (stage === undefined) problems.push('stage-release job is missing');
  if (macos === undefined) problems.push('qualify-macos job is missing');
  if (promote === undefined) problems.push('promote-release job is missing');

  // The release-metadata artifact names must be wired into the workflow.
  for (const required of [
    'opensip-cli-release-manifest.v1.json',
    'SHA256SUMS',
    'opensip-cli-sbom.cyclonedx.json',
  ]) {
    if (!content.includes(required)) {
      problems.push(`${required} is not wired into the release workflow`);
    }
  }

  // build-release: every checkout-controlled action happens without publish or
  // attestation authority, then one attempt-bound immutable bundle is uploaded.
  if (build !== undefined) {
    problems.push(
      ...collectOrderProblems(build, 'build-release', [
        'scripts/build-release-artifacts.mjs',
        'scripts/verify-release-artifacts.mjs',
        'scripts/smoke-pack.mjs',
        'Upload immutable staging bundle',
      ]),
    );
    for (const permission of [
      'id-token: write',
      'attestations: write',
      'artifact-metadata: write',
    ]) {
      if (build.includes(permission)) problems.push(`build-release must NOT hold ${permission}`);
    }
    if (/\bnpm\s+publish\b/u.test(build)) problems.push('build-release must NOT publish to npm');
    if (!/release-staging-bundle-v\$\{VERSION\}-run\$\{RUN_ATTEMPT\}/u.test(build)) {
      problems.push('build-release staging bundle identity must include version + run attempt');
    }
    if (!/uses:\s*actions\/upload-artifact@[a-f0-9]{40}\b/u.test(build)) {
      problems.push('build-release must upload the staging bundle through a pinned action SHA');
    }
  }

  // stage-release: no checkout/repository execution/dependency install. It
  // strictly validates the bundle, attests it, and publishes with scripts off.
  if (stage !== undefined) {
    problems.push(
      ...collectOrderProblems(stage, 'stage-release', [
        'Download immutable attempt-bound staging bundle',
        'Strictly validate bundle identity, checksums, and package metadata',
        'Attest release artifact provenance',
        'Publish via npm',
      ]),
    );
    if (!/needs:\s*build-release\b/u.test(stage))
      problems.push('stage-release must depend on build-release');
    if (!/attestations:\s*write/u.test(stage))
      problems.push('stage-release permissions.attestations: write is missing');
    if (!/artifact-metadata:\s*write/u.test(stage))
      problems.push('stage-release permissions.artifact-metadata: write is missing');
    if (!/id-token:\s*write/u.test(stage))
      problems.push('stage-release permissions.id-token: write is missing (OIDC publish)');
    if (!/uses:\s*actions\/attest@[a-f0-9]{40}\b/u.test(stage))
      problems.push('actions/attest must be pinned to a full commit SHA in stage-release');
    if (!/subject-checksums:\s*\$\{\{ runner\.temp \}\}\/release-bundle\/SHA256SUMS/u.test(stage))
      problems.push('artifact attestation must use the generated SHA256SUMS subject list');
    if (!/subject-path:\s*\$\{\{ runner\.temp \}\}\/release-bundle\/SHA256SUMS/u.test(stage))
      problems.push('SHA256SUMS must have its own artifact attestation');
    if (
      !/sbom-path:\s*\$\{\{ runner\.temp \}\}\/release-bundle\/opensip-cli-sbom\.cyclonedx\.json/u.test(
        stage,
      )
    )
      problems.push('SBOM attestation must use opensip-cli-sbom.cyclonedx.json');
    if (/actions\/checkout@|\bpnpm\b|\bnpm\s+(?:install|ci)\b|node\s+scripts\//u.test(stage)) {
      problems.push(
        'stage-release must not checkout, install dependencies, run pnpm, or execute repo scripts',
      );
    }
    if (!/node-version:\s*'24\.16\.0'/u.test(stage))
      problems.push('stage-release must provision the reviewed exact Node runtime');
    if (!/process\.argv\[1\]!=="11\.13\.0"/u.test(stage))
      problems.push('stage-release must verify the exact bundled npm runtime');
    if (
      !/needs\.build-release\.outputs\.manifest-digest/u.test(stage) ||
      !/manifest digest mismatch/u.test(stage)
    ) {
      problems.push('stage-release must fail closed against the independent manifest digest');
    }
    const releaseOrderDigest = createHash('sha256')
      .update(`${RELEASE_PACKAGE_ORDER.map((entry) => entry.name).join('\n')}\n`)
      .digest('hex');
    if (!stage.includes(`expectedPackageOrderDigest = '${releaseOrderDigest}'`)) {
      problems.push('stage-release must bind the exact canonical full package-name order');
    }
    if (!/tag !== ambientTag \|\| gitSha !== ambientGitSha/u.test(stage)) {
      problems.push('stage-release must bind builder identity to GITHUB_REF_NAME/GITHUB_SHA');
    }
    if (
      !/stagingTag !== `release-candidate-\$\{version\}` \|\| stagingTag === 'latest'/u.test(
        stage,
      ) ||
      !/STAGING_TAG:\s*\$\{\{\s*steps\.identity\.outputs\.staging-tag\s*\}\}/u.test(stage)
    ) {
      problems.push(
        'stage-release must validate and publish only to the version-scoped staging tag',
      );
    }
    if (
      !/forbiddenLifecycleScripts = \['preinstall', 'install', 'postinstall'\]/u.test(stage) ||
      !/hasOwnProperty\.call\(packageJson\.scripts, scriptName\)/u.test(stage)
    ) {
      problems.push('stage-release must reject install lifecycle keys inside every tarball');
    }
    const releaseComponentSetDigest = createHash('sha256')
      .update(
        `${RELEASE_PACKAGE_ORDER.map((entry) => entry.name)
          .sort()
          .join('\n')}\n`,
      )
      .digest('hex');
    if (
      !stage.includes(`expectedReleaseComponentSetDigest = '${releaseComponentSetDigest}'`) ||
      !/SBOM schema\/spec version mismatch/u.test(stage) ||
      !/SBOM release metadata identity mismatch/u.test(stage) ||
      !/SBOM OpenSIP component set does not match the reviewed canonical release set/u.test(stage)
    ) {
      problems.push(
        'stage-release must bind SBOM schema, release identity, and canonical components',
      );
    }
    if (
      !/npm publish[\s\S]*--ignore-scripts[\s\S]*--registry https:\/\/registry\.npmjs\.org\//u.test(
        stage,
      )
    ) {
      problems.push('stage-release npm publish must disable scripts and pin the public registry');
    }
    if (/secrets\.MACBOOKM5/u.test(stage))
      problems.push('stage-release must NOT reference the promotion secret MACBOOKM5');
    if (/npm\s+dist-tag\s+add/u.test(stage))
      problems.push(
        'stage-release must NOT promote to latest (npm dist-tag add belongs in promote-release)',
      );
  }

  // qualify-macos: least-privilege pinned gate, no publish/promotion credential.
  if (macos !== undefined) {
    if (!/runs-on:\s*macos-26\b/u.test(macos))
      problems.push('qualify-macos must run on the pinned macos-26 runner');
    if (!/contents:\s*read/u.test(macos))
      problems.push('qualify-macos must use least-privilege contents: read');
    if (/\bnpm\s+publish\b/u.test(macos)) problems.push('qualify-macos must NOT publish to npm');
    if (/secrets\.MACBOOKM5/u.test(macos))
      problems.push('qualify-macos must NOT hold the promotion secret MACBOOKM5');
    if (/id-token:\s*write/u.test(macos))
      problems.push('qualify-macos must NOT hold publish OIDC (id-token: write)');
    if (!/needs:\s*stage-release\b/u.test(macos))
      problems.push('qualify-macos must depend on stage-release');
  }

  // promote-release: the ONLY job with the promotion secret + release write.
  if (promote !== undefined) {
    if (
      !/needs:\s*\[[^\]]*\bstage-release\b[^\]]*\]/u.test(promote) ||
      !/needs:\s*\[[^\]]*\bqualify-macos\b[^\]]*\]/u.test(promote)
    ) {
      problems.push('promote-release must declare needs: [stage-release, qualify-macos]');
    }
    if (!/contents:\s*write/u.test(promote))
      problems.push('promote-release needs contents: write for the GitHub Release');
    if (!/secrets\.MACBOOKM5/u.test(promote))
      problems.push('promote-release must hold the promotion secret MACBOOKM5');
    if (/id-token:\s*write/u.test(promote))
      problems.push('promote-release must NOT hold publish OIDC (id-token: write)');
    if (/attestations:\s*write/u.test(promote))
      problems.push('promote-release must NOT hold attestation permission');
    if (!/npm\s+dist-tag\s+add/u.test(promote))
      problems.push('promote-release must promote to latest via npm dist-tag add');
    if (!/softprops\/action-gh-release@[a-f0-9]{40}\b/u.test(promote))
      problems.push(
        'promote-release must create the GitHub Release via a pinned action-gh-release SHA',
      );
    if (!/ref:\s*\$\{\{\s*needs\.stage-release\.outputs\.git-sha\s*\}\}/u.test(promote))
      problems.push('promote-release must checkout the exact staged SHA');
    if (!/persist-credentials:\s*false/u.test(promote))
      problems.push('promote-release checkout must not persist the contents-write credential');
    if (!/origin URL contains embedded credentials/u.test(promote))
      problems.push('promote-release must reject a credential-bearing origin URL');
    if (
      !/git rev-list -n 1 "\$TAG"/u.test(promote) ||
      !/git status --porcelain=v1/u.test(promote)
    ) {
      problems.push('promote-release must validate tag→SHA and a clean tree before repo code');
    }
    if (/pnpm\/action-setup@|\bpnpm\b|\bnpm\s+(?:install|ci)\b/u.test(promote)) {
      problems.push('promote-release must not install package managers or dependencies');
    }
    const identityIndex = promote.indexOf('Validate exact tag, SHA, clean tree');
    const runtimeIndex = promote.indexOf("node-version: '24.16.0'");
    const repoScriptIndex = promote.indexOf('node scripts/');
    if (identityIndex < 0 || runtimeIndex <= identityIndex || repoScriptIndex <= runtimeIndex) {
      problems.push(
        'promote-release must validate identity, then pin Node, before repository scripts',
      );
    }
    // Job-level env cannot read the runner context (GitHub rejects the whole
    // workflow file), so the runner-temp path must resolve in a step.
    if (
      !/echo "PROMOTION_ORDER=\$RUNNER_TEMP\/promotion-order\.txt" >> "\$GITHUB_ENV"/u.test(promote)
    ) {
      problems.push('promote-release must use one bounded inert promotion-order handoff');
    }
    const promotionOrderDigest = createHash('sha256')
      .update(`${RELEASE_PACKAGE_ORDER.map((entry) => entry.name).join('\n')}\n`)
      .digest('hex');
    if (!promote.includes(`PROMOTION_ORDER_SHA256: ${promotionOrderDigest}`)) {
      problems.push('promotion-order digest must match canonical RELEASE_PACKAGE_ORDER');
    }
    const tokenStart = promote.indexOf('- name: Promote staged release to latest');
    const tokenEnd = promote.indexOf('\n      - name:', tokenStart + 1);
    const tokenStep = promote.slice(tokenStart, tokenEnd);
    if (
      tokenStart < 0 ||
      !/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.MACBOOKM5\s*\}\}/u.test(tokenStep) ||
      !/mapfile -t package_names < "\$PROMOTION_ORDER"/u.test(tokenStep) ||
      !/:_authToken=\$\{NODE_AUTH_TOKEN\}/u.test(tokenStep) ||
      !/export NPM_CONFIG_USERCONFIG="\$promotion_npmrc"/u.test(tokenStep) ||
      !/trap cleanup_npmrc EXIT/u.test(tokenStep)
    ) {
      problems.push('token-bearing promotion must consume the bounded inert order file');
    }
    if (/node\s+scripts\/|release-package-order\.mjs/u.test(tokenStep)) {
      problems.push('token-bearing promotion must NOT execute repository code');
    }
    for (const line of promote
      .split('\n')
      .filter((entry) => /\bnpm\s+(?:view|dist-tag)\b/u.test(entry))) {
      if (!/--registry https:\/\/registry\.npmjs\.org\//u.test(line)) {
        problems.push(`promote-release npm registry is not fixed: ${line.trim()}`);
      }
    }
  }

  if (problems.length === 0) {
    pass(
      7,
      'release workflow isolates build→minimal-stage→macOS-gate→promote with pinned attestations.',
    );
  } else {
    fail(7, `release artifact attestation problems:\n    ${problems.join('\n    ')}`);
  }
}

/**
 * The scheduled macOS qualification lane (Plan 02) must PARTICIPATE in the same
 * action-pin + least-privilege policy as the release workflow: every `uses:`
 * pinned to a full commit SHA, the exact `macos-26` runner (never a floating
 * label), `contents: read` only, and no publish/promotion/OIDC credential. It
 * already participates in the frozen-install policy via checkFrozenInstalls
 * (which scans every workflow); this makes its pinning + privilege explicit so a
 * new native lane can never regress into a mutable, over-privileged runner.
 */
function checkMacosQualificationLane(workflows) {
  const workflow = workflows.find(
    (entry) => entry.relPath === '.github/workflows/macos-qualification.yml',
  );
  if (workflow === undefined) {
    fail(8, '.github/workflows/macos-qualification.yml is missing.');
    return;
  }
  const content = stripComments(workflow.content);
  const problems = [];

  const refs = [...content.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)].map((m) => m[1]);
  if (refs.length === 0) problems.push('no pinned actions found');
  for (const ref of refs) {
    if (!/^[a-f0-9]{40}$/.test(ref))
      problems.push(`action ref "${ref}" must be a full 40-char commit SHA, not a tag`);
  }
  if (!/runs-on:\s*macos-26\b/u.test(content))
    problems.push('the lane must pin the macos-26 runner');
  if (/macos-latest/u.test(content))
    problems.push('macos-latest is forbidden — it can silently drift the image');
  if (!/permissions:\s*\n\s*contents:\s*read/u.test(content))
    problems.push('the lane must be least-privilege (contents: read only)');
  if (/id-token:\s*write/u.test(content))
    problems.push('the qualification lane must NOT hold publish OIDC (id-token: write)');
  if (/\bnpm\s+publish\b/u.test(content))
    problems.push('the qualification lane must NOT publish to npm');
  if (/npm\s+dist-tag\s+add/u.test(content))
    problems.push('the qualification lane must NOT promote to latest');
  if (/secrets\.MACBOOKM5/u.test(content))
    problems.push('the qualification lane must NOT hold the promotion secret MACBOOKM5');
  for (const path of [
    "'packages/**'",
    "'scripts/**'",
    "'package.json'",
    "'pnpm-lock.yaml'",
    "'pnpm-workspace.yaml'",
    "'tsconfig*.json'",
    "'turbo.json'",
  ]) {
    if (content.split(path).length - 1 !== 2) {
      problems.push(`${path} must trigger both push and pull_request qualification`);
    }
  }

  if (problems.length === 0) {
    pass(
      8,
      'macOS qualification lane is pinned, least-privilege, and holds no publish/promotion credential.',
    );
  } else {
    fail(8, `macOS qualification lane policy problems:\n    ${problems.join('\n    ')}`);
  }
}

await checkNoPublishedInstallHooks();
await checkPackageManagerPin();
checkPnpmPolicy();
const workflows = readWorkflowFiles();
checkFrozenInstalls(workflows);
checkTrustedPublish(workflows);
checkDependencyAutomation();
checkReleaseArtifactAttestations(workflows);
checkMacosQualificationLane(workflows);

for (const p of passes) console.log(`✓ [${p.id}] ${p.msg}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`✗ [${f.id}] ${f.msg}`);
  process.exit(1);
}
console.log('Supply-chain release gate passed.');
