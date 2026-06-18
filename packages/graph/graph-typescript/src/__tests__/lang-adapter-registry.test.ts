/**
 * Unit tests for the language-adapter registry's `pickAdapter` heuristic.
 *
 * PR 6 of plan docs/plans/10-graph-language-pluggability.md introduced
 * file-extension dominance counting when ≥ 2 adapters are registered.
 * These tests cover the dominance heuristic + tie-breaking preference
 * order.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, RunScope, runWithScopeSync , applyToolContributeScope} from '@opensip-cli/core';
import { currentAdapterRegistry, graphTool, pickAdapter } from '@opensip-cli/graph';
import { pythonGraphAdapter } from '@opensip-cli/graph-python';
import { rustGraphAdapter } from '@opensip-cli/graph-rust';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { typescriptGraphAdapter } from '../index.js';

function makeGraphScope(): RunScope {
  const scope = new RunScope();
  applyToolContributeScope(scope, graphTool);
  return scope;
}

describe('pickAdapter — registry-size shortcuts', () => {
  let scope: RunScope;

  beforeEach(() => {
    // Item 1: adapter registry is per-RunScope. Fresh scope per test.
    scope = makeGraphScope();
  });

  afterEach(() => {
    runWithScopeSync(scope, () => currentAdapterRegistry().clear());
  });

  it('throws when no adapter is registered', () => {
    runWithScopeSync(scope, () => {
      expect(() => pickAdapter()).toThrow(ConfigurationError);
    });
  });

  it('returns the only adapter when exactly one is registered', () => {
    runWithScopeSync(scope, () => {
      currentAdapterRegistry().register(rustGraphAdapter);
      const picked = pickAdapter('/tmp');
      expect(picked.id).toBe('rust');
    });
  });

  it('falls back to alphabetical order when no preferred adapter is registered', () => {
    // Register only non-typescript adapters; tie between python and rust.
    // resolveTie's preference list contains 'python' first, so it wins.
    // Then drop 'python' and only register rust → falls through to
    // alphabetical sort, picks rust.
    const dir = mkdtempSync(join(tmpdir(), 'graph-pick-fb-'));
    try {
      runWithScopeSync(scope, () => {
        currentAdapterRegistry().register(rustGraphAdapter);
        // Write only an unrelated file so the dominance counter sees no
        // matches and findMaxCount returns null.
        writeFileSync(join(dir, 'README.md'), '', 'utf8');
        const picked = pickAdapter(dir);
        expect(picked.id).toBe('rust');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Register the three adapters covered by this dominance test into the CURRENT
 * scope.
 * Lives at module scope (rather than inside a describe block) for
 * eslint's consistent-function-scoping rule. Called from each test
 * body in the dominance-heuristic block: vitest's hook → test
 * transition can swap async contexts, so adapters registered in a
 * beforeEach don't reliably reach the body. Re-register inside each
 * test for stability.
 */
function registerAllThreeAdapters(): void {
  currentAdapterRegistry().register(typescriptGraphAdapter);
  currentAdapterRegistry().register(pythonGraphAdapter);
  currentAdapterRegistry().register(rustGraphAdapter);
}

describe('pickAdapter — multi-adapter dominance heuristic', () => {
  let dir: string;
  let scope: RunScope;

  beforeEach(() => {
    // Item 1: adapter registry is per-RunScope. Fresh scope per test.
    scope = makeGraphScope();
    dir = mkdtempSync(join(tmpdir(), 'graph-pick-'));
  });

  afterEach(() => {
    runWithScopeSync(scope, () => currentAdapterRegistry().clear());
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks Python when only .py files are present', () => {
    runWithScopeSync(scope, () => {
      registerAllThreeAdapters();
      writeFileSync(join(dir, 'a.py'), 'def foo(): pass\n', 'utf8');
      writeFileSync(join(dir, 'b.py'), 'def bar(): pass\n', 'utf8');
      const adapter = pickAdapter(dir);
      expect(adapter.id).toBe('python');
    });
  });

  it('picks Rust when only .rs files are present', () => {
    runWithScopeSync(scope, () => {
      registerAllThreeAdapters();
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/lib.rs'), 'fn foo() {}\n', 'utf8');
      writeFileSync(join(dir, 'src/main.rs'), 'fn main() {}\n', 'utf8');
      const adapter = pickAdapter(dir);
      expect(adapter.id).toBe('rust');
    });
  });

  it('picks the dominant language when multiple are present', () => {
    runWithScopeSync(scope, () => {
      registerAllThreeAdapters();
      // 3 .py files, 1 .rs file -> Python wins.
      writeFileSync(join(dir, 'a.py'), 'pass', 'utf8');
      writeFileSync(join(dir, 'b.py'), 'pass', 'utf8');
      writeFileSync(join(dir, 'c.py'), 'pass', 'utf8');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/lib.rs'), 'fn foo() {}', 'utf8');
      expect(pickAdapter(dir).id).toBe('python');
    });
  });

  it('breaks ties by preferring TypeScript', () => {
    runWithScopeSync(scope, () => {
      registerAllThreeAdapters();
      // 1 .ts and 1 .py file -> tie at 1; TypeScript wins.
      writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src/index.ts'), 'export {};\n', 'utf8');
      writeFileSync(join(dir, 'a.py'), 'pass', 'utf8');
      expect(pickAdapter(dir).id).toBe('typescript');
    });
  });

  it('falls back to TypeScript when no language files match', () => {
    runWithScopeSync(scope, () => {
      registerAllThreeAdapters();
      // Empty dir: heuristic returns no winner; preference list picks TS.
      expect(pickAdapter(dir).id).toBe('typescript');
    });
  });

  it('ignores excluded directories when counting', () => {
    runWithScopeSync(scope, () => {
      registerAllThreeAdapters();
      mkdirSync(join(dir, 'target'), { recursive: true });
      writeFileSync(join(dir, 'target/cached.rs'), 'fn x() {}', 'utf8');
      writeFileSync(join(dir, 'a.py'), 'pass', 'utf8');
      expect(pickAdapter(dir).id).toBe('python');
    });
  });
});
