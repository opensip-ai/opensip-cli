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
  writeSync,
} from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import {
  BOUNDS,
  DETECTOR_VERSION,
  INVENTORY_COOP_DIR,
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
  resolveContainedPath,
  resolveInventoryRoot,
  sortByKey,
} from './lib/error-resiliency-inventory.mjs';
import {
  codeHeadKey,
  diffAgainstBaseline,
  findUnmappedCodeHeads,
  formatCodeHeadViolations,
} from './lib/error-code-heads.mjs';
import {
  extractStructuralSites,
  getDetectorCoverageManifest,
  isStructurallySupportedPath,
} from './lib/error-resiliency-sites.mjs';

const require = createRequire(import.meta.url);
const { readWorkspacePackageManifests } = require('./lib/workspace-package-manifests.cjs');

/** Tracked D11 ratchet baseline. PERMANENT rule state, not campaign state. */
const CODE_HEAD_BASELINE_REL = '.config/error-code-head-baseline.json';
const REVIEW_POLICY_REL = `${INVENTORY_COOP_DIR}/review-policy.json`;

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
      case '-h': {
        stdout(`${usage()}\n`);
        return 0;
      }
      case 'schema-check': {
        return runSchemaCheck(repoRoot, stdout);
      }
      case 'generate': {
        return runGenerate(repoRoot, flags, stdout);
      }
      case 'check': {
        return runCheck(repoRoot, flags, stdout);
      }
      case 'status': {
        return runStatus(repoRoot, flags, stdout);
      }
      case 'reconcile': {
        return runReconcile(repoRoot, flags, stdout);
      }
      case 'ratchet': {
        return runRatchet(repoRoot, flags, stdout);
      }
      case 'code-heads': {
        return runCodeHeads(repoRoot, flags, stdout, stderr);
      }
      default: {
        stderr(`Unknown command: ${command}\n${usage()}\n`);
        return 2;
      }
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

Ephemeral Plan 00 inventory campaign (NOT product config).
Campaign root (gitignored): ${INVENTORY_COOP_DIR}/
  schema.json, rubric.md, review-policy.json, decision-log.md,
  snapshots/<name>/scope-manifest.json, shard-manifest.json, submissions/

Commands:
  schema-check              Validate campaign schema.json + rubric version
  generate [--commit SHA] [--dry-run] [--snapshot pre-infra]
  check [--scope-only] [--policy] [--strict] [--changed] [--ratchet] [--plan 01]
  status                    Coverage/progress summary for a snapshot
  reconcile --from pre-infra --to post-infra
  ratchet                   Temporary no-new-debt check vs C5 baseline (Plan 01)
  code-heads                D11: fail on a constructed code head that is neither
                            registered in the catalog manifest nor mapped by
                            legacyFamilyCode (permanent rule, not campaign state)

Options:
  --commit <sha>   Freeze inventory to this git commit (default HEAD)
  --dry-run        Compute manifests without writing
  --snapshot <id>  Snapshot name under campaign snapshots/ (default pre-infra)
  --scope-only     Only verify scope/shard manifests
  --policy         Verify campaign review-policy.json
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
  const packageByRelDir = new Map(packages.map((pkg) => [toPosix(pkg.relativeDir), pkg.name]));

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

  // Digests omit createdAt so re-generate of the same commit is stable.
  const scopeDigest = digestCanonical(digestableManifest(scopeManifest));
  const scopeWithDigest = { ...scopeManifest, digest: scopeDigest };

  const shardManifest = {
    schemaVersion: SCHEMA_VERSION,
    inventoryRunId: `shards-${commit.slice(0, 12)}`,
    rubricVersion: RUBRIC_VERSION,
    commit,
    snapshot,
    scopeDigest,
    assignmentStrategy: 'hybrid-package-first',
    assignmentRules: {
      splitAboveFiles: 80,
      bundleAtMostFiles: 15,
      subshardWeightBudget: 750_000,
      bundleMaxFiles: 80,
      bundleMaxWeight: 900_000,
    },
    createdAt: scopeManifest.createdAt,
    shardCount: shards.length,
    productionFileCount: productionFiles.length,
    shards,
  };
  const shardDigest = digestCanonical(digestableManifest(shardManifest));
  const shardWithDigest = { ...shardManifest, digest: shardDigest };

  const inventoryRoot = resolveInventoryRoot(repoRoot);
  if (!dryRun) {
    const outDir = join(inventoryRoot, 'snapshots', snapshot);
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
        inventoryRoot: INVENTORY_COOP_DIR,
        tracked: false,
        packageCount: packages.length,
        fileCount: sortedFiles.length,
        productionFileCount: productionFiles.length,
        shardCount: shards.length,
        scopeDigest,
        shardDigest,
        detectorCoverage: {
          detectorVersion: DETECTOR_VERSION,
          structuralLanguages: ['typescript', 'javascript'],
          humanReviewOnlyLanguages: defaultDetectorCoverage().humanReviewOnly.map(
            (r) => r.language,
          ),
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
    const policyPath = join(repoRoot, REVIEW_POLICY_REL);
    if (existsSync(policyPath)) {
      const policy = parseJsonSafe(readFileSync(policyPath, 'utf8'), { label: 'review-policy' });
      const p = /** @type {any} */ (policy);
      if (!p || typeof p !== 'object' || p.schemaVersion !== 1) {
        problems.push('review-policy.json must have schemaVersion 1');
      } else {
        for (const gate of ['C0', 'C1', 'C2', 'C3', 'C4', 'C5']) {
          if (!p.gates?.[gate]) problems.push(`review-policy missing gate ${gate}`);
        }
        if (!Array.isArray(p.boundaryFamilies) || p.boundaryFamilies.length < 8) {
          problems.push('review-policy boundaryFamilies incomplete');
        }
        const requiredFamilies = [
          'external-scanner-lifecycle',
          'mcp-stdio-transport',
          'cli-failure-reporting',
          'worker-ipc-process',
        ];
        for (const family of requiredFamilies) {
          if (!p.boundaryFamilies.includes(family)) {
            problems.push(`review-policy missing boundary family ${family}`);
          }
        }
        if (!p.rules?.blindSecondary || !p.rules?.needsDecisionForbiddenAtAcceptance) {
          problems.push(
            'review-policy rules must require blind secondary and forbid needs-decision at acceptance',
          );
        }
      }
    } else {
      problems.push(`missing ${REVIEW_POLICY_REL} (local campaign; gitignored)`);
    }
  }

  if (flags['scope-only'] || flags.strict || !flags.policy) {
    const snapshot = typeof flags.snapshot === 'string' ? flags.snapshot : 'pre-infra';
    const inventoryRoot = resolveInventoryRoot(repoRoot);
    const scopePath = join(inventoryRoot, 'snapshots', snapshot, 'scope-manifest.json');
    const shardPath = join(inventoryRoot, 'snapshots', snapshot, 'shard-manifest.json');
    if (!existsSync(scopePath) || !existsSync(shardPath)) {
      if (flags['scope-only'] || flags.strict) {
        problems.push(
          `missing scope/shard manifests for snapshot ${snapshot} under ${INVENTORY_COOP_DIR} (local campaign)`,
        );
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
      // Digest integrity: recompute without stored digest / volatile createdAt
      if (scopeObj.digest) {
        const expected = digestCanonical(digestableManifest(scopeObj));
        if (expected !== scopeObj.digest) {
          problems.push('scope-manifest digest mismatch');
        }
      }
      if (shardObj.digest) {
        const expected = digestCanonical(digestableManifest(shardObj));
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
        // sizes differ without missing — extras
        if (
          primary.size !== production.size &&
          problems.every((p) => !p.includes('missing from primary')) &&
          primary.size > production.size
        ) {
          problems.push('primary shards contain non-production or unknown paths');
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

  if (flags.ratchet || flags.plan === '01' || flags.plan === 1) {
    return runRatchet(repoRoot, flags, stdout);
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
 * Temporary Plan 00/01 no-new-debt ratchet (Task 6.3).
 * Compares structural fingerprints in changed production files against
 * ratchet-baseline.json. Unrelated blob churn without new sites is OK.
 */
/**
 * D11 permanent rule. Unlike every other command here this is NOT campaign state: it stays
 * after the inventory artifacts are retired, because the demotion it prevents is a property
 * of the runtime, not of the migration.
 *
 * @param {string} repoRoot
 * @param {(s: string) => void} stdout
 * @param {(s: string) => void} stderr
 * @returns {number}
 */
function runCodeHeads(repoRoot, flags, stdout, stderr) {
  const files = listTrackedFiles(repoRoot, 'HEAD')
    .map((entry) => entry.path)
    .filter(
      (rel) =>
        rel.startsWith('packages/') &&
        rel.includes('/src/') &&
        rel.endsWith('.ts') &&
        !rel.endsWith('.test.ts') &&
        !rel.includes('/__tests__/'),
    );
  const violations = findUnmappedCodeHeads(repoRoot, files);
  const baselinePath = join(repoRoot, CODE_HEAD_BASELINE_REL);

  if (flags.save) {
    const keys = [...new Set(violations.map((v) => codeHeadKey(v)))].sort(compareByCodePointLocal);
    atomicWriteJson(baselinePath, {
      note:
        'Ruling D11 ratchet. Every entry is a constructed error code whose head resolves to ' +
        'CORE.SYSTEM.UNKNOWN_FAILURE at runtime. This file only shrinks: each Plan 01 wave ' +
        'removes its own entries. Adding one requires registering the code instead.',
      entries: keys,
    });
    stdout(`error-code-heads: baseline saved with ${keys.length} entr(ies)\n`);
    return 0;
  }

  const baseline = existsSync(baselinePath)
    ? (parseJsonSafe(readFileSync(baselinePath, 'utf8'), CODE_HEAD_BASELINE_REL).entries ?? [])
    : [];
  const { added, resolved } = diffAgainstBaseline(violations, baseline);

  if (added.length > 0) {
    stderr(`${formatCodeHeadViolations(added)}\n`);
    return 1;
  }
  stdout(
    `error-code-heads: ok — ${violations.length} known, 0 net-new` +
      (resolved.length > 0 ? `, ${resolved.length} resolved (re-run with --save)` : '') +
      `\n`,
  );
  return 0;
}

function runRatchet(repoRoot, flags, stdout) {
  const inventoryRoot = resolveInventoryRoot(repoRoot);
  const baselinePath = join(inventoryRoot, 'ratchet-baseline.json');
  const coverage = getDetectorCoverageManifest();
  /** @type {string[]} */
  const problems = [];

  if (!existsSync(baselinePath)) {
    problems.push(
      `missing ${INVENTORY_COOP_DIR}/ratchet-baseline.json — run Phase 6 C5 generation first`,
    );
    stdout(
      JSON.stringify(
        {
          ok: false,
          mode: 'ratchet',
          detectorCoverage: coverage,
          problems,
          repair: 'Generate post-infra ledger and ratchet baseline under the campaign coop tree.',
        },
        null,
        2,
      ) + '\n',
    );
    return 1;
  }

  const baseline = /** @type {any} */ (
    parseJsonSafe(readFileSync(baselinePath, 'utf8'), { label: 'ratchet-baseline' })
  );
  /** @type {Set<string>} */
  const known = new Set(
    (baseline.sites ?? []).map((s) => `${s.path}\0${s.kind}\0${s.fingerprint}`),
  );

  const changed = listChangedTrackedFiles(repoRoot);
  const newSites = [];
  for (const rel of changed) {
    if (!isStructurallySupportedPath(rel)) continue;
    if (!rel.startsWith('packages/') && !rel.startsWith('scripts/')) continue;
    // Skip tests/fixtures
    if (/\.test\.|\/__tests__\/|\/fixtures\//u.test(rel)) continue;
    let abs;
    try {
      abs = resolveContainedPath(repoRoot, rel);
    } catch {
      continue;
    }
    if (!existsSync(abs)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (Buffer.byteLength(text, 'utf8') > BOUNDS.maxSourceFileBytes) continue;
    const { sites } = extractStructuralSites(rel, text);
    for (const site of sites) {
      const key = `${rel}\0${site.kind}\0${site.fingerprint}`;
      if (!known.has(key)) {
        newSites.push({
          path: rel,
          kind: site.kind,
          siteId: site.siteId,
          fingerprint: site.fingerprint,
          line: site.line,
        });
      }
    }
  }

  for (const site of newSites) {
    problems.push(
      `new structural site not in C5 ratchet baseline: ${site.path}:${site.line} kind=${site.kind} id=${site.siteId} — add catalog definition + inventory evidence, or update ratchet via Plan 01 process (not silent expansion)`,
    );
  }

  stdout(
    JSON.stringify(
      {
        ok: problems.length === 0,
        mode: 'ratchet',
        temporary: true,
        baselineDigest: baseline.digest,
        baselineSiteCount: baseline.siteCount,
        changedFilesScanned: changed.length,
        newStructuralSites: newSites.length,
        detectorCoverage: coverage,
        problems: problems.slice(0, 50),
        problemTruncated: problems.length > 50,
        note: 'Ratchet keys structural fingerprints, not file blobs. Unsupported languages remain human-review-only.',
        deletionCriterion: baseline.deletionCriterion,
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
  const inventoryRoot = resolveInventoryRoot(repoRoot);
  const scopePath = join(inventoryRoot, 'snapshots', snapshot, 'scope-manifest.json');
  const shardPath = join(inventoryRoot, 'snapshots', snapshot, 'shard-manifest.json');
  if (!existsSync(scopePath)) {
    stdout(
      JSON.stringify(
        { ok: true, snapshot, inventoryRoot: INVENTORY_COOP_DIR, state: 'missing-scope' },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  const scope = /** @type {any} */ (
    parseJsonSafe(readFileSync(scopePath, 'utf8'), { label: 'scope-manifest' })
  );
  const shards = existsSync(shardPath)
    ? /** @type {any} */ (
        parseJsonSafe(readFileSync(shardPath, 'utf8'), { label: 'shard-manifest' })
      )
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
  const inventoryRoot = resolveInventoryRoot(repoRoot);
  const fromPath = join(inventoryRoot, 'snapshots', from, 'scope-manifest.json');
  const toPath = join(inventoryRoot, 'snapshots', to, 'scope-manifest.json');
  if (!existsSync(fromPath) || !existsSync(toPath)) {
    throw new InventoryError(
      'INVENTORY.RECONCILE.MISSING',
      `both snapshots must exist under ${INVENTORY_COOP_DIR}: ${from}, ${to}`,
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
  const result = spawnSync('git', ['ls-tree', '-r', '-l', commit], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
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
  // production-ish for package/runtime sources
  if (
    (pathValue.startsWith('packages/') || pathValue.startsWith('scripts/')) &&
    (isStructurallySupportedPath(pathValue) || pathValue.endsWith('.json')) &&
    (pathValue.includes('/src/') || pathValue.startsWith('scripts/'))
  ) {
    return { classification: 'production' };
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
  if (
    pathValue.startsWith('scripts/') ||
    pathValue === 'action.yml' ||
    pathValue.startsWith('.github/')
  ) {
    return '(operational)';
  }
  // longest prefix match on packages/...
  let best = '(root)';
  let bestLen = -1;
  for (const [relDir, name] of packageByRelDir) {
    if ((pathValue === relDir || pathValue.startsWith(`${relDir}/`)) && relDir.length > bestLen) {
      best = name;
      bestLen = relDir.length;
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
 * Hybrid package-first assignment (C1 strategy H):
 * - Primary unit is package ownership (plus `(operational)`).
 * - Packages with > SPLIT_FILES production files are sub-sharded by weight.
 * - Packages with ≤ BUNDLE_FILES are packed into bundle shards (still listed).
 * - Medium packages get one shard each.
 * Secondary coverage rotates to the next shard (blind second reviewer).
 *
 * @param {readonly { path: string, weight: number, packageName: string }[]} productionFiles
 */
function buildShards(productionFiles) {
  const SPLIT_FILES = 80;
  const BUNDLE_FILES = 15;
  const SUBSHARD_WEIGHT = 750_000;
  const BUNDLE_MAX_FILES = 80;
  const BUNDLE_MAX_WEIGHT = 900_000;

  /** @type {Map<string, { path: string, weight: number, packageName: string }[]>} */
  const byPackage = new Map();
  for (const file of productionFiles) {
    const name = file.packageName || '(root)';
    if (!byPackage.has(name)) byPackage.set(name, []);
    byPackage.get(name).push(file);
  }

  /** @type {{ id: string, strategy: string, packages: string[], primaryPaths: string[], totalWeight: number }[]} */
  const raw = [];

  /** @type {{ name: string, files: typeof productionFiles }[]} */
  const small = [];
  const packageNames = [...byPackage.keys()].sort(compareByCodePointLocal);

  for (const name of packageNames) {
    const files = sortByKey(byPackage.get(name) ?? [], (f) => f.path);
    if (files.length === 0) continue;

    if (files.length > SPLIT_FILES) {
      // Sub-shard large packages by weight, keeping package identity in the id.
      /** @type {typeof files} */
      let bucket = [];
      let bucketWeight = 0;
      let part = 0;
      const flushPart = () => {
        if (bucket.length === 0) return;
        const slug = packageSlug(name);
        raw.push({
          id: `pkg-${slug}-${String(part).padStart(2, '0')}`,
          strategy: 'package-subshard',
          packages: [name],
          primaryPaths: bucket.map((f) => f.path),
          totalWeight: bucketWeight,
        });
        part += 1;
        bucket = [];
        bucketWeight = 0;
      };
      for (const file of files) {
        if (bucket.length > 0 && bucketWeight + file.weight > SUBSHARD_WEIGHT) {
          flushPart();
        }
        bucket.push(file);
        bucketWeight += file.weight;
      }
      flushPart();
      continue;
    }

    if (files.length <= BUNDLE_FILES) {
      small.push({ name, files });
      continue;
    }

    // Medium: one shard per package
    raw.push({
      id: `pkg-${packageSlug(name)}`,
      strategy: 'package',
      packages: [name],
      primaryPaths: files.map((f) => f.path),
      totalWeight: files.reduce((sum, f) => sum + f.weight, 0),
    });
  }

  // Bundle tiny packages into coherent multi-package shards
  /** @type {{ name: string, files: typeof productionFiles }[]} */
  let bundle = [];
  let bundleFiles = 0;
  let bundleWeight = 0;
  let bundleIndex = 0;
  const flushBundle = () => {
    if (bundle.length === 0) return;
    const packages = bundle.map((b) => b.name);
    const paths = bundle.flatMap((b) => b.files.map((f) => f.path));
    raw.push({
      id: `bundle-${String(bundleIndex).padStart(2, '0')}`,
      strategy: 'small-package-bundle',
      packages,
      primaryPaths: paths,
      totalWeight: bundleWeight,
    });
    bundleIndex += 1;
    bundle = [];
    bundleFiles = 0;
    bundleWeight = 0;
  };
  for (const entry of small) {
    const entryWeight = entry.files.reduce((sum, f) => sum + f.weight, 0);
    if (
      bundle.length > 0 &&
      (bundleFiles + entry.files.length > BUNDLE_MAX_FILES ||
        bundleWeight + entryWeight > BUNDLE_MAX_WEIGHT)
    ) {
      flushBundle();
    }
    bundle.push(entry);
    bundleFiles += entry.files.length;
    bundleWeight += entryWeight;
  }
  flushBundle();

  // Stable order: package shards by id, then bundles
  raw.sort((a, b) => compareByCodePointLocal(a.id, b.id));

  // Secondary reviews the SAME files as primary (blind dual full-file review).
  // A different reviewer identity is required at submission time; paths must match.
  return raw.map((shard) => ({
    id: shard.id,
    role: 'primary',
    strategy: shard.strategy,
    packages: shard.packages,
    primaryPaths: shard.primaryPaths,
    secondaryPaths: [...shard.primaryPaths],
    primaryCount: shard.primaryPaths.length,
    secondaryCount: shard.primaryPaths.length,
    totalWeight: shard.totalWeight,
  }));
}

/**
 * @param {string} packageName
 */
function packageSlug(packageName) {
  return (
    packageName
      .replace(/^@opensip-cli\//u, '')
      .replace(/[^A-Za-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .toLowerCase() || 'pkg'
  );
}

/**
 * @param {string} a
 * @param {string} b
 */
function compareByCodePointLocal(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Manifest body used for digests: drop volatile/self fields.
 * @param {Record<string, unknown>} manifest
 */
function digestableManifest(manifest) {
  const rest = { ...manifest };
  delete rest.digest;
  delete rest.createdAt;
  return rest;
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

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  main().then((code) => {
    process.exitCode = code;
  });
}
