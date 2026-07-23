#!/usr/bin/env node
/**
 * @fileoverview Thin CLI entrypoint for error/resiliency inventory.
 * Analysis lives in scripts/lib/error-resiliency-inventory.mjs and
 * scripts/lib/error-resiliency-sites.mjs — keep this file as argv + I/O only.
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  BOUNDS,
  DETECTOR_VERSION,
  InventoryError,
  RUBRIC_VERSION,
  SCHEMA_VERSION,
  assertSafeRepoRelativePath,
  canonicalStringify,
  defaultDetectorCoverage,
  defaultRepoRoot,
  digestCanonical,
  formatInventoryDiagnostic,
  loadRubricVersion,
  loadSchemaDocument,
  parseJsonSafe,
  sortByKey,
} from './lib/error-resiliency-inventory.mjs';
import { extractStructuralSites, isStructurallySupportedPath } from './lib/error-resiliency-sites.mjs';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('./lib/workspace-package-manifests.cjs');

const CONFIG_DIR = '.config/error-resiliency-inventory';
const PRE_INFRA = `${CONFIG_DIR}/snapshots/pre-infra`;
const REVIEW_POLICY_PATH = `${CONFIG_DIR}/review-policy.json`;

/**
 * @param {string[]} argv
 * @param {{ repoRoot?: string, stdout?: (s: string) => void, stderr?: (s: string) => void }} [env]
 */
export async function main(argv = process.argv.slice(2), env = {}) {
  const repoRoot = env.repoRoot ?? defaultRepoRoot();
  const stdout = env.stdout ?? ((s) => process.stdout.write(s));
  const stderr = env.stderr ?? ((s) => process.stderr.write(s));
  const command = argv[0] ?? 'help';
  const flags = parseFlags(argv.slice(1));

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        stdout(`${usage()}\n`);
        return 0;
      case 'schema-check':
        return runSchemaCheck(repoRoot, stdout);
      case 'generate':
        return runGenerate(repoRoot, flags, stdout);
      case 'check':
        return runCheck(repoRoot, flags, stdout);
      case 'status':
        return runStatus(repoRoot, flags, stdout);
      case 'reconcile':
        return runReconcile(repoRoot, flags, stdout);
      default:
        stderr(`Unknown command: ${command}\n${usage()}\n`);
        return 2;
    }
  } catch (error) {
    const diagnostic = formatInventoryDiagnostic(error);
    stderr(
      JSON.stringify(
        {
          ok: false,
          ...diagnostic,
        },
        null,
        2,
      ) + '\n',
    );
    return 1;
  }
}

function usage() {
  return `Usage: node scripts/error-resiliency-inventory.mjs <command> [options]

Commands:
  schema-check              Validate committed schema.json + rubric version
  generate [--commit SHA] [--dry-run] [--snapshot pre-infra]
  check [--scope-only] [--policy] [--strict] [--changed]
  status                    Coverage/progress summary for a snapshot
  reconcile --from pre-infra --to post-infra

Options:
  --commit <sha>   Freeze inventory to this git commit (default HEAD)
  --dry-run        Compute manifests without writing
  --snapshot <id>  Snapshot name under snapshots/ (default pre-infra)
  --scope-only     Only verify scope/shard manifests
  --policy         Verify review-policy.json
  --strict         Full artifact + detector coverage honesty checks
  --changed        Local changed-scope mode (tracked changes only)
`;
}

/**
 * @param {string[]} args
 */
function parseFlags(args) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // pnpm/npm often insert a bare `--` before user flags; ignore it.
    if (arg === '--') continue;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key.length === 0) continue;
    const next = args[i + 1];
    if (next && next !== '--' && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/**
 * @param {string} repoRoot
 * @param {(s: string) => void} stdout
 */
function runSchemaCheck(repoRoot, stdout) {
  const schema = loadSchemaDocument(repoRoot);
  const rubricVersion = loadRubricVersion(repoRoot);
  if (rubricVersion !== RUBRIC_VERSION) {
    // Allow rubric file to lead; library constant should match committed rubric.
    throw new InventoryError(
      'INVENTORY.RUBRIC.MISMATCH',
      `library RUBRIC_VERSION ${RUBRIC_VERSION} != rubric.md ${rubricVersion}`,
    );
  }
  const coverage = defaultDetectorCoverage();
  stdout(
    JSON.stringify(
      {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        rubricVersion,
        detectorVersion: coverage.detectorVersion,
        schemaTitle: schema.title,
      },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string | boolean>} flags
 * @param {(s: string) => void} stdout
 */
function runGenerate(repoRoot, flags, stdout) {
  const commit = resolveCommit(repoRoot, typeof flags.commit === 'string' ? flags.commit : 'HEAD');
  const snapshot = typeof flags.snapshot === 'string' ? flags.snapshot : 'pre-infra';
  const dryRun = Boolean(flags['dry-run']);

  const packages = readWorkspacePackageManifests(repoRoot);
  const packageByRelDir = new Map(
    packages.map((pkg) => [toPosix(pkg.relativeDir), pkg.name]),
  );

  const tracked = listTrackedFiles(repoRoot, commit);
  /** @type {ReturnType<typeof classifyTrackedFile>[]} */
  const files = [];
  for (const entry of tracked) {
    const classification = classifyTrackedFile(entry.path);
    const packageName = packageNameForPath(entry.path, packageByRelDir);
    const group = operationalGroup(entry.path);
    const weight = computeWeight(entry.path, entry.byteLength ?? 0, classification);
    files.push({
      path: entry.path,
      blobOid: entry.blobOid,
      byteLength: entry.byteLength ?? 0,
      classification: classification.classification,
      ...(classification.exclusionReason
        ? { exclusionReason: classification.exclusionReason }
        : {}),
      packageName,
      group,
      weight,
    });
  }

  const sortedFiles = sortByKey(files, (f) => f.path);
  const productionFiles = sortedFiles.filter((f) => f.classification === 'production');
  const shards = buildShards(productionFiles);

  const scopeManifest = {
    schemaVersion: SCHEMA_VERSION,
    inventoryRunId: `scope-${commit.slice(0, 12)}`,
    rubricVersion: RUBRIC_VERSION,
    commit,
    snapshot,
    createdAt: new Date().toISOString(),
    packageCount: packages.length,
    packages: sortByKey(
      packages.map((pkg) => ({
        name: pkg.name,
        relativeDir: toPosix(pkg.relativeDir),
        private: Boolean(pkg.private),
      })),
      (p) => p.name,
    ),
    fileCount: sortedFiles.length,
    productionFileCount: productionFiles.length,
    classificationCounts: countBy(sortedFiles, (f) => f.classification),
    groupCounts: countBy(sortedFiles, (f) => f.group),
    detectorCoverage: defaultDetectorCoverage(),
    files: sortedFiles,
  };

  const scopeDigest = digestCanonical(scopeManifest);
  const scopeWithDigest = { ...scopeManifest, digest: scopeDigest };

  const shardManifest = {
    schemaVersion: SCHEMA_VERSION,
    inventoryRunId: `shards-${commit.slice(0, 12)}`,
    rubricVersion: RUBRIC_VERSION,
    commit,
    snapshot,
    scopeDigest,
    createdAt: scopeManifest.createdAt,
    shardCount: shards.length,
    productionFileCount: productionFiles.length,
    shards,
  };
  const shardDigest = digestCanonical(shardManifest);
  const shardWithDigest = { ...shardManifest, digest: shardDigest };

  if (!dryRun) {
    const outDir = join(repoRoot, CONFIG_DIR, 'snapshots', snapshot);
    atomicWriteJson(join(outDir, 'scope-manifest.json'), scopeWithDigest);
    atomicWriteJson(join(outDir, 'shard-manifest.json'), shardWithDigest);
  }

  stdout(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        commit,
        snapshot,
        packageCount: packages.length,
        fileCount: sortedFiles.length,
        productionFileCount: productionFiles.length,
        shardCount: shards.length,
        scopeDigest,
        shardDigest,
        detectorCoverage: {
          detectorVersion: DETECTOR_VERSION,
          structuralLanguages: ['typescript', 'javascript'],
          humanReviewOnlyLanguages: defaultDetectorCoverage().humanReviewOnly.map((r) => r.language),
        },
      },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string | boolean>} flags
 * @param {(s: string) => void} stdout
 */
function runCheck(repoRoot, flags, stdout) {
  /** @type {string[]} */
  const problems = [];

  if (flags.policy || flags.strict) {
    const policyPath = join(repoRoot, REVIEW_POLICY_PATH);
    if (!existsSync(policyPath)) {
      problems.push(`missing ${REVIEW_POLICY_PATH}`);
    } else {
      const policy = parseJsonSafe(readFileSync(policyPath, 'utf8'), { label: 'review-policy' });
      if (!policy || typeof policy !== 'object' || /** @type {any} */ (policy).schemaVersion !== 1) {
        problems.push('review-policy.json must have schemaVersion 1');
      }
    }
  }

  if (flags['scope-only'] || flags.strict || !flags.policy) {
    const snapshot = typeof flags.snapshot === 'string' ? flags.snapshot : 'pre-infra';
    const scopePath = join(repoRoot, CONFIG_DIR, 'snapshots', snapshot, 'scope-manifest.json');
    const shardPath = join(repoRoot, CONFIG_DIR, 'snapshots', snapshot, 'shard-manifest.json');
    if (!existsSync(scopePath) || !existsSync(shardPath)) {
      if (flags['scope-only'] || flags.strict) {
        problems.push(`missing scope/shard manifests for snapshot ${snapshot}`);
      }
    } else {
      const scope = parseJsonSafe(readFileSync(scopePath, 'utf8'), { label: 'scope-manifest' });
      const shards = parseJsonSafe(readFileSync(shardPath, 'utf8'), { label: 'shard-manifest' });
      const scopeObj = /** @type {any} */ (scope);
      const shardObj = /** @type {any} */ (shards);
      if (scopeObj.schemaVersion !== SCHEMA_VERSION) {
        problems.push(`scope schemaVersion must be ${SCHEMA_VERSION}`);
      }
      if (shardObj.schemaVersion !== SCHEMA_VERSION) {
        problems.push(`shard schemaVersion must be ${SCHEMA_VERSION}`);
      }
      if (!Array.isArray(scopeObj.files) || scopeObj.files.length === 0) {
        problems.push('scope-manifest files[] is empty');
      }
      if (Array.isArray(scopeObj.files) && scopeObj.files.length > BOUNDS.maxFilesPerSnapshot) {
        problems.push('scope-manifest exceeds maxFilesPerSnapshot');
      }
      // Digest integrity: recompute without stored digest field
      if (scopeObj.digest) {
        const { digest: _d, ...rest } = scopeObj;
        const expected = digestCanonical(rest);
        if (expected !== scopeObj.digest) {
          problems.push('scope-manifest digest mismatch');
        }
      }
      if (shardObj.digest) {
        const { digest: _d, ...rest } = shardObj;
        const expected = digestCanonical(rest);
        if (expected !== shardObj.digest) {
          problems.push('shard-manifest digest mismatch');
        }
      }
      // Primary shard coverage: union of production files, no primary overlap
      if (Array.isArray(shardObj.shards) && Array.isArray(scopeObj.files)) {
        const production = new Set(
          scopeObj.files
            .filter((/** @type {any} */ f) => f.classification === 'production')
            .map((/** @type {any} */ f) => f.path),
        );
        /** @type {Set<string>} */
        const primary = new Set();
        for (const shard of shardObj.shards) {
          for (const path of shard.primaryPaths ?? []) {
            if (primary.has(path)) {
              problems.push(`primary path overlap: ${path}`);
            }
            primary.add(path);
          }
        }
        for (const path of production) {
          if (!primary.has(path)) {
            problems.push(`production path missing from primary shards: ${path}`);
            break;
          }
        }
        if (primary.size !== production.size && problems.every((p) => !p.includes('missing from primary'))) {
          // sizes differ without missing — extras
          if (primary.size > production.size) {
            problems.push('primary shards contain non-production or unknown paths');
          }
        }
      }
      if (flags.strict) {
        const coverage = scopeObj.detectorCoverage ?? defaultDetectorCoverage();
        if (!coverage.humanReviewOnly || coverage.humanReviewOnly.length === 0) {
          problems.push('strict: detector coverage must declare humanReviewOnly languages');
        }
        if (coverage.detectorVersion !== DETECTOR_VERSION) {
          problems.push(
            `strict: detectorVersion ${coverage.detectorVersion} != library ${DETECTOR_VERSION}`,
          );
        }
      }
    }
  }

  if (flags.changed) {
    // Local mode: ensure tooling can enumerate changed tracked files without full rewrite
    const changed = listChangedTrackedFiles(repoRoot);
    stdout(
      JSON.stringify(
        {
          ok: problems.length === 0,
          mode: 'changed',
          changedCount: changed.length,
          problems,
        },
        null,
        2,
      ) + '\n',
    );
    return problems.length === 0 ? 0 : 1;
  }

  stdout(
    JSON.stringify(
      {
        ok: problems.length === 0,
        problems,
        detectorCoverageNote:
          'Structural detector covers TS/JS only; other languages are human-review-only and are not claimed rediscovered by --strict.',
      },
      null,
      2,
    ) + '\n',
  );
  return problems.length === 0 ? 0 : 1;
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string | boolean>} flags
 * @param {(s: string) => void} stdout
 */
function runStatus(repoRoot, flags, stdout) {
  const snapshot = typeof flags.snapshot === 'string' ? flags.snapshot : 'pre-infra';
  const scopePath = join(repoRoot, CONFIG_DIR, 'snapshots', snapshot, 'scope-manifest.json');
  const shardPath = join(repoRoot, CONFIG_DIR, 'snapshots', snapshot, 'shard-manifest.json');
  if (!existsSync(scopePath)) {
    stdout(JSON.stringify({ ok: true, snapshot, state: 'missing-scope' }, null, 2) + '\n');
    return 0;
  }
  const scope = /** @type {any} */ (
    parseJsonSafe(readFileSync(scopePath, 'utf8'), { label: 'scope-manifest' })
  );
  const shards = existsSync(shardPath)
    ? /** @type {any} */ (parseJsonSafe(readFileSync(shardPath, 'utf8'), { label: 'shard-manifest' }))
    : null;
  stdout(
    JSON.stringify(
      {
        ok: true,
        snapshot,
        commit: scope.commit,
        fileCount: scope.fileCount,
        productionFileCount: scope.productionFileCount,
        packageCount: scope.packageCount,
        classificationCounts: scope.classificationCounts,
        shardCount: shards?.shardCount ?? 0,
        // Do not expose secondary conclusions
        note: 'status omits blind secondary conclusions by design',
      },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

/**
 * @param {string} repoRoot
 * @param {Record<string, string | boolean>} flags
 * @param {(s: string) => void} stdout
 */
function runReconcile(repoRoot, flags, stdout) {
  const from = typeof flags.from === 'string' ? flags.from : '';
  const to = typeof flags.to === 'string' ? flags.to : '';
  if (!from || !to) {
    throw new InventoryError(
      'INVENTORY.RECONCILE.ARGS',
      'reconcile requires --from <snapshot> and --to <snapshot>',
    );
  }
  const fromPath = join(repoRoot, CONFIG_DIR, 'snapshots', from, 'scope-manifest.json');
  const toPath = join(repoRoot, CONFIG_DIR, 'snapshots', to, 'scope-manifest.json');
  if (!existsSync(fromPath) || !existsSync(toPath)) {
    throw new InventoryError(
      'INVENTORY.RECONCILE.MISSING',
      `both snapshots must exist: ${from}, ${to}`,
    );
  }
  const fromScope = /** @type {any} */ (parseJsonSafe(readFileSync(fromPath, 'utf8')));
  const toScope = /** @type {any} */ (parseJsonSafe(readFileSync(toPath, 'utf8')));
  const fromPaths = new Set((fromScope.files ?? []).map((/** @type {any} */ f) => f.path));
  const toPaths = new Set((toScope.files ?? []).map((/** @type {any} */ f) => f.path));
  const added = [...toPaths].filter((p) => !fromPaths.has(p)).sort();
  const removed = [...fromPaths].filter((p) => !toPaths.has(p)).sort();
  stdout(
    JSON.stringify(
      {
        ok: true,
        from,
        to,
        addedCount: added.length,
        removedCount: removed.length,
        added: added.slice(0, 50),
        removed: removed.slice(0, 50),
      },
      null,
      2,
    ) + '\n',
  );
  return 0;
}

/**
 * @param {string} repoRoot
 * @param {string} rev
 */
function resolveCommit(repoRoot, rev) {
  const result = spawnSync('git', ['rev-parse', rev], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new InventoryError('INVENTORY.GIT.REV', `git rev-parse failed for ${rev}`, {
      stderr: result.stderr,
    });
  }
  return result.stdout.trim();
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @returns {{ path: string, blobOid: string, byteLength?: number }[]}
 */
function listTrackedFiles(repoRoot, commit) {
  // name-only with object names: git ls-tree -r -l --format
  const result = spawnSync(
    'git',
    ['ls-tree', '-r', '-l', commit],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new InventoryError('INVENTORY.GIT.LS_TREE', 'git ls-tree failed', {
      stderr: result.stderr,
    });
  }
  /** @type {{ path: string, blobOid: string, byteLength?: number }[]} */
  const files = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    // <mode> <type> <object> <size>\t<file>
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/u);
    const pathValue = line.slice(tab + 1);
    if (meta.length < 4 || meta[1] !== 'blob') continue;
    const blobOid = meta[2];
    const sizeRaw = meta[3];
    const byteLength = sizeRaw === '-' ? undefined : Number(sizeRaw);
    try {
      assertSafeRepoRelativePath(pathValue);
    } catch {
      continue;
    }
    files.push({
      path: pathValue,
      blobOid,
      ...(Number.isFinite(byteLength) ? { byteLength } : {}),
    });
  }
  if (files.length > BOUNDS.maxFilesPerSnapshot) {
    throw new InventoryError('INVENTORY.SCOPE.TOO_LARGE', 'tracked file count exceeds bound');
  }
  return files;
}

/**
 * @param {string} repoRoot
 */
function listChangedTrackedFiles(repoRoot) {
  const result = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * @param {string} pathValue
 */
function classifyTrackedFile(pathValue) {
  const base = posix.basename(pathValue);
  if (
    pathValue.includes('/__fixtures__/') ||
    pathValue.includes('/fixtures/') ||
    pathValue.endsWith('.fixture.ts')
  ) {
    return { classification: 'fixture' };
  }
  if (
    pathValue.includes('/__tests__/') ||
    /\.(test|spec)\.(ts|tsx|mts|cts|js|mjs|cjs)$/u.test(pathValue) ||
    pathValue.includes('/test-support/') ||
    pathValue.includes('/testing/')
  ) {
    return { classification: 'test' };
  }
  if (pathValue.startsWith('docs/') || pathValue.endsWith('.md')) {
    return { classification: 'docs' };
  }
  if (
    base === 'package.json' ||
    base === 'tsconfig.json' ||
    base.startsWith('tsconfig.') ||
    base.endsWith('.config.mjs') ||
    base.endsWith('.config.cjs') ||
    base.endsWith('.config.js') ||
    base === 'turbo.json' ||
    base === 'pnpm-workspace.yaml' ||
    base === 'pnpm-lock.yaml'
  ) {
    return { classification: 'manifest-build' };
  }
  if (
    pathValue.includes('/dist/') ||
    pathValue.includes('/generated/') ||
    pathValue.startsWith('docs/web-generated/')
  ) {
    return { classification: 'generated' };
  }
  if (/\.(wasm|node|bin)$/u.test(pathValue) || pathValue.includes('/grammars/')) {
    return { classification: 'runtime-asset' };
  }
  if (pathValue.startsWith('packages/') || pathValue.startsWith('scripts/')) {
    if (isStructurallySupportedPath(pathValue) || pathValue.endsWith('.json')) {
      // production-ish for package/runtime sources
      if (pathValue.includes('/src/') || pathValue.startsWith('scripts/')) {
        return { classification: 'production' };
      }
    }
  }
  if (pathValue.startsWith('packages/') && /\.(ts|tsx|mts|cts|js|mjs|cjs)$/u.test(pathValue)) {
    return { classification: 'production' };
  }
  if (pathValue === 'action.yml' || pathValue.startsWith('.github/workflows/')) {
    return { classification: 'production' };
  }
  return {
    classification: 'excluded',
    exclusionReason: 'not a package production/runtime inventory surface',
  };
}

/**
 * @param {string} pathValue
 * @param {Map<string, string>} packageByRelDir
 */
function packageNameForPath(pathValue, packageByRelDir) {
  if (pathValue.startsWith('scripts/') || pathValue === 'action.yml' || pathValue.startsWith('.github/')) {
    return '(operational)';
  }
  // longest prefix match on packages/...
  let best = '(root)';
  let bestLen = -1;
  for (const [relDir, name] of packageByRelDir) {
    if (pathValue === relDir || pathValue.startsWith(`${relDir}/`)) {
      if (relDir.length > bestLen) {
        best = name;
        bestLen = relDir.length;
      }
    }
  }
  return best;
}

/**
 * @param {string} pathValue
 */
function operationalGroup(pathValue) {
  if (pathValue.startsWith('scripts/')) return 'scripts';
  if (pathValue === 'action.yml') return 'action';
  if (pathValue.startsWith('.github/workflows/')) return 'github-workflows';
  if (pathValue.startsWith('packages/')) return 'packages';
  return 'other';
}

/**
 * @param {string} pathValue
 * @param {number} byteLength
 * @param {{ classification: string }} classification
 */
function computeWeight(pathValue, byteLength, classification) {
  let weight = Math.min(byteLength, 200_000);
  if (classification.classification !== 'production') {
    return Math.max(1, Math.floor(weight / 10));
  }
  const premiums = [
    [/error/i, 50_000],
    [/retry/i, 40_000],
    [/timeout|abort|cancel/i, 40_000],
    [/worker|subprocess|fork/i, 45_000],
    [/report-failure|error-handler/i, 55_000],
    [/logger|telemetry|redact/i, 35_000],
    [/datastore|sqlite|session/i, 35_000],
    [/http-egress|network/i, 40_000],
  ];
  for (const [re, bonus] of premiums) {
    if (/** @type {RegExp} */ (re).test(pathValue)) weight += /** @type {number} */ (bonus);
  }
  return weight;
}

/**
 * Deterministic shards: primary partitions production files by weight budget.
 * Secondary shards rotate so every file has a different secondary owner id.
 * @param {readonly { path: string, weight: number, packageName: string }[]} productionFiles
 */
function buildShards(productionFiles) {
  const sorted = sortByKey(productionFiles, (f) => f.path);
  const TARGET = 750_000; // weight budget per primary shard
  /** @type {{ id: string, primaryPaths: string[], secondaryOf: string[], totalWeight: number }[]} */
  const shards = [];
  /** @type {string[]} */
  let current = [];
  let currentWeight = 0;
  let shardIndex = 0;

  const flush = () => {
    if (current.length === 0) return;
    const id = `primary-${String(shardIndex).padStart(3, '0')}`;
    shards.push({
      id,
      primaryPaths: [...current],
      secondaryOf: [],
      totalWeight: currentWeight,
    });
    shardIndex += 1;
    current = [];
    currentWeight = 0;
  };

  for (const file of sorted) {
    if (current.length > 0 && currentWeight + file.weight > TARGET) {
      flush();
    }
    current.push(file.path);
    currentWeight += file.weight;
  }
  flush();

  // Assign secondary coverage: each file appears in secondaryOf of the next shard
  if (shards.length === 1) {
    shards[0].secondaryOf = [...shards[0].primaryPaths];
  } else {
    for (let i = 0; i < shards.length; i++) {
      const next = shards[(i + 1) % shards.length];
      next.secondaryOf = [...shards[i].primaryPaths];
    }
  }

  return shards.map((shard) => ({
    id: shard.id,
    role: 'primary',
    primaryPaths: shard.primaryPaths,
    secondaryPaths: shard.secondaryOf,
    primaryCount: shard.primaryPaths.length,
    secondaryCount: shard.secondaryOf.length,
    totalWeight: shard.totalWeight,
  }));
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} keyOf
 */
function countBy(items, keyOf) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * @param {string} pathValue
 */
function toPosix(pathValue) {
  return pathValue.split(sep).join('/');
}

/**
 * Atomic write: temp in same directory, fsync, rename.
 * @param {string} targetPath
 * @param {unknown} value
 */
function atomicWriteJson(targetPath, value) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const payload = canonicalStringify(value);
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o644);
  try {
    writeSync(fd, payload, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  main().then((code) => {
    process.exitCode = code;
  });
}
