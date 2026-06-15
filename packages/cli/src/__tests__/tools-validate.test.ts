/**
 * `tools validate` section coverage (plan phase 7.1/7.6): the storage
 * fixtures fail exactly the storage/import sections; the Tier A pattern
 * vocabulary is self-tested per documented clause; bundled tools pass the
 * full validation unchanged — the ADR-0042 parity pin ("if they don't pass,
 * the contract is wrong, not the tools").
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  runStorageContractChecks,
  TIER_A_PATTERNS,
} from '../commands/tools/storage-contract-checks.js';
import { runToolValidation } from '../commands/tools/validate.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Write a minimal conformant tool package whose index.js carries `body`. */
function fixtureWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ost-storage-fixture-'));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: '@opensip-cli-fixture/storage-case',
      version: '0.0.0',
      private: true,
      type: 'module',
      main: './index.js',
      opensipTools: {
        kind: 'tool',
        id: 'storage-case',
        apiVersion: 1,
        commands: [{ name: 'storage-case-cmd', description: 'noop' }],
      },
    }),
  );
  writeFileSync(join(dir, 'index.js'), body);
  return dir;
}

describe('Tier A storage-contract scan (ADR-0042)', () => {
  it('flags every documented pattern family', () => {
    const cases: readonly { body: string; clauseIncludes: string }[] = [
      { body: 'const q = "CREATE TABLE evil (id int)";', clauseIncludes: 'no DDL' },
      { body: 'const q = "DROP TABLE tool_state";', clauseIncludes: 'no DDL' },
      { body: 'const q = "CREATE UNIQUE INDEX ix ON t(c)";', clauseIncludes: 'no DDL' },
      { body: 'const p = "PRAGMA writable_schema = 1";', clauseIncludes: 'pragmas' },
      { body: 'const f = ".runtime/datastore.sqlite";', clauseIncludes: 'datastore-file' },
      {
        body: 'import { x } from "@opensip-cli/datastore/schema/baseline.js";',
        clauseIncludes: 'imports',
      },
      {
        body: 'import { migrate } from "drizzle-orm/better-sqlite3/migrator";',
        clauseIncludes: 'runners',
      },
    ];
    for (const c of cases) {
      const findings = runStorageContractChecks(fixtureWith(c.body));
      expect(findings.length, `body: ${c.body}`).toBeGreaterThan(0);
      expect(findings.some((f) => f.clause.includes(c.clauseIncludes))).toBe(true);
    }
  });

  it('skips test files — Tier A gates the shippable surface', () => {
    const dir = fixtureWith('export const tool = undefined;');
    mkdirSync(join(dir, '__tests__'), { recursive: true });
    writeFileSync(join(dir, '__tests__', 'evil.test.js'), 'const q = "CREATE TABLE t (i int)";');
    writeFileSync(join(dir, 'thing.test.js'), 'const q = "DROP TABLE t";');
    expect(runStorageContractChecks(dir)).toEqual([]);
  });

  it('a clean package produces zero findings', () => {
    expect(runStorageContractChecks(fixtureWith('export const tool = undefined;'))).toEqual([]);
  });

  it('the pattern vocabulary itself is pinned (drift check)', () => {
    // The clause set is the contract; a silently-dropped family fails here.
    const clauses = [...new Set(TIER_A_PATTERNS.map((p) => p.clause))].sort();
    expect(clauses).toEqual(
      [
        'no DDL against the OpenSIP datastore (ADR-0042 Tier A)',
        'no schema-mutation pragmas (ADR-0042 Tier A)',
        'no direct datastore-file access (ADR-0042 Tier A)',
        'no datastore-private schema/migration imports (ADR-0042 Tier A)',
        'no migration runners against the OpenSIP datastore (ADR-0042 Tier A)',
      ].sort(),
    );
  });
});

describe('validate verdicts over the storage fixtures', () => {
  it('a DDL-carrying tool fails the storage-contract section (verdict failed)', async () => {
    const dir = fixtureWith(
      'export const tool = { metadata: { id: "storage-case", name: "s", version: "0.0.0", description: "d" }, commands: [{ name: "storage-case-cmd", description: "noop" }], commandSpecs: [{ name: "storage-case-cmd", description: "noop", commonFlags: [], output: "raw-stream", rawStreamReason: "fixture", flags: [], handler: () => Promise.resolve() }], apiVersion: 1 };\nconst q = "CREATE TABLE evil (id int)";',
    );
    const { result } = await runToolValidation({ spec: dir, cwd: process.cwd() });
    expect(result.verdict).toBe('failed');
    const storage = result.sections.find((s) => s.name === 'storage-contract');
    expect(storage?.status).toBe('failed');
  });
});

describe('validate — incomplete verdict (in-place candidate, deps not installed)', () => {
  it('skips the runtime sections and returns incomplete when the module needs an uninstalled dep', async () => {
    // A valid manifest (static admission passes) whose module top-level imports
    // a dependency that is not installed — exactly the in-place, no-install-deps
    // case the validator classifies as an EXPECTED missing dep (skip, not fail).
    const dir = fixtureWith(
      "import 'totally-missing-dep-xyz-12345';\nexport const tool = undefined;",
    );
    const { result } = await runToolValidation({ spec: dir, cwd: process.cwd() });
    expect(result.verdict).toBe('incomplete');
    const runtimeLoad = result.sections.find((s) => s.name === 'runtime-load');
    expect(runtimeLoad?.status).toBe('skipped');
    expect(runtimeLoad?.diagnostics.join(' ')).toMatch(/--install-deps/);
  }, 60_000);
});

describe('validate — local directory staged via --install-deps', () => {
  it('installs the local candidate into a temp host and validates the installed copy', async () => {
    // installDeps forces the temp-host npm-install staging path (stagedByInstall
    // true) even for a local dir, so the runtime sections run against resolved
    // deps rather than being skipped.
    const dir = fixtureWith('export const tool = undefined;');
    const { result } = await runToolValidation({
      spec: dir,
      cwd: process.cwd(),
      installDeps: true,
    });
    expect(['passed', 'failed', 'incomplete']).toContain(result.verdict);
    // The runtime sections were attempted (not the in-place "skipped" set).
    expect(result.sections.find((s) => s.name === 'runtime-load')?.status).not.toBe('skipped');
  }, 60_000);
});

describe('validate — staging failure', () => {
  it('returns a single failed staging section when the spec cannot be installed', async () => {
    // Not a local directory → staged via temp-host npm install, which fails
    // locally (ENOENT) for a non-existent tarball path — no network needed.
    const { result } = await runToolValidation({
      spec: '/nonexistent/path/to/tool-xyz.tgz',
      cwd: process.cwd(),
    });
    expect(result.verdict).toBe('failed');
    expect(result.sections).toEqual([
      expect.objectContaining({ name: 'staging', status: 'failed' }),
    ]);
  }, 60_000);
});

describe('bundled tools pass tools validate unchanged (ADR-0042 parity pin)', () => {
  const requireFromHere = createRequire(import.meta.url);
  const bundledDir = (pkg: string): string => {
    // Same walk-up technique as register-tools' resolveBundledPackageDir.
    let dir = dirname(requireFromHere.resolve(pkg));
    for (let i = 0; i < 50; i++) {
      try {
        const json = requireFromHere(join(dir, 'package.json')) as { name?: string };
        if (json.name === pkg) return dir;
      } catch {
        /* keep climbing */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`could not resolve package dir for ${pkg}`);
  };

  it.each(['@opensip-cli/fitness', '@opensip-cli/simulation', '@opensip-cli/graph'])(
    '%s passes every section',
    async (pkg) => {
      const { result } = await runToolValidation({ spec: bundledDir(pkg), cwd: process.cwd() });
      expect(
        result.sections
          .filter((s) => s.status === 'failed')
          .map((s) => `${s.name}: ${s.diagnostics.join('; ')}`),
      ).toEqual([]);
      expect(result.verdict).toBe('passed');
    },
    60_000,
  );
});
