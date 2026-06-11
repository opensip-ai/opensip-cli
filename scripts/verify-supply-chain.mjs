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

import { promises as fs } from 'node:fs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverPublishablePackages } from './release-package-order.mjs';

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
    if (
      !/(--provenance|NPM_CONFIG_PROVENANCE\s*[:=]\s*true|provenance:\s*true)/.test(
        workflow.content,
      )
    ) {
      problems.push(`${workflow.relPath}: npm publish without provenance`);
    }
    if (/(NPM_TOKEN|NODE_AUTH_TOKEN)/.test(workflow.content)) {
      problems.push(`${workflow.relPath}: publish workflow references long-lived npm token`);
    }
  }

  if (problems.length === 0) {
    pass(5, 'npm publish workflows use OIDC/provenance and no long-lived publish token.');
  } else {
    fail(5, `trusted publishing problems:\n    ${problems.join('\n    ')}`);
  }
}

await checkNoPublishedInstallHooks();
await checkPackageManagerPin();
checkPnpmPolicy();
const workflows = readWorkflowFiles();
checkFrozenInstalls(workflows);
checkTrustedPublish(workflows);

for (const p of passes) console.log(`✓ [${p.id}] ${p.msg}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`✗ [${f.id}] ${f.msg}`);
  process.exit(1);
}
console.log('Supply-chain release gate passed.');
