import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, SystemError } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { describe, expect, it, vi } from 'vitest';

import { CatalogRepo } from '../../persistence/catalog-repo.js';
import { graphImpactCommandSpec } from '../graph/graph-aux-command-specs.js';
import { executeImpact } from '../impact.js';

import type { Catalog } from '../../types.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-22T00:00:00.000Z',
    cacheKey: 'ts-test',
    filesFingerprint: '0\n',
    functions: {
      callee: [
        {
          bodyHash: 'callee',
          simpleName: 'callee',
          qualifiedName: 'callee',
          filePath: 'src/callee.ts',
          line: 1,
          column: 0,
          endLine: 5,
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
      caller: [
        {
          bodyHash: 'caller',
          simpleName: 'caller',
          qualifiedName: 'caller',
          filePath: 'src/caller.ts',
          line: 1,
          column: 0,
          endLine: 8,
          kind: 'function-declaration',
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          calls: [
            {
              to: ['callee'],
              line: 2,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'callee()',
            },
          ],
        },
      ],
    },
    ...over,
  };
}

function mockCli(datastore?: DataStore): ToolCliContext {
  return {
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    deliverSignals: vi.fn().mockResolvedValue({ cloudAccepted: 0 }),
    render: vi.fn().mockResolvedValue(undefined),
    scope: { datastore: () => datastore },
  } as unknown as ToolCliContext;
}

describe('executeImpact', () => {
  it('--files works without git and returns graph-impact result', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
      },
      cli,
    );
    expect(result.type).toBe('graph-impact');
    expect(result.changedFiles).toContain('src/callee.ts');
    expect(result.changedFunctions.some((f) => f.qualifiedName === 'callee')).toBe(true);
    expect(result.recommendedCommands.length).toBeGreaterThan(0);
    expect(cli.emitJson).toHaveBeenCalledWith(result);
    const delivered = (
      cli.deliverSignals as unknown as {
        mock: { calls: [[SignalEnvelope, unknown]] };
      }
    ).mock.calls[0]?.[0];
    expect(delivered?.tool).toBe('graph');
    expect(delivered?.signals).toHaveLength(1);
    expect(delivered?.signals[0]?.ruleId).toBe('graph.impact.blast-radius');
    expect(delivered?.signals[0]?.metadata.blastRadius).toMatchObject({
      dependents: 1,
      impactedFiles: 1,
      confidence: 'high',
    });
    expect(delivered?.verdict).toMatchObject({
      passed: true,
      summary: { errors: 0, warnings: 1 },
    });
    datastore.close();
  });

  it('--json --raw emits the raw graph-impact payload', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        raw: true,
        files: ['src/callee.ts'],
      },
      cli,
    );
    expect(cli.emitRaw).toHaveBeenCalledWith(result);
    expect(cli.emitJson).not.toHaveBeenCalled();
    datastore.close();
  });

  it('renders human impact lines and the truncation hint outside JSON mode', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        files: ['src/callee.ts'],
        top: '1',
      },
      cli,
    );
    expect(result.truncated).toBe(true);
    const renderCalls = (cli.render as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const rendered = renderCalls[0]?.[0] as { lines?: readonly string[] } | undefined;
    expect(rendered?.lines?.some((line) => line.includes('truncated'))).toBe(true);
    expect(rendered?.lines?.some((line) => line.includes('Recommended next commands'))).toBe(true);
    datastore.close();
  });

  it('--changed outside a git repo throws ConfigurationError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-impact-nogit-'));
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    await expect(
      executeImpact({ cwd: dir, json: true, changed: true }, cli),
    ).rejects.toBeInstanceOf(ConfigurationError);
    datastore.close();
  });

  it('requires an explicit changed-file basis', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    await expect(executeImpact({ cwd: '/proj', json: true }, cli)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    datastore.close();
  });

  it('requires a datastore on the CLI context', async () => {
    const cli = mockCli();
    await expect(
      executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'] }, cli),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('wraps unexpected context failures as SystemError', async () => {
    const cli = {
      setExitCode: vi.fn(),
      emitJson: vi.fn(),
      emitRaw: vi.fn(),
      render: vi.fn().mockResolvedValue(undefined),
      scope: {
        datastore: () => {
          throw new Error('scope exploded');
        },
      },
    } as unknown as ToolCliContext;

    let caught: unknown;
    try {
      await executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'] }, cli);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SystemError);
    expect((caught as Error).message).toContain('scope exploded');
  });

  it('rejects path traversal in --files (matches nothing, no filesystem read)', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: mkdtempSync(join(tmpdir(), 'opensip-impact-traversal-')),
        json: true,
        files: ['../../etc/passwd'],
      },
      cli,
    );
    expect(result.changedFunctions).toHaveLength(0);
    expect(result.impactedFunctions).toHaveLength(0);
    datastore.close();
  });

  it('applies --top cap and sets truncated', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
        top: '1',
      },
      cli,
    );
    expect(result.truncated).toBe(true);
    datastore.close();
  });

  it('rejects invalid --top values before emitting output', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    await expect(
      executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'], top: 'abc' }, cli),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(cli.emitJson).not.toHaveBeenCalled();
    datastore.close();
  });

  it('declares --files as a repeatable parser on the command spec', () => {
    const filesOption = graphImpactCommandSpec.options?.find((option) => option.flag === '--files');
    expect(filesOption?.arrayDefault).toEqual([]);
    expect(filesOption?.parse?.('src/a.ts', [])).toEqual(['src/a.ts']);
    expect(filesOption?.parse?.('src/b.ts', ['src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('declares graph impact as a verdict-producing command for suites', () => {
    expect(graphImpactCommandSpec.producesVerdict).toBe(true);
  });
});
