/**
 * `graph-shard-worker` — the per-shard build subprocess entry
 * (`executeShardWorker`). It reads a `ShardWorkerSpec` JSON file, runs
 * the build over the shard's files via the scope's language adapter, and
 * writes a `ShardBuildResult` JSON to stdout, exiting 0. A bad spec path
 * (or any build error) is attributed to the shard: stderr names it and
 * the exit code is 1.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enterScope, LanguageRegistry } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { makeGraphTestScope } from '../../__tests__/test-utils/with-graph-scope.js';
import { currentAdapterRegistry } from '../../lang-adapter/registry.js';
import { executeShardWorker } from '../shard-worker.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../lang-adapter/types.js';
import type { ShardBuildResult, ShardWorkerSpec } from '../orchestrate/shard-model.js';
import type { ToolCliContext } from '@opensip-cli/core';

function fakeAdapter(id = 'typescript', fileExtension = '.ts'): GraphLanguageAdapter {
  return {
    id,
    fileExtensions: [fileExtension],
    displayName: 'Fake',
    discoverFiles: (): DiscoverOutput => ({
      projectDirAbs: '/unused',
      files: [],
      configPathAbs: undefined,
      compilerOptions: undefined,
    }),
    parseProject: (): ParseOutput => ({ project: { dummy: true }, parseErrors: [] }),
    walkProject: (): WalkOutput => ({
      occurrences: {
        fn: [
          {
            bodyHash: 'h1',
            simpleName: 'fn',
            qualifiedName: `pkg/a.${id}.fn`,
            filePath: `pkg/a${fileExtension}`,
            line: 1,
            column: 0,
            endLine: 2,
            kind: 'function-declaration',
            params: [],
            returnType: null,
            enclosingClass: null,
            decorators: [],
            visibility: 'exported',
            inTestFile: false,
            definedInGenerated: false,
            calls: [],
          },
        ],
      },
      callSites: [],
      parseErrors: [],
    }),
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: new Map([['h1', []]]),
      stats: {
        totalCallSites: 0,
        resolvedHigh: 0,
        resolvedMedium: 0,
        resolvedLow: 0,
        unresolved: 0,
      },
    }),
    cacheKey: () => `fake-shard-v1:${id}`,
  };
}

function mockCli(): { cli: ToolCliContext; setExitCode: MockInstance } {
  const setExitCode = vi.fn();
  return {
    cli: {
      setExitCode,
      scope: { languages: new LanguageRegistry() },
    } as unknown as ToolCliContext,
    setExitCode,
  };
}

let dir: string;
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;
let stdout = '';
let stderr = '';

beforeEach(() => {
  enterScope(makeGraphTestScope());
  dir = mkdtempSync(join(tmpdir(), 'shard-worker-'));
  stdout = '';
  stderr = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
    stdout += typeof c === 'string' ? c : c.toString();
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    stderr += typeof c === 'string' ? c : c.toString();
    return true;
  });
});

afterEach(() => {
  currentAdapterRegistry().clear();
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

describe('executeShardWorker', () => {
  it('builds the shard and emits a ShardBuildResult JSON on stdout, exit 0', async () => {
    currentAdapterRegistry().register(fakeAdapter());
    const specPath = join(dir, 'spec.json');
    const spec: ShardWorkerSpec = {
      shard: { id: 'pkg:a', rootDir: dir, files: ['pkg/a.ts'] },
      projectRoot: dir,
      resolutionMode: 'exact',
    };
    writeFileSync(specPath, JSON.stringify(spec), 'utf8');

    const { cli, setExitCode } = mockCli();
    await executeShardWorker(specPath, cli);

    expect(setExitCode).toHaveBeenCalledWith(0);
    const result = JSON.parse(stdout) as ShardBuildResult;
    expect(result.shardId).toBe('pkg:a');
    expect(result.fragment.language).toBe('typescript');
    expect(result.fragment.functions.fn).toHaveLength(1);
    expect(result.fingerprint).toContain('pkg/a.ts');
    expect(result.boundaryCalls).toEqual([]);
    expect(result.parseErrors).toEqual([]);
  });

  it('honors the explicit language in the shard spec when selecting an adapter', async () => {
    currentAdapterRegistry().register(fakeAdapter('typescript', '.ts'));
    currentAdapterRegistry().register(fakeAdapter('python', '.py'));
    const specPath = join(dir, 'spec.json');
    const spec: ShardWorkerSpec = {
      shard: { id: 'pkg:a', rootDir: dir, files: ['pkg/a.py'] },
      projectRoot: dir,
      language: 'python',
      resolutionMode: 'exact',
    };
    writeFileSync(specPath, JSON.stringify(spec), 'utf8');

    const { cli, setExitCode } = mockCli();
    await executeShardWorker(specPath, cli);

    expect(setExitCode).toHaveBeenCalledWith(0);
    const result = JSON.parse(stdout) as ShardBuildResult;
    expect(result.fragment.language).toBe('python');
    expect(result.fragment.cacheKey).toContain('python');
    expect(result.fingerprint).toContain('pkg/a.py');
  });

  it('attributes a read/parse failure to the shard: stderr names it, exit 1', async () => {
    currentAdapterRegistry().register(fakeAdapter());
    // Spec file does not exist → readFileSync throws inside the worker.
    const { cli, setExitCode } = mockCli();
    await executeShardWorker(join(dir, 'missing.json'), cli);

    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(stderr).toContain('graph-shard-worker');
    expect(stdout).toBe('');
  });
});
