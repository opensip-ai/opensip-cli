/**
 * Coverage for `opensip graph lookup <name>` — the read-only
 * catalog query that mirrors codeindex's symbol lookup at function
 * granularity.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { executeLookup } from '../../cli/lookup.js';
import { CatalogRepo } from '../../persistence/catalog-repo.js';
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
  /** Concatenated text of every `graph-status` result rendered through the seam. */
  renderedText(): string;
}

function mockCli(datastore: DataStore | undefined): MockCli {
  const setExitCode = vi.fn();
  const render = vi.fn().mockResolvedValue(undefined);
  return {
    cli: {
      datastore,
      setExitCode,
      render,
      scope: { datastore: () => datastore },
    } as unknown as ToolCliContext,
    setExitCode,
    render,
    renderedText: () =>
      render.mock.calls
        .map((c) => (c[0] as { lines?: readonly string[] }).lines?.join('\n') ?? '')
        .join('\n'),
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
    expect(cli.render).not.toHaveBeenCalled();
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
    if (result.type !== 'graph-lookup') throw new Error('expected graph-lookup result');
    expect(result.matches).toHaveLength(1);
    expect(cli.render).not.toHaveBeenCalled();
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

  it('returns ErrorResult with CONFIGURATION_ERROR when no catalog has been built', () => {
    const cli = mockCli(datastore);
    const result = executeLookup({ name: 'anything' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({
      type: 'error',
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    });
    expect((result as { message: string }).message).toContain('Run `opensip graph` first');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns ErrorResult with CONFIGURATION_ERROR when no DataStore is wired', () => {
    const cli = mockCli(undefined);
    const result = executeLookup({ name: 'fn' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(2);
    expect(result).toMatchObject({ type: 'error', exitCode: EXIT_CODES.CONFIGURATION_ERROR });
  });
});
