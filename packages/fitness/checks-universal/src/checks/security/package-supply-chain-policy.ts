/**
 * @fileoverview Package supply-chain policy check
 *
 * Validates consumer-side package-manager guardrails for npm, pnpm, and Bun:
 * pinned package manager, committed lockfile, frozen CI installs, install
 * script policy, dependency maturity gates, lockfile integrity coverage,
 * exotic dependency review, and trusted publishing posture.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

interface PackageJson {
  name?: string;
  private?: boolean;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  trustedDependencies?: string[];
}

interface PackageJsonFile {
  filePath: string;
  relPath: string;
  packageDir: string;
  json: PackageJson;
}

interface WorkflowFile {
  filePath: string;
  relPath: string;
  content: string;
}

interface ProjectSnapshot {
  rootDir: string;
  rootPackagePath: string;
  rootPackage: PackageJson;
  packages: PackageJsonFile[];
  lockfiles: Set<string>;
  pnpmWorkspace: string | null;
  npmrc: string | null;
  bunfig: string | null;
  workflows: WorkflowFile[];
}

const SUPPORTED_LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
] as const;

const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

const INSTALL_LIFECYCLE_SCRIPTS = new Set(['preinstall', 'install', 'postinstall']);
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

function readIfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    // @swallow-ok unreadable file (permission/IO) -> treat as absent
    return null;
  }
}

function parseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    // @swallow-ok malformed JSON -> treat as unparseable
    return null;
  }
}

function lineOf(content: string, needle: string | RegExp): number {
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (typeof needle === 'string' ? line.includes(needle) : needle.test(line)) {
      return i + 1;
    }
  }
  return 1;
}

function normalizeRel(filePath: string, rootDir: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join('/');
}

function getConfigValue(content: string | null, key: string): string | null {
  if (!content) return null;
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const match = new RegExp(String.raw`^\s*${escaped}\s*[:=]\s*([^#\n]+)`, 'm').exec(content);
  return match?.[1]?.trim().replaceAll(/^['"]|['"]$/g, '') ?? null;
}

function getNpmrcBoolean(content: string | null, key: string): boolean {
  return getConfigValue(content, key)?.toLowerCase() === 'true';
}

function getPositiveNumber(content: string | null, key: string): number | null {
  const value = getConfigValue(content, key);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasTopLevelKey(content: string | null, key: string): boolean {
  if (!content) return false;
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`^${escaped}:`, 'm').test(content);
}

function hasScalarValue(content: string | null, key: string, expected: string): boolean {
  return getConfigValue(content, key)?.toLowerCase() === expected.toLowerCase();
}

async function readPackageJsons(files: FileAccessor, rootDir: string): Promise<PackageJsonFile[]> {
  const packagePaths = files.paths
    .filter((filePath) => path.basename(filePath) === 'package.json')
    .sort((a, b) => a.length - b.length);

  // Read all package.json files in parallel, then assemble in path order.
  const contents = await Promise.all(packagePaths.map((filePath) => files.read(filePath)));

  const packages: PackageJsonFile[] = [];
  for (const [i, filePath] of packagePaths.entries()) {
    const json = parseJson<PackageJson>(contents[i]);
    if (!json) continue;
    packages.push({
      filePath,
      relPath: normalizeRel(filePath, rootDir),
      packageDir: path.dirname(filePath),
      json,
    });
  }
  return packages;
}

function findRootPackagePath(paths: readonly string[]): string | null {
  const candidates = paths
    .filter((filePath) => path.basename(filePath) === 'package.json')
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return candidates[0] ?? null;
}

function readWorkflows(rootDir: string): WorkflowFile[] {
  const workflowsDir = path.join(rootDir, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) return [];
  const workflows: WorkflowFile[] = [];
  for (const entry of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.(ya?ml)$/i.test(entry.name)) continue;
    const filePath = path.join(workflowsDir, entry.name);
    const content = readIfExists(filePath);
    if (content === null) continue;
    workflows.push({ filePath, relPath: normalizeRel(filePath, rootDir), content });
  }
  return workflows;
}

async function buildSnapshot(files: FileAccessor): Promise<ProjectSnapshot | null> {
  const rootPackagePath = findRootPackagePath(files.paths);
  if (!rootPackagePath) return null;
  const rootDir = path.dirname(rootPackagePath);
  const rootContent = await files.read(rootPackagePath);
  const rootPackage = parseJson<PackageJson>(rootContent);
  if (!rootPackage) return null;

  return {
    rootDir,
    rootPackagePath,
    rootPackage,
    packages: await readPackageJsons(files, rootDir),
    lockfiles: new Set(
      SUPPORTED_LOCKFILES.filter((name) => fs.existsSync(path.join(rootDir, name))),
    ),
    pnpmWorkspace: readIfExists(path.join(rootDir, PNPM_WORKSPACE_FILE)),
    npmrc: readIfExists(path.join(rootDir, '.npmrc')),
    bunfig: readIfExists(path.join(rootDir, 'bunfig.toml')),
    workflows: readWorkflows(rootDir),
  };
}

function pushViolation(
  violations: CheckViolation[],
  violation: Omit<CheckViolation, 'severity' | 'line'> & {
    severity?: CheckViolation['severity'];
    line?: number;
  },
): void {
  violations.push({ severity: 'warning', line: 1, ...violation });
}

function checkPackageManagerPin(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  const value = snapshot.rootPackage.packageManager;
  if (!value) {
    pushViolation(violations, {
      filePath: snapshot.rootPackagePath,
      type: 'package-manager-missing',
      message: 'Root package.json does not declare a packageManager pin',
      suggestion:
        'Add an exact packageManager value such as "pnpm@11.5.1+sha512.<hash>" so Corepack installs the expected package manager.',
      severity: 'error',
    });
    return;
  }

  if (!/^(npm|pnpm|bun)@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._~+-]+)?$/.test(value)) {
    pushViolation(violations, {
      filePath: snapshot.rootPackagePath,
      type: 'package-manager-not-exact',
      message: `packageManager "${value}" is not an exact package-manager version`,
      suggestion:
        'Pin packageManager to an exact version; do not use ranges, tags, or unversioned package-manager names.',
      severity: 'error',
      line: lineOf(readIfExists(snapshot.rootPackagePath) ?? '', 'packageManager'),
    });
  }

  if (value.startsWith('pnpm@') && !value.includes('+sha512.')) {
    pushViolation(violations, {
      filePath: snapshot.rootPackagePath,
      type: 'package-manager-missing-integrity',
      message: 'pnpm packageManager pin is missing a Corepack sha512 integrity suffix',
      suggestion:
        'Use `corepack use pnpm@<version>` with a modern Corepack so package.json records the sha512-qualified pnpm pin.',
      line: lineOf(readIfExists(snapshot.rootPackagePath) ?? '', 'packageManager'),
    });
  }
}

function checkLockfilePosture(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  if (snapshot.lockfiles.size === 0) {
    pushViolation(violations, {
      filePath: snapshot.rootPackagePath,
      type: 'lockfile-missing',
      message: 'No supported package-manager lockfile found at the project root',
      suggestion:
        'Commit one root lockfile: pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json, or bun.lock.',
      severity: 'error',
    });
    return;
  }

  if (snapshot.lockfiles.size > 1) {
    pushViolation(violations, {
      filePath: snapshot.rootPackagePath,
      type: 'multiple-lockfiles',
      message: `Multiple package-manager lockfiles found: ${[...snapshot.lockfiles].join(', ')}`,
      suggestion:
        'Keep one authoritative lockfile for the package manager used by package.json#packageManager.',
    });
  }
}

function checkPackageLockIntegrity(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  const lockPath = path.join(snapshot.rootDir, 'package-lock.json');
  const content = readIfExists(lockPath);
  if (!content) return;
  const lock = parseJson<{
    packages?: Record<string, { resolved?: string; integrity?: string }>;
    dependencies?: Record<string, { resolved?: string; integrity?: string }>;
  }>(content);
  if (!lock) return;

  const entries = [
    ...Object.entries(lock.packages ?? {}),
    ...Object.entries(lock.dependencies ?? {}),
  ];
  for (const [name, entry] of entries) {
    if (!entry.resolved?.startsWith('http')) continue;
    if (entry.integrity) continue;
    pushViolation(violations, {
      filePath: lockPath,
      type: 'lockfile-entry-missing-integrity',
      message: `Remote package-lock entry "${name || '<root>'}" has a resolved URL but no integrity hash`,
      suggestion:
        'Regenerate the lockfile with a modern npm CLI and review any direct URL dependencies.',
      severity: 'error',
      line: lineOf(content, entry.resolved),
    });
  }
}

function checkPnpmLockIntegrity(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  const lockPath = path.join(snapshot.rootDir, 'pnpm-lock.yaml');
  const content = readIfExists(lockPath);
  if (!content) return;
  const lines = content.split('\n');
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line.includes('http') || !/(tarball|resolution):/.test(line)) continue;
    const lookahead = lines.slice(index, index + 8).join('\n');
    if (/integrity:\s*sha\d+-/i.test(lookahead) || /integrity:\s*['"]?sha\d+-/i.test(line))
      continue;
    pushViolation(violations, {
      filePath: lockPath,
      type: 'lockfile-entry-missing-integrity',
      message: 'pnpm lockfile contains a remote tarball resolution without a nearby integrity hash',
      suggestion:
        'Upgrade pnpm and regenerate the lockfile; modern pnpm rejects mutable remote tarball entries without integrity.',
      severity: 'error',
      line: index + 1,
    });
  }
}

function checkLockfileIntegrity(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  checkPackageLockIntegrity(snapshot, violations);
  checkPnpmLockIntegrity(snapshot, violations);
}

function dependencyEntries(pkg: PackageJson): [string, string][] {
  const entries: [string, string][] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      entries.push([name, spec]);
    }
  }
  return entries;
}

function hasCommitPin(spec: string): boolean {
  return /#[a-f0-9]{40}(?:$|[^\da-f])/i.test(spec);
}

function isExoticSpec(spec: string): boolean {
  return /^(git\+|git:\/\/|github:|gitlab:|bitbucket:|https?:\/\/|ssh:\/\/|git@|file:)/.test(spec);
}

function checkExoticDependencies(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  for (const pkg of snapshot.packages) {
    const content = readIfExists(pkg.filePath) ?? '';
    for (const [name, spec] of dependencyEntries(pkg.json)) {
      if (!isExoticSpec(spec)) continue;
      const isGit = /^(git\+|git:\/\/|github:|gitlab:|bitbucket:|ssh:\/\/|git@)/.test(spec);
      if (isGit && hasCommitPin(spec)) continue;
      const kind = spec.startsWith('file:')
        ? 'local path dependency'
        : 'mutable non-registry dependency';
      pushViolation(violations, {
        filePath: pkg.filePath,
        type: 'exotic-dependency-source',
        message: `${pkg.relPath} declares ${kind} ${name}@${spec}`,
        suggestion:
          'Prefer registry/workspace dependencies. If a git dependency is unavoidable, pin it to a full 40-character commit SHA and review it explicitly.',
        line: lineOf(content, `"${name}"`),
      });
    }
  }
}

function checkInstallLifecycleScripts(
  snapshot: ProjectSnapshot,
  violations: CheckViolation[],
): void {
  for (const pkg of snapshot.packages) {
    for (const scriptName of Object.keys(pkg.json.scripts ?? {})) {
      if (!INSTALL_LIFECYCLE_SCRIPTS.has(scriptName)) continue;
      pushViolation(violations, {
        filePath: pkg.filePath,
        type: 'install-lifecycle-script',
        message: `${pkg.relPath} declares an install-time lifecycle script "${scriptName}"`,
        suggestion:
          'Avoid install-time lifecycle scripts in publishable packages. If this is an app-only script, document why it is safe and keep dependency install scripts disabled or allowlisted.',
        severity: pkg.json.private === true ? 'warning' : 'error',
        line: lineOf(readIfExists(pkg.filePath) ?? '', `"${scriptName}"`),
      });
    }
  }
}

function checkInstallScriptPolicy(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  if (snapshot.lockfiles.has('pnpm-lock.yaml')) {
    if (!hasTopLevelKey(snapshot.pnpmWorkspace, 'allowBuilds')) {
      pushViolation(violations, {
        filePath: path.join(snapshot.rootDir, PNPM_WORKSPACE_FILE),
        type: 'install-script-policy-missing',
        message: 'pnpm project does not declare an allowBuilds install-script policy',
        suggestion:
          'Add an explicit allowBuilds map to pnpm-workspace.yaml and approve only dependencies that truly need install/build scripts.',
        severity: 'error',
      });
    }
    if (hasScalarValue(snapshot.pnpmWorkspace, 'dangerouslyAllowAllBuilds', 'true')) {
      pushViolation(violations, {
        filePath: path.join(snapshot.rootDir, PNPM_WORKSPACE_FILE),
        type: 'install-script-policy-allows-all',
        message: 'pnpm dangerouslyAllowAllBuilds is enabled',
        suggestion: 'Remove dangerouslyAllowAllBuilds and use a narrow allowBuilds map instead.',
        severity: 'error',
        line: lineOf(snapshot.pnpmWorkspace ?? '', 'dangerouslyAllowAllBuilds'),
      });
    }
  }

  if (
    snapshot.lockfiles.has('package-lock.json') ||
    snapshot.lockfiles.has('npm-shrinkwrap.json')
  ) {
    const npmHasPolicy =
      getNpmrcBoolean(snapshot.npmrc, 'ignore-scripts') ||
      (getNpmrcBoolean(snapshot.npmrc, 'strict-allow-scripts') &&
        snapshot.npmrc?.includes('allow-scripts'));
    if (!npmHasPolicy) {
      pushViolation(violations, {
        filePath: path.join(snapshot.rootDir, '.npmrc'),
        type: 'install-script-policy-missing',
        message: 'npm project does not disable or strictly allowlist dependency install scripts',
        suggestion:
          'Set ignore-scripts=true, or use strict-allow-scripts=true with a narrow allow-scripts policy for dependencies that genuinely need lifecycle hooks.',
      });
    }
  }

  if (snapshot.lockfiles.has('bun.lock') || snapshot.lockfiles.has('bun.lockb')) {
    const trusted = snapshot.rootPackage.trustedDependencies;
    if (!Array.isArray(trusted)) {
      pushViolation(violations, {
        filePath: snapshot.rootPackagePath,
        type: 'install-script-policy-missing',
        message: 'Bun project does not declare trustedDependencies',
        suggestion:
          'Add trustedDependencies to package.json. Use [] to disable all dependency lifecycle scripts, or list only reviewed packages.',
      });
    }
  }
}

function checkMinimumReleaseAge(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  if (snapshot.lockfiles.has('pnpm-lock.yaml')) {
    if ((getPositiveNumber(snapshot.pnpmWorkspace, 'minimumReleaseAge') ?? 0) <= 0) {
      pushViolation(violations, {
        filePath: path.join(snapshot.rootDir, PNPM_WORKSPACE_FILE),
        type: 'minimum-release-age-missing',
        message: 'pnpm minimumReleaseAge is not explicitly enabled',
        suggestion:
          'Set minimumReleaseAge: 1440 or higher in pnpm-workspace.yaml, and pair it with minimumReleaseAgeStrict: true.',
        severity: 'error',
      });
    }
    if (!hasScalarValue(snapshot.pnpmWorkspace, 'minimumReleaseAgeStrict', 'true')) {
      pushViolation(violations, {
        filePath: path.join(snapshot.rootDir, PNPM_WORKSPACE_FILE),
        type: 'minimum-release-age-not-strict',
        message: 'pnpm minimumReleaseAgeStrict is not enabled',
        suggestion:
          'Set minimumReleaseAgeStrict: true so newly published versions fail closed instead of being silently exempted.',
      });
    }
  }

  if (
    (snapshot.lockfiles.has('package-lock.json') ||
      snapshot.lockfiles.has('npm-shrinkwrap.json')) &&
    (getPositiveNumber(snapshot.npmrc, 'min-release-age') ?? 0) <= 0
  ) {
    pushViolation(violations, {
      filePath: path.join(snapshot.rootDir, '.npmrc'),
      type: 'minimum-release-age-missing',
      message: 'npm min-release-age is not enabled',
      suggestion: 'Set min-release-age to a positive number of days in project .npmrc.',
    });
  }

  if (
    (snapshot.lockfiles.has('bun.lock') || snapshot.lockfiles.has('bun.lockb')) &&
    (getPositiveNumber(snapshot.bunfig, 'minimumReleaseAge') ?? 0) <= 0
  ) {
    pushViolation(violations, {
      filePath: path.join(snapshot.rootDir, 'bunfig.toml'),
      type: 'minimum-release-age-missing',
      message: 'Bun minimumReleaseAge is not enabled',
      suggestion: 'Set [install].minimumReleaseAge to a positive number of seconds in bunfig.toml.',
    });
  }
}

function workflowLines(workflow: WorkflowFile): string[] {
  return workflow.content.split('\n');
}

function isFrozenInstallLine(line: string): boolean {
  return (
    /\bnpm\s+ci\b/.test(line) ||
    /\bpnpm\s+(?:install|i)\b.*--frozen-lockfile/.test(line) ||
    /\bpnpm\s+ci\b/.test(line) ||
    /\bbun\s+install\b.*--frozen-lockfile/.test(line) ||
    /\bbun\s+ci\b/.test(line)
  );
}

function isPackageManagerBootstrapLine(line: string): boolean {
  return (
    /\bnpm\s+install\b.*\s--prefix\b.*\bnpm@\d+/.test(line) ||
    /\bnpm\s+install\s+--prefix\b.*\bnpm@\d+/.test(line)
  );
}

function isMutableInstallLine(line: string): boolean {
  if (isPackageManagerBootstrapLine(line)) return false;
  return (
    /\bnpm\s+install\b/.test(line) ||
    (/\bpnpm\s+(?:install|i)\b/.test(line) && !line.includes('--frozen-lockfile')) ||
    (/\bbun\s+install\b/.test(line) && !line.includes('--frozen-lockfile'))
  );
}

function splitWorkflowSteps(content: string): string[] {
  const lines = content.split('\n');
  const steps: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^\s*-\s+name:/.test(line) && current.length > 0) {
      steps.push(current.join('\n'));
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) steps.push(current.join('\n'));
  return steps;
}

function executableStepText(step: string): string {
  return step
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function extractPublishBlocks(workflowContent: string): string[] {
  const blocks: string[] = [];
  for (const step of splitWorkflowSteps(workflowContent)) {
    const executable = executableStepText(step);
    if (/\bnpm\s+publish\b/.test(executable)) {
      blocks.push(executable);
    }
  }
  return blocks;
}

function publishBlockHasProvenance(block: string): boolean {
  return /(--provenance|NPM_CONFIG_PROVENANCE\s*[:=]\s*true|provenance:\s*true)/.test(block);
}

function publishBlockReferencesLongLivedToken(block: string): boolean {
  return /\bnpm\s+publish\b/.test(block) && /(NPM_TOKEN|NODE_AUTH_TOKEN)/.test(block);
}

function checkFrozenCiInstalls(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  if (snapshot.workflows.length === 0) return;
  let hasFrozenInstall = false;
  for (const workflow of snapshot.workflows) {
    for (const [index, rawLine] of workflowLines(workflow).entries()) {
      const line = rawLine.trim();
      if (line.startsWith('#')) continue;
      if (isFrozenInstallLine(line)) hasFrozenInstall = true;
      if (!isMutableInstallLine(line)) continue;
      pushViolation(violations, {
        filePath: workflow.filePath,
        type: 'ci-install-not-frozen',
        message: `${workflow.relPath} uses a mutable package install command: ${line}`,
        suggestion:
          'Use npm ci, pnpm install --frozen-lockfile, pnpm ci, bun install --frozen-lockfile, or bun ci in CI.',
        severity: 'error',
        line: index + 1,
      });
    }
  }

  if (!hasFrozenInstall) {
    pushViolation(violations, {
      filePath: snapshot.workflows[0]?.filePath ?? snapshot.rootPackagePath,
      type: 'ci-frozen-install-missing',
      message: 'No frozen package install command was found in GitHub workflows',
      suggestion:
        'Use npm ci, pnpm install --frozen-lockfile, pnpm ci, bun install --frozen-lockfile, or bun ci in every CI install lane.',
    });
  }
}

function checkTrustedPublishing(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  for (const workflow of snapshot.workflows) {
    if (!/\bnpm\s+publish\b/.test(workflow.content)) continue;
    if (!/id-token:\s*write/.test(workflow.content)) {
      pushViolation(violations, {
        filePath: workflow.filePath,
        type: 'trusted-publishing-missing-oidc',
        message: `${workflow.relPath} publishes to npm without id-token: write permission`,
        suggestion:
          'Use npm trusted publishing/OIDC and add permissions.id-token: write to the publish job.',
        severity: 'error',
        line: lineOf(workflow.content, 'npm publish'),
      });
    }
    const publishBlocks = extractPublishBlocks(workflow.content);
    for (const block of publishBlocks) {
      if (!publishBlockHasProvenance(block)) {
        pushViolation(violations, {
          filePath: workflow.filePath,
          type: 'publish-provenance-missing',
          message: `${workflow.relPath} publishes to npm without explicit provenance in an npm publish step`,
          suggestion:
            'Publish with npm trusted publishing and --provenance (or NPM_CONFIG_PROVENANCE=true) on every npm publish command, including commands inside shell functions. Producer provenance is distinct from consumption-side verification by installers/loaders.',
          severity: 'error',
          line: lineOf(workflow.content, 'npm publish'),
        });
      }
      if (publishBlockReferencesLongLivedToken(block)) {
        pushViolation(violations, {
          filePath: workflow.filePath,
          type: 'publish-token-exposure',
          message: `${workflow.relPath} references a long-lived npm token in an npm publish step`,
          suggestion:
            'Prefer npm trusted publishing/OIDC for npm publish. A token confined to `npm dist-tag` promotion in an OIDC workflow is acceptable (OIDC does not cover dist-tag).',
          severity: 'error',
          line: lineOf(workflow.content, /NPM_TOKEN|NODE_AUTH_TOKEN/),
        });
      }
    }
  }
}

function checkDependencyAutomation(snapshot: ProjectSnapshot, violations: CheckViolation[]): void {
  const rootDir = snapshot.rootDir;
  const dependabotPath = path.join(rootDir, '.github/dependabot.yml');
  const renovatePath = path.join(rootDir, 'renovate.json');
  const dependabotContent = readIfExists(dependabotPath);
  const renovateContent = readIfExists(renovatePath);
  if (!dependabotContent && !renovateContent) return;
  if (dependabotContent && renovateContent) {
    pushViolation(violations, {
      filePath: dependabotPath,
      type: 'dependency-automation-conflict',
      message: 'Both dependabot.yml and renovate.json are present',
      suggestion: 'Choose one dependency automation tool (Dependabot or Renovate), not both.',
      severity: 'error',
    });
    return;
  }
  const content = dependabotContent ?? renovateContent ?? '';
  const filePath = dependabotContent ? dependabotPath : renovatePath;
  if (/automerge:\s*true/i.test(content) && /update-types:[\s\S]*major/i.test(content)) {
    pushViolation(violations, {
      filePath,
      type: 'dependency-automation-unsafe-automerge',
      message: 'Dependency automation enables automerge for major updates',
      suggestion: 'Require maintainer review for major runtime dependency updates.',
      severity: 'error',
    });
  }
  if (/automergeType:\s*["']?all["']?/i.test(content)) {
    pushViolation(violations, {
      filePath,
      type: 'dependency-automation-unsafe-automerge',
      message: 'Dependency automation enables automergeType: all',
      suggestion: 'Do not automerge dependency updates in this repo.',
      severity: 'error',
    });
  }
}

export async function analyzePackageSupplyChainPolicy(
  files: FileAccessor,
): Promise<CheckViolation[]> {
  const snapshot = await buildSnapshot(files);
  if (!snapshot) return [];

  const violations: CheckViolation[] = [];
  checkPackageManagerPin(snapshot, violations);
  checkLockfilePosture(snapshot, violations);
  checkLockfileIntegrity(snapshot, violations);
  checkExoticDependencies(snapshot, violations);
  checkInstallLifecycleScripts(snapshot, violations);
  checkInstallScriptPolicy(snapshot, violations);
  checkMinimumReleaseAge(snapshot, violations);
  checkFrozenCiInstalls(snapshot, violations);
  checkTrustedPublishing(snapshot, violations);
  checkDependencyAutomation(snapshot, violations);
  return violations;
}

export const packageSupplyChainPolicy = defineCheck({
  id: 'ea3ec1d6-16ab-43c4-9875-50d3fd9f564c',
  slug: 'package-supply-chain-policy',
  scope: { languages: ['typescript'], concerns: ['config'] },
  contentFilter: 'raw',
  fileTypes: ['json'],

  confidence: 'medium',
  description: 'Validate npm/pnpm/Bun supply-chain guardrails',
  longDescription: `**Purpose:** Validates package-manager supply-chain guardrails for npm, pnpm, and Bun projects.

**Detects:**
- Missing or non-exact \`packageManager\` pins
- Missing or conflicting lockfiles
- Remote lockfile entries without integrity hashes
- Mutable git, URL, tarball, or local path dependencies
- Install-time lifecycle scripts and missing install-script allowlists
- Missing dependency release-age gates
- CI install commands that can rewrite lockfiles
- npm publish workflows that lack OIDC/provenance or still use long-lived tokens in \`npm publish\` steps (a token confined to \`npm dist-tag\` promotion in an OIDC publish workflow is exempt — OIDC covers \`npm publish\`, not \`npm dist-tag\`)
- Unsafe dependency-automation automerge settings when Dependabot/Renovate config is present

**Producer vs consumer provenance:** this check enforces **producer-side** publish workflow posture. **Consumption-side** verification (install/load provenance for third-party packages) is a separate trust policy and is not enforced by this check.

**Why it matters:** Modern npm-family attacks often execute during installation, exploit fresh compromised versions before takedown, or bypass weakened lockfile/install-script policy. These checks keep the project in a fail-closed posture before dependency code runs in CI or developer machines.

**Scope:** General best practice. Cross-file analysis over package metadata, root lockfiles, package-manager config files, and GitHub workflow files.`,
  tags: ['security', 'dependencies', 'supply-chain'],

  analyzeAll: analyzePackageSupplyChainPolicy,
});
