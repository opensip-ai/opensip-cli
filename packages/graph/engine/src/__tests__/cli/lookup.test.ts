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
  it('renders occurrences for a name found in the catalog through the seam', async () => {
    new CatalogRepo(datastore).replaceAll(
      makeCatalog([occ({ bodyHash: 'a1', simpleName: 'saveBaseline' })]),
    );
    const cli = mockCli(datastore);
    await executeLookup({ name: 'saveBaseline' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(0);
    // Human output flows through cli.render (a graph-status result), not stdout.
    expect(cli.render).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'graph-status' }),
    );
    const output = cli.renderedText();
    expect(output).toContain('saveBaseline');
    expect(output).toContain('1 occurrence');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('emits structured JSON to stdout when --json is set (bypasses the seam)', async () => {
    new CatalogRepo(datastore).replaceAll(
      makeCatalog([occ({ bodyHash: 'a1', simpleName: 'fn' })]),
    );
    const cli = mockCli(datastore);
    await executeLookup({ name: 'fn', json: true }, cli.cli);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(output) as { name: string; matches: unknown[] };
    expect(parsed.name).toBe('fn');
    expect(parsed.matches).toHaveLength(1);
    // The machine path does not go through the render seam.
    expect(cli.render).not.toHaveBeenCalled();
  });

  it('exits SUCCESS with a "not found" message when the name has no occurrences', async () => {
    new CatalogRepo(datastore).replaceAll(makeCatalog([]));
    const cli = mockCli(datastore);
    await executeLookup({ name: 'missing' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(0);
    expect(cli.renderedText()).toContain("No function named 'missing'");
  });

  it('errors with CONFIGURATION_ERROR when no catalog has been built', async () => {
    const cli = mockCli(datastore);
    await executeLookup({ name: 'anything' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(2);
    const errOut = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(errOut).toContain('Run `opensip-tools graph` first');
  });

  it('errors with CONFIGURATION_ERROR when no DataStore is wired', async () => {
    const cli = mockCli(undefined);
    await executeLookup({ name: 'fn' }, cli.cli);
    expect(cli.setExitCode).toHaveBeenCalledWith(2);
  });
});
