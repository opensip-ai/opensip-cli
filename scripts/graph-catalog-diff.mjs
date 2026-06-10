#!/usr/bin/env node
//
// graph-catalog-diff — function-set delta between the two graph build engines.
//
// The graph tool ships two build engines that disagree on the function set:
//   - exact:   one `adapter.discoverFiles({cwd: projectRoot})` over the ROOT
//              tsconfig (orchestrate.ts -> runGraph). The root tsconfig has no
//              `include`/`exclude`, so TypeScript defaults to *every* `.ts(x)`
//              under the project tree — fixtures and tests included.
//   - sharded: per-workspace-unit discovery. `discoverPolyglotUnits` walks
//              `<root>/packages/**` for directories with a `tsconfig.json`
//              (lang-typescript/workspace-units.ts), then enumerates each unit
//              with `discoverFiles({cwd: unit.rootDir, configPathOverride:
//              unit.configPath})` (graph.ts resolveShards). Per-unit discovery
//              honors each package's OWN tsconfig include/exclude — which omits
//              `**/__fixtures__/**` (every check pack) and `**/__tests__/**` +
//              `**/*.test.ts(x)` (cli, cli-ui, output, config, session-store).
//
// The net effect: files that the root tsconfig sees but no package tsconfig
// includes are silently dropped by the sharded build.
//
// EXTRACTION ROUTE (chosen for faithfulness — drives the REAL CLI end-to-end,
// no engine-internal re-implementation):
//   1. delete the project datastore (`opensip-tools/.runtime/datastore.sqlite`)
//      so the next build is genuinely COLD (empty cache),
//   2. run `graph` (exact) / `graph --sharded` WITH cache enabled — cold build
//      still recomputes everything, but the WITH-cache path is the only one
//      that PERSISTS the unified catalog (both engines gate `catalogRepo
//      .replaceAll(...)` behind `useCache`; `--no-cache` builds the catalog but
//      never writes it, so a downstream reader would see a stale row),
//   3. dump the persisted catalog via the public `graph-symbol-index` command
//      (CatalogRepo.loadFullCatalog -> name->[{qualifiedName,filePath,line,...}]).
//
// CAVEAT: `graph-symbol-index` skips the synthetic `<module-init>` (whole-file)
// occurrence (symbol-index.ts collectEntriesForName). So the occurrence counts
// here EXCLUDE module-init. There is exactly one module-init occurrence per
// discovered file, so the *total* catalog gap is this script's occurrence gap
// plus the file-count gap (one module-init per exact-only file). Both numbers
// are reported below.
//
// Usage:  pnpm build && node scripts/graph-catalog-diff.mjs
//         (run from the repo root; analyzes THIS repo)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const datastore = join(repoRoot, 'opensip-tools', '.runtime', 'datastore.sqlite');

if (!existsSync(cli)) {
  console.error(`CLI not built at ${cli} — run \`pnpm build\` first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'graph-catalog-diff-'));

/** Delete the project datastore (+ sqlite sidecars) so the next build is cold and re-persists. */
function clearDatastore() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(`${datastore}${suffix}`, { force: true });
  }
}

function run(args) {
  execFileSync('node', [cli, ...args], { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Cold-build one engine and dump its persisted catalog symbol index. */
function buildAndDump(label, buildArgs) {
  console.error(`\n[${label}] cold build: graph ${buildArgs.join(' ')}`);
  clearDatastore();
  run(['graph', ...buildArgs]);
  const out = join(work, `${label}.json`);
  run(['graph-symbol-index', '--out', out]);
  const artifact = JSON.parse(readFileSync(out, 'utf8'));
  return artifact;
}

/**
 * Flatten a symbol-index artifact to a Map<identity, {filePath,...}>. Identity:
 * `qualifiedName` when present, else `filePath:line:simpleName` (mirrors the
 * FunctionOccurrence identity model in graph/engine/src/types.ts).
 */
function flatten(artifact) {
  const byIdentity = new Map();
  for (const [simpleName, entries] of Object.entries(artifact.symbols)) {
    for (const e of entries) {
      const identity =
        e.qualifiedName && e.qualifiedName.length > 0
          ? e.qualifiedName
          : `${e.filePath}:${String(e.line)}:${simpleName}`;
      byIdentity.set(identity, { ...e, simpleName });
    }
  }
  return byIdentity;
}

const exact = flatten(buildAndDump('exact', []));
const sharded = flatten(buildAndDump('sharded', ['--sharded']));

const exactOnly = [];
const shardedOnly = [];
let both = 0;
for (const [id, occ] of exact) {
  if (sharded.has(id)) both++;
  else exactOnly.push(occ);
}
for (const [id, occ] of sharded) {
  if (!exact.has(id)) shardedOnly.push(occ);
}

// ---- file-level breakdown of the exact-only set ----
const exactFiles = new Set([...exact.values()].map((o) => o.filePath));
const shardedFiles = new Set([...sharded.values()].map((o) => o.filePath));
const exactOnlyFiles = [...exactFiles].filter((f) => !shardedFiles.has(f));

function topDir(f) {
  if (!f.startsWith('packages/')) return f.includes('/') ? `${f.split('/')[0]}/` : '<root-file>';
  const p = f.split('/');
  // collapse to packages/<ns> or packages/<ns>/<sub> for the nested engine packs
  return p.length >= 3 && (p[2] === 'engine' || p[2].startsWith('checks-') || p[2].startsWith('graph-') || p[2].startsWith('lang-'))
    ? `packages/${p[1]}/${p[2]}`
    : `packages/${p[1]}`;
}

function classify(f) {
  if (/\/__fixtures__\//.test(f)) return 'fixture';
  if (/\.test\.[tj]sx?$/.test(f) || /\/__tests__\//.test(f) || /\.spec\.[tj]sx?$/.test(f)) return 'test';
  return 'other';
}

const exactOnlyByFile = new Map();
for (const occ of exactOnly) {
  exactOnlyByFile.set(occ.filePath, (exactOnlyByFile.get(occ.filePath) ?? 0) + 1);
}

const byTopDir = new Map();
const byClass = { fixture: 0, test: 0, other: 0 };
const otherFiles = [];
for (const f of exactOnlyFiles) {
  const t = topDir(f);
  byTopDir.set(t, (byTopDir.get(t) ?? 0) + 1);
  const c = classify(f);
  byClass[c]++;
  if (c === 'other') otherFiles.push(f);
}

// ---- report ----
const line = '─'.repeat(72);
console.log(`\n${line}`);
console.log('GRAPH CATALOG DIFF — exact vs sharded (non-module-init occurrences)');
console.log(line);
console.log(`exact   occurrences: ${String(exact.size).padStart(6)}   files: ${String(exactFiles.size)}`);
console.log(`sharded occurrences: ${String(sharded.size).padStart(6)}   files: ${String(shardedFiles.size)}`);
console.log(line);
console.log(`both:          ${String(both).padStart(6)}`);
console.log(`exact_only:    ${String(exactOnly.length).padStart(6)}   (occurrences only the exact engine has)`);
console.log(`sharded_only:  ${String(shardedOnly.length).padStart(6)}   (occurrences only the sharded engine has)`);
console.log(line);
console.log(`exact_only files:        ${String(exactOnlyFiles.length)}`);
console.log(`module-init delta:       ${String(exactFiles.size - shardedFiles.size)} (one synthetic module-init per exact-only file — excluded above)`);
console.log(
  `≈ TOTAL catalog gap:     ${String(exactOnly.length + (exactFiles.size - shardedFiles.size))} ` +
    `(exact_only occ ${String(exactOnly.length)} + module-init ${String(exactFiles.size - shardedFiles.size)})`,
);
console.log(line);
console.log('exact_only files by class (cause bucket):');
console.log(`  (b) fixture trees excluded by per-package tsconfig (**/__fixtures__/**): ${String(byClass.fixture)} files`);
console.log(`  (b) test files excluded by per-package tsconfig (**/__tests__/**,*.test.*): ${String(byClass.test)} files`);
console.log(`  (a)/(d) other (NOT under packages/, or unexplained):                      ${String(byClass.other)} files`);
console.log(line);
console.log('exact_only files by top-level directory:');
for (const [dir, n] of [...byTopDir.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${dir}`);
}
console.log(line);
console.log('exact_only occurrences by top-level directory:');
const occByTop = new Map();
for (const occ of exactOnly) {
  const t = topDir(occ.filePath);
  occByTop.set(t, (occByTop.get(t) ?? 0) + 1);
}
for (const [dir, n] of [...occByTop.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${dir}`);
}
if (otherFiles.length > 0) {
  console.log(line);
  console.log('UNEXPLAINED ("other") exact_only files — investigate:');
  for (const f of otherFiles) console.log(`  ${f}`);
}
if (shardedOnly.length > 0) {
  console.log(line);
  console.log(`sharded_only occurrences (expected ~0 — visibility/merge artifacts): ${String(shardedOnly.length)}`);
  for (const occ of shardedOnly.slice(0, 20)) {
    const id = occ.qualifiedName ?? `${occ.filePath}:${String(occ.line)}:${occ.simpleName}`;
    console.log(`  ${id}`);
  }
}
console.log(line);
console.log('distinct exact_only files (filePath -> occurrence count):');
for (const [f, n] of [...exactOnlyByFile.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${f}`);
}
console.log(line);

rmSync(work, { recursive: true, force: true });
// Leave the datastore in its sharded-build state; a subsequent `pnpm graph`
// rebuilds it. Note the diagnostic mutated `.runtime/` (gitignored).
