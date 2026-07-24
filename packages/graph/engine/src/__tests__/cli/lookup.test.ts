/**
 * Coverage for `opensip graph lookup <name>` — the read-only
 * catalog query that mirrors codeindex's symbol lookup at function
 * granularity.
 */

import { ConfigurationError } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { executeLookup } from '../../cli/lookup.js';
import { CatalogRepo } from '../../persistence/catalog-repo.js';
import { makeReportFailureMock } from '../report-failure-mock.js';
import { occ } from '../rules/_helpers.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';
import type { ToolCliContext } from '@opensip-cli/core';

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
  readonly render: ReturnType<typeof vi.fn>;
  readonly reportFailure: ReturnType<typeof makeReportFailureMock>;
}

function mockCli(datastore: DataStore | undefined): MockCli {
  const setExitCode = vi.fn();
  const render = vi.fn().mockResolvedValue(undefined);
  const reportFailure = makeReportFailureMock(setExitCode, render);
  return {
    cli: {
      datastore,
      setExitCode,
      render,
      reportFailure,
      scope: { datastore: () => datastore },
    } as unknown as ToolCliContext,
    setExitCode,
    render,
    reportFailure,
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
  it('renders occurrences for a name found in the catalog through the seam', () => {
    new CatalogRepo(datastore).replaceAll(
      makeCatalog([occ({ bodyHash: 'a1', simpleName: 'saveBaseline' })]),
    );
    const cli = mockCli(datastore);
    const result = executeLookup({ name: 'saveBaseline' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(0);
    expect(result).toMatchObject({ type: 'graph-status' });
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns a graph-lookup result when --json is set (no direct stdout)', () => {
    new CatalogRepo(datastore).replaceAll(makeCatalog([occ({ bodyHash: 'a1', simpleName: 'fn' })]));
    const cli = mockCli(datastore);
    const result = executeLookup({ name: 'fn', json: true }, cli.cli);
    expect(result).toMatchObject({
      type: 'graph-lookup',
      name: 'fn',
      resolutionMode: 'exact',
    });
    if (result?.type !== 'graph-lookup') throw new Error('expected graph-lookup result');
    expect(result.matches).toHaveLength(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('exits SUCCESS with a "not found" message when the name has no occurrences', () => {
    new CatalogRepo(datastore).replaceAll(makeCatalog([]));
    const cli = mockCli(datastore);
    const result = executeLookup({ name: 'missing' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(0);
    expect(result).toMatchObject({ type: 'graph-status' });
    expect((result as { lines: readonly string[] }).lines.join('\n')).toContain(
      "No function named 'missing'",
    );
  });

  // Regression: `catalog.functions` is a plain object deserialized from
  // persisted JSON, so a bare `catalog.functions[name]` lookup for an
  // Object.prototype member name resolves the inherited value instead of
  // `undefined` — e.g. 'constructor' resolves to the `Object` function,
  // which then fails `.map`/iteration downstream with a confusing
  // SystemError instead of a clean "No function named 'constructor'".
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    "exits SUCCESS with a 'not found' message for the Object.prototype member name %s",
    (name) => {
      new CatalogRepo(datastore).replaceAll(makeCatalog([]));
      const cli = mockCli(datastore);
      const result = executeLookup({ name }, cli.cli);
      expect(cli.setExitCode).toHaveBeenCalledWith(0);
      expect(result).toMatchObject({ type: 'graph-status' });
      expect((result as { lines: readonly string[] }).lines.join('\n')).toContain(
        `No function named '${name}'`,
      );
    },
  );

  it("returns an empty matches array (not a crash) for --json lookup of 'constructor'", () => {
    new CatalogRepo(datastore).replaceAll(makeCatalog([]));
    const cli = mockCli(datastore);
    const result = executeLookup({ name: 'constructor', json: true }, cli.cli);
    expect(result).toMatchObject({ type: 'graph-lookup', name: 'constructor' });
    if (result?.type !== 'graph-lookup') throw new Error('expected graph-lookup result');
    expect(result.matches).toEqual([]);
  });

  it('throws a typed configuration error when the catalog is missing', () => {
    const cli = mockCli(datastore);
    expect(() => executeLookup({ name: 'anything' }, cli.cli)).toThrow(ConfigurationError);
    expect(cli.reportFailure).not.toHaveBeenCalled();
    expect(cli.setExitCode).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('throws a typed configuration error when the DataStore is missing', () => {
    const cli = mockCli(undefined);
    expect(() => executeLookup({ name: 'fn' }, cli.cli)).toThrow(ConfigurationError);
    expect(cli.reportFailure).not.toHaveBeenCalled();
    expect(cli.setExitCode).not.toHaveBeenCalled();
  });
});
