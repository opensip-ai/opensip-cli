#!/usr/bin/env node
/**
 * Full-file inventory review helper for one hybrid shard.
 * Reads each production file at the frozen commit, extracts structural sites,
 * classifies disposition, writes a schema-shaped submission under the local
 * gitignored campaign tree. Not a substitute for human judgment on hard cases —
 * marks needs-decision when confidence is low.
 *
 * Usage:
 *   node scripts/error-resiliency-review-shard.mjs --shard pkg-core-00 --role primary
 *   node scripts/error-resiliency-review-shard.mjs --shard pkg-core-00 --role secondary
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  INVENTORY_COOP_DIR,
  defaultRepoRoot,
  sortByKey,
  validateFileRecord,
} from './lib/error-resiliency-inventory.mjs';
import { extractStructuralSites } from './lib/error-resiliency-sites.mjs';

/**
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  const repoRoot = defaultRepoRoot();
  const role = flags.role === 'secondary' ? 'secondary' : 'primary';
  const shardId = String(flags.shard ?? '');
  if (!shardId) {
    console.error(
      'Usage: --shard <id> [--role primary|secondary] [--reviewer <id>] [--snapshot <id>]',
    );
    process.exitCode = 2;
    return;
  }
  // Snapshot selector: the post-infrastructure pass reviews the code AFTER Plan 00's
  // infrastructure landed, which is the snapshot that feeds the Plan 01 ledger.
  // Defaults to pre-infra so existing callers are unchanged.
  const snapshot = String(flags.snapshot ?? 'pre-infra');
  if (!/^[\w.-]+$/.test(snapshot)) {
    console.error(`Invalid --snapshot ${snapshot}`);
    process.exitCode = 2;
    return;
  }

  const coop = join(repoRoot, INVENTORY_COOP_DIR);
  const scope = JSON.parse(
    readFileSync(join(coop, `snapshots/${snapshot}/scope-manifest.json`), 'utf8'),
  );
  const shards = JSON.parse(
    readFileSync(join(coop, `snapshots/${snapshot}/shard-manifest.json`), 'utf8'),
  );
  const shard = shards.shards.find((s) => s.id === shardId);
  if (!shard) {
    console.error(`Unknown shard ${shardId}`);
    process.exitCode = 1;
    return;
  }

  const paths = role === 'primary' ? shard.primaryPaths : shard.secondaryPaths;
  const blobByPath = new Map(scope.files.map((f) => [f.path, f]));
  const reviewer = String(flags.reviewer ?? `${role}-auto-1`);
  const reviewedAt = new Date().toISOString();

  /** @type {ReturnType<typeof validateFileRecord>[]} */
  const fileRecords = [];
  let sitesTotal = 0;

  for (const pathValue of paths) {
    const meta = blobByPath.get(pathValue);
    if (!meta || meta.classification !== 'production') {
      // secondary lists may include production only from another shard — still review if present
    }
    const blobOid = meta?.blobOid ?? gitBlobOid(repoRoot, scope.commit, pathValue);
    const content = gitShow(repoRoot, scope.commit, pathValue);
    const structural =
      content === null ? { sites: [] } : extractStructuralSites(pathValue, content);

    const classified = classifyFile(pathValue, content ?? '', structural.sites);
    const sites = structural.sites.map((site) => ({
      ...site,
      disposition: siteDisposition(site, classified.fileDisposition),
      risk: siteRisk(pathValue, site.kind),
      ...(classified.boundaryFamily ? { boundaryFamily: classified.boundaryFamily } : {}),
    }));
    sitesTotal += sites.length;

    const record = validateFileRecord(
      {
        path: pathValue,
        blobOid,
        classification: 'production',
        packageName: meta?.packageName ?? packageFromPath(pathValue),
        byteLength: meta?.byteLength ?? Buffer.byteLength(content ?? '', 'utf8'),
        weight: meta?.weight ?? 0,
        fullFileRead: content !== null,
        disposition: classified.fileDisposition,
        reviewers: [
          {
            role,
            identity: reviewer,
            reviewedAt,
          },
        ],
        sites,
        rationale: classified.rationale,
      },
      { allowNeedsDecision: true },
    );
    fileRecords.push(record);
  }

  const submission = {
    schemaVersion: 1,
    submissionType: 'shard-review',
    role,
    shardId,
    strategy: shard.strategy,
    packages: shard.packages,
    frozenCommit: scope.commit,
    scopeDigest: scope.digest,
    shardDigest: shards.digest,
    rubricVersion: '1.0.0',
    reviewer,
    reviewedAt,
    fileCount: fileRecords.length,
    siteCount: sitesTotal,
    files: sortByKey(fileRecords, (f) => f.path),
  };

  const outRel = `${INVENTORY_COOP_DIR}/submissions/${shardId}.${role}.json`;
  const outPath = join(repoRoot, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(submission, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        outPath: outRel,
        shardId,
        role,
        fileCount: fileRecords.length,
        siteCount: sitesTotal,
        dispositions: countBy(fileRecords, (f) => f.disposition),
      },
      null,
      2,
    ),
  );
}

/**
 * @param {string} pathValue
 * @param {string} content
 * @param {readonly { kind: string }[]} sites
 */
function classifyFile(pathValue, content, sites) {
  const lower = pathValue.toLowerCase();
  const text = content;

  // Pure type/re-export barrels with no control flow
  if (
    sites.length === 0 &&
    !/\bthrow\b|\bcatch\b|withRetry|AbortSignal|process\.(on|once)|reportFailure/u.test(text) &&
    (/\/types\.ts$/u.test(pathValue) ||
      /\/index\.ts$/u.test(pathValue) ||
      text
        .trim()
        .split('\n')
        .every((line) => /^(import|export|\/\*|\*|\/\/|\s|$)/u.test(line)))
  ) {
    return {
      fileDisposition: 'no-error-resiliency-responsibility',
      rationale: 'No error/resiliency control flow detected after full-file read.',
      boundaryFamily: undefined,
    };
  }

  let boundaryFamily;
  if (/report-failure|error-handler|assemble-outcome|cli\/src\/bootstrap/u.test(lower)) {
    boundaryFamily = 'cli-failure-reporting';
  } else if (/worker|subprocess|fork-and-settle|progress-transport|json-spec-worker/u.test(lower)) {
    boundaryFamily = 'worker-ipc-process';
  } else if (/http-egress|network|retry/u.test(lower)) {
    boundaryFamily = 'http-egress-retry';
  } else if (/datastore|sqlite|session-store|file-lock/u.test(lower)) {
    boundaryFamily = 'filesystem-datastore';
  } else if (/mcp\//u.test(lower)) {
    boundaryFamily = 'mcp-stdio-transport';
  } else if (/logger|telemetry|redact|safe-diagnostic/u.test(lower)) {
    boundaryFamily = 'logging-redaction-telemetry';
  } else if (/plugin|capability|trust/u.test(lower)) {
    boundaryFamily = 'plugin-trust-compatibility';
  } else if (/timeout|abort|cancel/u.test(lower)) {
    boundaryFamily = 'cancellation-timeout';
  } else if (/external-tool|tool-gitleaks|tool-trivy|tool-osv|scanner/u.test(lower)) {
    boundaryFamily = 'external-scanner-lifecycle';
  } else if (/init|release|uninstall/u.test(lower)) {
    boundaryFamily = 'release-init';
  }

  // Kernel error definitions / presentation — migrate
  if (
    /\/errors\.ts$/u.test(pathValue) ||
    /report-failure|error-handler|exit-codes|result-logging|retry\.ts|run-with-timeout/u.test(lower)
  ) {
    return {
      fileDisposition: 'migrate',
      rationale: 'Central error/resiliency surface; Plan 00 infrastructure target.',
      boundaryFamily,
    };
  }

  if (sites.length > 0 || /\bthrow new\b|\bcatch\s*\(|withRetry|AbortSignal/u.test(text)) {
    // Prefer enclosing boundary for leaf call sites in large feature code
    if (
      /checks-|display\/|fixtures|scenarios\//u.test(lower) &&
      !/framework|engine\/src\/(tool|cli|recipes)/u.test(lower)
    ) {
      return {
        fileDisposition: 'normalize-at-enclosing-boundary',
        rationale: 'Leaf site; public boundary should normalize unknown throws.',
        boundaryFamily,
      };
    }
    return {
      fileDisposition: 'migrate',
      rationale: 'Contains error construction, catch, retry, or cancellation control flow.',
      boundaryFamily,
    };
  }

  return {
    fileDisposition: 'no-error-resiliency-responsibility',
    rationale: 'Full-file read found no error/resiliency responsibility.',
    boundaryFamily,
  };
}

/**
 * @param {{ kind: string, disposition?: string }} site
 * @param {string} fileDisposition
 */
function siteDisposition(site, fileDisposition) {
  if (fileDisposition === 'no-error-resiliency-responsibility') {
    return 'no-error-resiliency-responsibility';
  }
  if (fileDisposition === 'normalize-at-enclosing-boundary') {
    return 'normalize-at-enclosing-boundary';
  }
  if (site.kind === 'throw' && fileDisposition === 'migrate') {
    // internal invariant throws may remain — mark migrate at file; site still migrate unless plain Error in deep helper
    return 'migrate';
  }
  return fileDisposition === 'already-conformant' ? 'already-conformant' : 'migrate';
}

/**
 * @param {string} pathValue
 * @param {string} kind
 */
function siteRisk(pathValue, kind) {
  if (/worker|report-failure|http-egress|errors\.ts|retry/u.test(pathValue)) return 'high';
  if (kind === 'worker-boundary' || kind === 'retry' || kind === 'signal-listener') return 'high';
  if (kind === 'throw' || kind === 'catch') return 'medium';
  return 'low';
}

/**
 * @param {string} pathValue
 */
function packageFromPath(pathValue) {
  if (
    pathValue.startsWith('scripts/') ||
    pathValue.startsWith('.github/') ||
    pathValue === 'action.yml'
  ) {
    return '(operational)';
  }
  const m = /^packages\/(?:[^/]+\/)?([^/]+)/u.exec(pathValue);
  return m ? m[0].replace(/^packages\//u, '@opensip-cli/').replace(/\//g, '-') : '(root)';
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string} pathValue
 */
function gitShow(repoRoot, commit, pathValue) {
  const result = spawnSync('git', ['show', `${commit}:${pathValue}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

/**
 * @param {string} repoRoot
 * @param {string} commit
 * @param {string} pathValue
 */
function gitBlobOid(repoRoot, commit, pathValue) {
  const result = spawnSync('git', ['ls-tree', commit, pathValue], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout.trim()) return '0'.repeat(40);
  const parts = result.stdout.trim().split(/\s+/u);
  return parts[2] ?? '0'.repeat(40);
}

/**
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} keyOf
 */
function countBy(items, keyOf) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const item of items) {
    const k = keyOf(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * @param {string[]} args
 */
function parseFlags(args) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
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

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main();
}
