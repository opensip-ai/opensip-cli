import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The check is an ESM project-local fitness check; import via dynamic path.
const checkUrl = new URL(
  '../../opensip-cli/fit/checks/restrict-raw-db-access.mjs',
  import.meta.url,
);
const mod = await import(checkUrl.href);

describe('restrict-raw-db-access analyzer', () => {
  it('flags public transaction escape outside persistence boundary', () => {
    const v = mod.analyzeRawDbAccess(
      'const ds = scope.datastore();\nds.transaction((tx) => tx.select());\n',
      'packages/cli/src/bootstrap/evil.ts',
    );
    assert.ok(v.length > 0);
    assert.ok(v.some((x) => /transaction/i.test(x.message)));
  });

  it('flags scope.datastore().transaction', () => {
    const v = mod.analyzeRawDbAccess(
      'currentScope()?.datastore().transaction((tx) => 1);\n',
      'packages/fitness/engine/src/cli/bad.ts',
    );
    assert.ok(v.length > 0);
  });

  it('allows owner persistence transaction usage', () => {
    const v = mod.analyzeRawDbAccess(
      'this.datastore.transaction((tx) => { tx.insert(table); });\n',
      'packages/datastore/src/baseline-repo.ts',
    );
    assert.equal(v.length, 0);
  });

  it('does not flag domain repository.transaction(work) delegation', () => {
    const v = mod.analyzeRawDbAccess(
      'return this.repository.transaction(work);\nawait this.repository.transaction(async () => 1);\n',
      'packages/cli/src/bootstrap/service.ts',
    );
    assert.equal(v.length, 0);
  });

  it('flags requireDrizzleHandle outside boundary', () => {
    const v = mod.analyzeRawDbAccess(
      "import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';\nconst h = requireDrizzleHandle(ds);\n",
      'packages/cli/src/bootstrap/evil.ts',
    );
    assert.ok(v.some((x) => /requireDrizzleHandle/.test(x.message)));
  });
});
