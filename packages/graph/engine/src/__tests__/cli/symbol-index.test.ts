/**
 * Coverage for `opensip-tools graph symbol-index --out <path>` — the
 * read-only artifact emitter that serializes the persisted catalog as
 * a name→{file,line,…} + file→names lookup table.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { buildArtifact, executeSymbolIndex } from '../../cli/symbol-index.js';
import { CatalogRepo } from '../../persistence/catalog-repo.js';
import { occ } from '../rules/_helpers.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';
import type { ToolCliContext } from '@opensip-tools/core';

function makeCatalog(occs: readonly FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    let bucket = functions[o.simpleName];
    if (!bucket) {
      bucket = [];
      functions[o.simpleName] = bucket;
    }
    bucket.push(o);
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'ts-test-v3',
    functions,
  };
}

interface MockCli {
  readonly cli: ToolCliContext;
  readonly setExitCode: ReturnType<typeof vi.fn>;
}

function mockCli(datastore: DataStore | undefined): MockCli {
  const setExitCode = vi.fn();
  return {
    cli: { datastore, setExitCode } as unknown as ToolCliContext,
    setExitCode,
  };
}

let datastore: DataStore;
let workDir: string;
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  workDir = mkdtempSync(join(tmpdir(), 'graph-symbol-index-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  datastore.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('graph symbol-index', () => {
  describe('buildArtifact', () => {
    it('builds bidirectional indexes from a catalog and skips module-init', () => {
      const a = occ({ bodyHash: 'a', simpleName: 'fnA', filePath: 'src/a.ts' });
      const b = occ({ bodyHash: 'b', simpleName: 'fnB', filePath: 'src/a.ts' });
      const m = occ({
        bodyHash: 'm',
        simpleName: '<module-init:src/a.ts>',
        kind: 'module-init',
        filePath: 'src/a.ts',
      });
      const artifact = buildArtifact(makeCatalog([a, b, m]));
      expect(Object.keys(artifact.symbols).sort()).toEqual(['fnA', 'fnB']);
      expect(artifact.symbols.fnA?.[0]?.bodyHash).toBe('a');
      expect([...(artifact.fileSymbols['src/a.ts'] ?? [])].sort()).toEqual(['fnA', 'fnB']);
    });

    it('dedupes the per-file name list when the same name has multiple occurrences', () => {
      const o1 = occ({ bodyHash: 'h1', simpleName: 'fn', filePath: 'src/a.ts' });
      const o2 = occ({ bodyHash: 'h2', simpleName: 'fn', filePath: 'src/a.ts' });
      const artifact = buildArtifact(makeCatalog([o1, o2]));
      expect(artifact.symbols.fn).toHaveLength(2);
      expect(artifact.fileSymbols['src/a.ts']).toEqual(['fn']);
    });
  });

  describe('executeSymbolIndex', () => {
    it('writes a JSON artifact and reports symbol/file counts', () => {
      new CatalogRepo(datastore).replaceAll(
        makeCatalog([
          occ({ bodyHash: 'h1', simpleName: 'fnA', filePath: 'src/a.ts' }),
          occ({ bodyHash: 'h2', simpleName: 'fnB', filePath: 'src/b.ts' }),
        ]),
      );
      const { cli, setExitCode } = mockCli(datastore);
      executeSymbolIndex({ cwd: workDir, out: 'out.json' }, cli);
      expect(setExitCode).toHaveBeenCalledWith(0);
      const payload = JSON.parse(readFileSync(join(workDir, 'out.json'), 'utf8')) as {
        symbols: Record<string, unknown[]>;
        fileSymbols: Record<string, unknown>;
      };
      expect(Object.keys(payload.symbols).sort()).toEqual(['fnA', 'fnB']);
      expect(Object.keys(payload.fileSymbols).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('errors with CONFIGURATION_ERROR when no catalog has been built', () => {
      const { cli, setExitCode } = mockCli(datastore);
      executeSymbolIndex({ cwd: workDir, out: 'out.json' }, cli);
      expect(setExitCode).toHaveBeenCalledWith(2);
    });

    it('errors with CONFIGURATION_ERROR when no DataStore is wired', () => {
      const { cli, setExitCode } = mockCli(undefined);
      executeSymbolIndex({ cwd: workDir, out: 'out.json' }, cli);
      expect(setExitCode).toHaveBeenCalledWith(2);
    });
  });
});
