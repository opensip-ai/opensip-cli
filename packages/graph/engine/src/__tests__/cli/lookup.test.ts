/**
 * Coverage for `opensip-tools graph lookup <name>` — the read-only
 * catalog query that mirrors codeindex's symbol lookup at function
 * granularity.
 */

import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { executeLookup } from '../../cli/lookup.js';
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
let stdoutSpy: MockInstance<typeof process.stdout.write>;
let stderrSpy: MockInstance<typeof process.stderr.write>;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  datastore.close();
});

describe('graph lookup', () => {
  it('prints occurrences for a name found in the catalog', () => {
    new CatalogRepo(datastore).replaceAll(
      makeCatalog([occ({ bodyHash: 'a1', simpleName: 'saveBaseline' })]),
    );
    const { cli, setExitCode } = mockCli(datastore);
    executeLookup({ name: 'saveBaseline' }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain('saveBaseline');
    expect(output).toContain('1 occurrence');
  });

  it('emits structured JSON when --json is set', () => {
    new CatalogRepo(datastore).replaceAll(
      makeCatalog([occ({ bodyHash: 'a1', simpleName: 'fn' })]),
    );
    const { cli } = mockCli(datastore);
    executeLookup({ name: 'fn', json: true }, cli);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output) as { name: string; matches: unknown[] };
    expect(parsed.name).toBe('fn');
    expect(parsed.matches).toHaveLength(1);
  });

  it('exits SUCCESS with a "not found" message when the name has no occurrences', () => {
    new CatalogRepo(datastore).replaceAll(makeCatalog([]));
    const { cli, setExitCode } = mockCli(datastore);
    executeLookup({ name: 'missing' }, cli);
    expect(setExitCode).toHaveBeenCalledWith(0);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(output).toContain("No function named 'missing'");
  });

  it('errors with CONFIGURATION_ERROR when no catalog has been built', () => {
    const { cli, setExitCode } = mockCli(datastore);
    executeLookup({ name: 'anything' }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
    const errOut = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(errOut).toContain('Run `opensip-tools graph` first');
  });

  it('errors with CONFIGURATION_ERROR when no DataStore is wired', () => {
    const { cli, setExitCode } = mockCli(undefined);
    executeLookup({ name: 'fn' }, cli);
    expect(setExitCode).toHaveBeenCalledWith(2);
  });
});
