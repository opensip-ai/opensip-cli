import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import {
  assessContextGraphCoverage,
  produceContextTestSelection,
} from '../../cli/context/context-producers.js';
import { graphInputFilesIdentity } from '../../cli/orchestrate/catalog-build-coverage.js';
import { createContextRunState } from '../../context-run-state.js';
import { catalogGenerationKey } from '../../read/index.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';
import type { ProjectInventorySnapshot } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

function occurrence(
  bodyHash: string,
  filePath: string,
  over: Partial<FunctionOccurrence> = {},
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName: bodyHash,
    qualifiedName: bodyHash,
    filePath,
    line: 1,
    column: 0,
    endLine: 3,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

function catalog(filesFingerprint = 'fingerprint'): Catalog {
  const production = occurrence('production', 'src/work.ts');
  const test = occurrence('test', 'src/work.test.ts', {
    inTestFile: true,
    calls: [
      {
        to: ['production'],
        line: 2,
        column: 1,
        resolution: 'static',
        confidence: 'high',
        text: 'work()',
      },
    ],
  });
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-13T00:00:00.000Z',
    cacheKey: 'cache',
    filesFingerprint,
    adapterSelection: { mode: 'auto', selectedId: 'typescript' },
    buildCoverage: {
      status: 'complete',
      discoveredFiles: 2,
      parseErrorFiles: 0,
      filesIdentity: graphInputFilesIdentity(['src/work.ts', 'src/work.test.ts']),
    },
    functions: { production: [production], test: [test] },
  };
}

function inventory(snapshotId: string): ProjectInventorySnapshot {
  const digest = createHash('sha256').update(snapshotId).digest('hex');
  const identity = `i1:${digest}`;
  return {
    schemaVersion: 1,
    snapshotId: identity,
    metadataIdentity: `m1:${digest}`,
    project: {
      workspacePatterns: [],
      languages: ['typescript'],
      fileCount: 2,
      packageCount: 1,
      configIdentity: 'config:1',
    },
    packages: [
      {
        name: 'app',
        root: '.',
        private: true,
        exports: [],
        bins: [],
        verificationCommands: [
          {
            tier: 'focused',
            cwd: '.',
            argv: ['vitest', 'run'],
            basis: 'manifest:test',
          },
        ],
        provenance: [{ source: 'manifest', detail: 'package.json' }],
      },
    ],
    files: [
      {
        path: 'src/work.ts',
        size: 1,
        modifiedMs: 1,
        roles: ['production'],
        targets: [],
        languages: ['typescript'],
        evidenceSupport: {
          callable: 'supported',
          declaration: 'supported',
          reference: 'supported',
        },
        packageName: 'app',
        provenance: [{ source: 'filesystem', detail: 'inventory' }],
      },
      {
        path: 'src/work.test.ts',
        size: 1,
        modifiedMs: 1,
        roles: ['test'],
        targets: [],
        languages: ['typescript'],
        evidenceSupport: {
          callable: 'supported',
          declaration: 'supported',
          reference: 'supported',
        },
        packageName: 'app',
        provenance: [{ source: 'convention', detail: '*.test.ts' }],
      },
    ],
    coverage: { status: 'complete', reasonCodes: [], observed: 2, total: 2 },
  };
}

function generation(catalogValue: Catalog): string {
  return catalogGenerationKey({
    language: catalogValue.language,
    cacheKey: catalogValue.cacheKey,
    filesFingerprint: catalogValue.filesFingerprint ?? '',
    builtAt: catalogValue.builtAt,
  });
}

function context(input: {
  readonly inventory: ProjectInventorySnapshot;
  readonly catalog: Catalog;
  readonly inventoryBinding?: string;
  readonly graphBinding?: string;
}) {
  const run = createContextRunState();
  run.beginInventory();
  run.completeInventory(input.inventoryBinding ?? input.inventory.snapshotId);
  run.beginGraph();
  run.completeGraph(input.graphBinding ?? generation(input.catalog));
  const saved = new Map<string, unknown>([[input.inventory.snapshotId, input.inventory]]);
  const save = vi.fn((record: { readonly id: string; readonly payload: unknown }) => {
    saved.set(record.id, record.payload);
    return {
      status: 'rebuilt' as const,
      snapshot: {
        ...record,
        kind: 'test-selection',
        schemaVersion: 1,
        producerVersion: '0.6.0',
        createdAt: '2026-07-13T00:00:00.000Z',
        sourceIdentity: 'source',
        configIdentity: 'config:1',
        byteCount: 1,
      },
    };
  });
  const get = vi.fn((id: string) => {
    const payload = saved.get(id);
    return payload === undefined
      ? null
      : {
          id,
          kind: id === input.inventory.snapshotId ? 'inventory' : 'test-selection',
          schemaVersion: 1,
          producerVersion: '0.6.0',
          createdAt: '2026-07-13T00:00:00.000Z',
          sourceIdentity: 'source',
          configIdentity: 'config:1',
          byteCount: 1,
          payload,
        };
  });
  const datastore = vi.fn(() => {
    throw new Error('raw datastore seam must not be touched');
  });
  const cli = {
    scope: {
      datastore,
      graph: {
        contextRun: run,
        contextCatalog: {
          load: () => ok(input.catalog),
          replace: vi.fn(() => ok(undefined)),
        },
        contextSnapshots: { get, save, latest: vi.fn(() => null) },
      },
    },
  } as unknown as ToolCliContext;
  return { cli, datastore, get, save };
}

describe('graph context producer bindings', () => {
  it('proves graph coverage from persisted build and project-language evidence', () => {
    const value = catalog();
    const inventoryValue = inventory('inventory-current');
    expect(
      assessContextGraphCoverage({
        catalog: value,
        inventory: inventoryValue,
      }),
    ).toEqual({ status: 'complete', reasonCodes: [], observed: 2, total: 2 });
    expect(
      assessContextGraphCoverage({
        catalog: {
          ...value,
          buildCoverage: { ...value.buildCoverage!, parseErrorFiles: 1 },
        },
        inventory: inventoryValue,
      }),
    ).toMatchObject({
      status: 'partial',
      reasonCodes: ['graph-parse-errors'],
      observed: 1,
      total: 2,
    });
    expect(
      assessContextGraphCoverage({
        catalog: {
          ...value,
          buildCoverage: { ...value.buildCoverage!, status: 'partial' },
        },
        inventory: inventoryValue,
      }),
    ).toMatchObject({
      status: 'partial',
      reasonCodes: ['graph-build-coverage-partial'],
    });
  });

  it('degrades when another project language is omitted or build coverage is unproven', () => {
    const inventoryValue: ProjectInventorySnapshot = {
      ...inventory('inventory-current'),
      files: [
        ...inventory('inventory-current').files,
        {
          path: 'service/main.py',
          size: 1,
          modifiedMs: 1,
          roles: ['production'],
          targets: [],
          languages: ['python'],
          evidenceSupport: {
            callable: 'supported',
            declaration: 'unsupported',
            reference: 'unsupported',
          },
          provenance: [{ source: 'filesystem', detail: 'inventory' }],
        },
      ],
      project: {
        ...inventory('inventory-current').project,
        languages: ['python', 'typescript'],
        fileCount: 3,
      },
      coverage: { status: 'complete', reasonCodes: [], observed: 3, total: 3 },
    };
    expect(
      assessContextGraphCoverage({
        catalog: catalog(),
        inventory: inventoryValue,
      }),
    ).toMatchObject({
      status: 'partial',
      reasonCodes: ['graph-language-coverage-partial'],
    });
    const legacyCatalog = { ...catalog(), buildCoverage: undefined };
    expect(
      assessContextGraphCoverage({
        catalog: legacyCatalog,
        inventory: inventory('inventory-current'),
      }),
    ).toMatchObject({
      status: 'partial',
      reasonCodes: ['graph-build-coverage-unavailable'],
    });
    expect(
      assessContextGraphCoverage({
        catalog: {
          ...catalog(),
          buildCoverage: {
            status: 'complete',
            discoveredFiles: 0,
            parseErrorFiles: 0,
            filesIdentity: graphInputFilesIdentity([]),
          },
        },
        inventory: inventory('inventory-current'),
      }),
    ).toMatchObject({
      status: 'partial',
      reasonCodes: ['graph-file-coverage-partial'],
    });
  });

  it('selects only from exact prior-step identities and contributes both inputs', async () => {
    const inventoryValue = inventory('inventory-current');
    const catalogValue = catalog();
    const harness = context({
      inventory: inventoryValue,
      catalog: catalogValue,
    });
    const result = await produceContextTestSelection(
      { cwd: '/repo', files: ['src/work.ts'] },
      harness.cli,
    );
    expect(result.evidenceSnapshots).toEqual([
      expect.objectContaining({
        kind: 'test-selection',
        status: 'rebuilt',
        inputs: [
          { kind: 'inventory', snapshotId: inventoryValue.snapshotId },
          { kind: 'graph', snapshotId: generation(catalogValue) },
        ],
      }),
    ]);
    expect(harness.get).toHaveBeenCalledWith(inventoryValue.snapshotId);
    expect(harness.save).toHaveBeenCalledTimes(1);
    expect(harness.datastore).not.toHaveBeenCalled();
  });

  it('fails closed when the current catalog no longer matches the prior graph step', async () => {
    const inventoryValue = inventory('inventory-current');
    const harness = context({
      inventory: inventoryValue,
      catalog: catalog('replacement'),
      graphBinding: generation(catalog('original')),
    });
    const result = await produceContextTestSelection(
      { cwd: '/repo', files: ['src/work.ts'] },
      harness.cli,
    );
    expect(result.evidenceSnapshots).toEqual([
      expect.objectContaining({
        status: 'failed',
        reasons: [{ code: 'test-selection-graph-binding-mismatch' }],
      }),
    ]);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('never substitutes the latest inventory when the exact prior pointer is missing', async () => {
    const harness = context({
      inventory: inventory('inventory-current'),
      catalog: catalog(),
      inventoryBinding: `i1:${'e'.repeat(64)}`,
    });
    const result = await produceContextTestSelection(
      { cwd: '/repo', files: ['src/work.ts'] },
      harness.cli,
    );
    expect(result.evidenceSnapshots).toEqual([
      expect.objectContaining({
        status: 'failed',
        reasons: [{ code: 'test-selection-inventory-binding-mismatch' }],
      }),
    ]);
    expect(harness.get).toHaveBeenCalledWith(`i1:${'e'.repeat(64)}`);
    expect(harness.save).not.toHaveBeenCalled();
  });

  it('uses configured custom test roots in the persisted selection snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-context-source-role-'));
    try {
      writeFileSync(
        join(root, 'opensip-cli.config.yml'),
        'graph:\n  auditTestSourceGlobs:\n    - quality/**\n',
        'utf8',
      );
      const source = catalog();
      const customTest = occurrence('custom-test', 'quality/custom-check.ts', {
        calls: [
          {
            to: ['production'],
            line: 2,
            column: 1,
            resolution: 'static',
            confidence: 'high',
            text: 'work()',
          },
        ],
      });
      const customCatalog: Catalog = {
        ...source,
        functions: {
          production: source.functions.production,
          custom: [customTest],
        },
      };
      const harness = context({
        inventory: inventory('custom-root'),
        catalog: customCatalog,
      });
      const result = await produceContextTestSelection(
        { cwd: root, files: ['src/work.ts'] },
        harness.cli,
      );
      expect(result.evidenceSnapshots).toEqual([
        expect.objectContaining({ kind: 'test-selection', status: 'rebuilt' }),
      ]);
      expect(harness.save).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            tests: expect.arrayContaining([
              expect.objectContaining({ path: 'quality/custom-check.ts' }),
            ]),
          }),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('clears stale chain inputs before each producer attempt', () => {
    const run = createContextRunState();
    run.beginInventory();
    run.completeInventory('inventory-old');
    run.beginGraph();
    run.completeGraph('graph-old');
    expect(run.inputs()).toEqual({
      inventorySnapshotId: 'inventory-old',
      graphSnapshotId: 'graph-old',
    });
    run.beginInventory();
    expect(run.inputs()).toBeUndefined();
    run.completeInventory('inventory-new');
    run.beginGraph();
    expect(run.inputs()).toBeUndefined();
  });
});
