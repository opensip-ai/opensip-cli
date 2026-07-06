#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATASTORE_DIR = join(REPO_ROOT, 'packages', 'datastore');
const MIGRATIONS_DIR = join(DATASTORE_DIR, 'migrations');
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta', '_journal.json');
const SCHEMA_VERSION_PATH = join(DATASTORE_DIR, 'src', 'schema-version.ts');
const DRIZZLE_CONFIG_PATH = join(DATASTORE_DIR, 'drizzle.config.ts');

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function journalEntryCount() {
  const journal = readJson(JOURNAL_PATH);
  if (!Array.isArray(journal.entries)) {
    fail('packages/datastore/migrations/meta/_journal.json has no entries array');
  }
  return journal.entries.length;
}

function latestJournalEntry() {
  const journal = readJson(JOURNAL_PATH);
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    fail('packages/datastore/migrations/meta/_journal.json has no entries');
  }
  return journal.entries.at(-1);
}

function schemaVersionLiteralCount() {
  const source = readFileSync(SCHEMA_VERSION_PATH, 'utf8');
  const match = /LOGICAL_SCHEMA_VERSION\s*=\s*SCHEMA_VERSION_OFFSET\s*\+\s*(\d+)/.exec(source);
  if (match === null) {
    fail('Could not parse LOGICAL_SCHEMA_VERSION = SCHEMA_VERSION_OFFSET + N literal');
  }
  return Number.parseInt(match[1], 10);
}

function verifySchemaVersionLockstep() {
  const journalCount = journalEntryCount();
  const literalCount = schemaVersionLiteralCount();
  if (literalCount !== journalCount) {
    fail(
      [
        'LOGICAL_SCHEMA_VERSION is not in lockstep with the migration journal.',
        `schema-version.ts literal count: ${String(literalCount)}`,
        `meta/_journal.json entries: ${String(journalCount)}`,
        'Regenerate migrations and update LOGICAL_SCHEMA_VERSION together.',
      ].join('\n'),
    );
  }
}

function findPackageRootFromEntry(entryPath, packageName) {
  let dir = dirname(entryPath);
  while (dir !== dirname(dir)) {
    const packageJsonPath = join(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = readJson(packageJsonPath);
      if (pkg.name === packageName) return dir;
    }
    dir = dirname(dir);
  }
  return null;
}

function resolveDrizzleKitBin() {
  try {
    const requireFromDatastore = createRequire(join(DATASTORE_DIR, 'package.json'));
    const entryPath = requireFromDatastore.resolve('drizzle-kit');
    const packageRoot = findPackageRootFromEntry(entryPath, 'drizzle-kit');
    if (packageRoot === null) {
      fail('drizzle-kit package root could not be located from its resolved entrypoint');
    }
    const pkg = readJson(join(packageRoot, 'package.json'));
    const bin = typeof pkg.bin === 'object' ? pkg.bin['drizzle-kit'] : pkg.bin;
    if (typeof bin !== 'string' || bin.length === 0) {
      fail('drizzle-kit package has no drizzle-kit bin entry');
    }
    return join(packageRoot, bin);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`drizzle-kit unresolvable from @opensip-cli/datastore — run pnpm install\n${detail}`);
  }
}

function tail(text, max = 4000) {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

/**
 * The authoritative schema list lives in drizzle.config.ts. Parse it (rather
 * than duplicate it) so this gate can never drift from the config it protects:
 * a schema source added/removed there is picked up here automatically.
 */
function parseConfigSchemaPaths() {
  // Strip line comments FIRST: the config's comments contain apostrophes
  // (e.g. "fitness's") that would otherwise be read as string delimiters and
  // swallow the real `./src/schema/*.ts` entries. Block comments aren't used.
  const source = readFileSync(DRIZZLE_CONFIG_PATH, 'utf8').replaceAll(/\/\/[^\n]*/g, '');
  const block = /schema\s*:\s*\[([\s\S]*?)\]/m.exec(source);
  if (block === null) {
    fail('Could not locate the `schema: [ ... ]` array in packages/datastore/drizzle.config.ts');
  }
  // Match only quoted paths ending in `.ts` — belt-and-braces against any
  // remaining prose so the parsed list can never silently drop a schema source.
  const paths = [...block[1].matchAll(/['"]([^'"]+\.ts)['"]/g)].map((match) => match[1]);
  if (paths.length === 0) {
    fail('packages/datastore/drizzle.config.ts declares an empty schema list');
  }
  // The config's paths are relative to the datastore package dir.
  return paths.map((p) => resolve(DATASTORE_DIR, p));
}

function writeTempDrizzleConfig(tempConfigPath, tempMigrationsDir) {
  const schema = parseConfigSchemaPaths();
  const out = relative(DATASTORE_DIR, tempMigrationsDir).replaceAll('\\', '/');
  writeFileSync(
    tempConfigPath,
    [
      'export default {',
      "  dialect: 'sqlite',",
      `  schema: ${JSON.stringify(schema)},`,
      `  out: ${JSON.stringify(out)},`,
      '};',
      '',
    ].join('\n'),
    'utf8',
  );
}

function runDrizzleGenerate(drizzleKitBin, tempConfigPath) {
  const result = spawnSync(
    process.execPath,
    [drizzleKitBin, 'generate', '--config', tempConfigPath],
    {
      cwd: DATASTORE_DIR,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    fail(`drizzle-kit generate failed to start\n${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      [
        `drizzle-kit generate exited ${String(result.status ?? 'null')}`,
        tail(result.stdout ?? ''),
        tail(result.stderr ?? ''),
      ]
        .filter((part) => part.length > 0)
        .join('\n'),
    );
  }
}

function latestCommittedSnapshotPath() {
  const entry = latestJournalEntry();
  if (typeof entry !== 'object' || entry === null || typeof entry.tag !== 'string') {
    fail('Latest drizzle journal entry has no string tag');
  }
  const prefix = /^(\d{4})_/.exec(entry.tag)?.[1];
  if (prefix === undefined) {
    fail(`Latest drizzle journal tag has no numeric prefix: ${entry.tag}`);
  }
  return join(MIGRATIONS_DIR, 'meta', `${prefix}_snapshot.json`);
}

function canonicalSnapshot(snapshot) {
  const clone = structuredClone(snapshot);
  delete clone.id;
  delete clone.prevId;
  return clone;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function snapshotTableSummary(snapshot) {
  const tables = snapshot.tables;
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return [];
  return Object.entries(tables)
    .map(([name, table]) => {
      const columns =
        table !== null && typeof table === 'object' && !Array.isArray(table)
          ? Object.keys(table.columns ?? {}).length
          : 0;
      return `${name}:${String(columns)}`;
    })
    .sort();
}

// The drizzle-kit snapshot serialization version this gate is written against.
// Pinned deliberately (plan Task 6.3, option 2): the copy-journal-then-generate
// mechanism the plan first prescribed does NOT work with drizzle-kit 0.31.x — an
// incremental `generate` over the committed multi-snapshot journal aborts with a
// "parent snapshot collision" AND exits 0, so a count-based check silently
// passes. We therefore compare a fresh empty-dir squash against the committed
// snapshot's table structure (which correctly bites on drift), and pin the
// snapshot `version` so a drizzle-kit upgrade that changes the format fails here
// with a clear "re-pin + regenerate" message instead of a spurious table diff.
const EXPECTED_SNAPSHOT_VERSION = '6';

function assertSnapshotVersion(label, snapshot) {
  const version = String(snapshot.version ?? '');
  if (version !== EXPECTED_SNAPSHOT_VERSION) {
    fail(
      [
        `Drizzle ${label} snapshot format version is '${version}', expected '${EXPECTED_SNAPSHOT_VERSION}'.`,
        'drizzle-kit changed its snapshot serialization. Regenerate the committed migrations',
        '(pnpm --filter @opensip-cli/datastore db:generate), confirm they are correct, then',
        'update EXPECTED_SNAPSHOT_VERSION in scripts/verify-drizzle-migrations.mjs to match.',
      ].join('\n'),
    );
  }
}

/**
 * Detect schema/migrations drift by regenerating a fresh squash of the current
 * schema into an EMPTY temp folder and comparing its single snapshot's table
 * structure (canonicalized: id/prevId stripped) against the latest committed
 * snapshot. A clean tree matches; a schema edit without a committed regeneration
 * diverges. See EXPECTED_SNAPSHOT_VERSION for why this is used over the
 * copy-journal-then-generate approach the plan first prescribed.
 */
function verifyMigrationDrift() {
  const drizzleKitBin = resolveDrizzleKitBin();
  const tempRoot = mkdtempSync(join(DATASTORE_DIR, '.verify-drizzle-'));
  try {
    const tempMigrationsDir = join(tempRoot, 'migrations');
    const tempConfigPath = join(tempRoot, 'drizzle.config.mjs');
    writeTempDrizzleConfig(tempConfigPath, tempMigrationsDir);
    runDrizzleGenerate(drizzleKitBin, tempConfigPath);
    const generatedSnapshotPath = join(tempMigrationsDir, 'meta', '0000_snapshot.json');
    if (!existsSync(generatedSnapshotPath)) {
      fail('drizzle-kit generate did not produce meta/0000_snapshot.json in the temp folder');
    }
    const committedSnapshot = readJson(latestCommittedSnapshotPath());
    const generatedSnapshot = readJson(generatedSnapshotPath);
    // Pin the format first: a version mismatch would otherwise surface as a
    // confusing table diff on a clean tree after a drizzle-kit upgrade.
    assertSnapshotVersion('committed', committedSnapshot);
    assertSnapshotVersion('generated', generatedSnapshot);
    const committed = canonicalSnapshot(committedSnapshot);
    const generated = canonicalSnapshot(generatedSnapshot);
    if (stableStringify(committed) !== stableStringify(generated)) {
      fail(
        [
          'Drizzle schema/migrations drift detected.',
          'The current schema does not match the latest committed migration snapshot.',
          'Run: pnpm --filter @opensip-cli/datastore db:generate',
          'Then update packages/datastore/src/schema-version.ts if the journal entry count changed.',
          `committed tables: ${snapshotTableSummary(committed).join(', ')}`,
          `generated tables: ${snapshotTableSummary(generated).join(', ')}`,
        ].join('\n'),
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  if (!statSync(MIGRATIONS_DIR).isDirectory()) {
    fail(`Missing migrations directory: ${relative(REPO_ROOT, MIGRATIONS_DIR)}`);
  }
  verifySchemaVersionLockstep();
  verifyMigrationDrift();
  console.log('[verify-drizzle-migrations] OK — schema, journal, and migrations are in sync.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[verify-drizzle-migrations] ERROR\n${message}`);
  process.exit(1);
}
