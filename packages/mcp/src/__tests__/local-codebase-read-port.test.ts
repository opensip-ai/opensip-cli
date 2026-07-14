import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalCodebaseReadPort } from '../local-codebase-read-port.js';

import type { BoundedTargetResolver, TargetResolver, TargetView } from '@opensip-cli/core';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function countedResolver(targets: BoundedTargetResolver): {
  readonly targets: BoundedTargetResolver;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    targets: {
      ...targets,
      resolveTargetsBounded: (names, rootDir, options) => {
        calls += 1;
        return targets.resolveTargetsBounded(names, rootDir, options);
      },
      applyGlobalExcludesBounded: (files, rootDir, options) =>
        targets.applyGlobalExcludesBounded(files, rootDir, options),
    },
    calls: () => calls,
  };
}

function baseOnlyResolver(targets: BoundedTargetResolver): TargetResolver {
  return {
    getByName: (name) => targets.getByName(name),
    getAll: () => targets.getAll(),
    getByTag: (tag) => targets.getByTag(tag),
    has: (name) => targets.has(name),
    resolveTargets: (names, rootDir) => targets.resolveTargets(names, rootDir),
    applyGlobalExcludes: (files, rootDir) => targets.applyGlobalExcludes(files, rootDir),
    globalExcludes: targets.globalExcludes,
  };
}

function fixture(): {
  readonly root: string;
  readonly targets: BoundedTargetResolver;
} {
  const root = mkdtempSync(join(tmpdir(), 'opensip-mcp-inventory-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'ignored'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      scripts: { test: 'vitest run' },
    }),
  );
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'ignored', 'secret.ts'), 'export const secret = 1;\n');
  const target: TargetView = {
    config: {
      name: 'source',
      description: 'source',
      include: ['src/**/*.ts'],
      exclude: [],
      languages: ['typescript'],
      concerns: ['production'],
    },
  };
  const targets: BoundedTargetResolver = {
    getByName: (name) => (name === target.config.name ? target : undefined),
    getAll: () => [target],
    getByTag: () => [],
    has: (name) => name === target.config.name,
    resolveTargets: () => [join(root, 'src', 'a.ts')],
    resolveTargetsBounded: (_names, _rootDir, options) => {
      if (options.signal?.aborted === true) {
        return Promise.resolve({ files: [], capped: false, cancelled: true });
      }
      const files = [join(root, 'src', 'a.ts')];
      return Promise.resolve({
        files: files.slice(0, options.maxResults),
        capped: files.length > options.maxResults,
        cancelled: false,
      });
    },
    applyGlobalExcludesBounded: (files, _rootDir, options) => {
      if (options.signal?.aborted === true) {
        return Promise.resolve({ files: [], capped: false, cancelled: true });
      }
      const retained = files.filter((file) => !file.includes('/ignored/')).sort();
      return Promise.resolve({
        files: retained.slice(0, options.maxResults),
        capped: retained.length > options.maxResults,
        cancelled: false,
      });
    },
    applyGlobalExcludes: (files) => files.filter((file) => !file.includes('/ignored/')),
    globalExcludes: ['ignored/**'],
  };
  return { root, targets };
}

describe('LocalCodebaseReadPort', () => {
  it('reuses a short read burst, then revalidates source-free file/package facts', async () => {
    let nowMs = Date.parse('2026-07-13T00:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const fixtureResult = fixture();
    const { targets, calls } = countedResolver(fixtureResult.targets);
    const port = new LocalCodebaseReadPort({
      projectRoot: fixtureResult.root,
      configIdentity: 'sha256:config',
      targets,
      languageEvidenceSupport: new Map([
        [
          'typescript',
          {
            callable: 'supported',
            declaration: 'supported',
            reference: 'supported',
          },
        ],
      ]),
    });
    const first = await port.inventoryStatus();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.coverage.status).toBe('complete');
    expect(first.value.snapshot.files.map((file) => file.path)).toEqual([
      'package.json',
      'src/a.ts',
    ]);

    const context = await port.fileContext('src/a.ts');
    expect(context.ok).toBe(true);
    if (!context.ok) return;
    expect(context.value).toMatchObject({
      status: 'found',
      file: {
        path: 'src/a.ts',
        packageName: 'fixture',
        languages: ['typescript'],
        evidenceSupport: {
          callable: 'supported',
          declaration: 'supported',
          reference: 'supported',
        },
      },
      package: { name: 'fixture' },
      project: { configIdentity: 'sha256:config' },
    });
    expect(JSON.stringify(context.value)).not.toContain('export const');
    expect(calls()).toBe(1);

    writeFileSync(join(fixtureResult.root, 'src', 'a.ts'), 'export const a = 200;\n');
    const burst = await port.inventoryStatus();
    expect(burst.ok).toBe(true);
    if (!burst.ok) return;
    expect(burst.value.snapshot).toBe(first.value.snapshot);
    expect(burst.value.identity).toBe(first.value.identity);
    expect(calls()).toBe(1);

    nowMs += 2000;
    const second = await port.inventoryStatus();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.snapshot).not.toBe(first.value.snapshot);
    expect(second.value.identity).not.toBe(first.value.identity);
    expect(second.value.freshness).toMatchObject({
      fresh: true,
      verification: 'complete',
    });
    expect(calls()).toBe(2);
  });

  it('bypasses the completed read-burst cache when freshness is required', async () => {
    const fixtureResult = fixture();
    const { targets, calls } = countedResolver(fixtureResult.targets);
    const port = new LocalCodebaseReadPort({
      projectRoot: fixtureResult.root,
      configIdentity: 'sha256:config',
      targets,
    });
    const first = await port.inventoryStatus();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    writeFileSync(join(fixtureResult.root, 'src', 'a.ts'), 'export const a = 200;\n');
    const reused = await port.inventoryStatus();
    expect(reused.ok && reused.value.identity).toBe(first.value.identity);
    expect(calls()).toBe(1);

    const fresh = await port.inventoryStatus(undefined, { forceFresh: true });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.identity).not.toBe(first.value.identity);
    expect(calls()).toBe(2);
  });

  it('reports bounded inventory unavailable for a base-only target resolver', async () => {
    const { root, targets } = fixture();
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets: baseOnlyResolver(targets),
    });

    const result = await port.inventoryStatus();

    expect(result).toMatchObject({
      ok: true,
      value: {
        coverage: {
          status: 'unavailable',
          reasonCodes: ['bounded-target-resolution-unavailable'],
          observed: 0,
        },
        freshness: {
          fresh: false,
          verification: 'missing',
          reasonCodes: ['bounded-target-resolution-unavailable'],
        },
      },
    });
  });

  it('coalesces concurrent refreshes and isolates an aborted waiter', async () => {
    const fixtureResult = fixture();
    const { targets, calls } = countedResolver(fixtureResult.targets);
    const port = new LocalCodebaseReadPort({
      projectRoot: fixtureResult.root,
      configIdentity: 'sha256:config',
      targets,
    });
    const controller = new AbortController();

    const cancelledPending = port.inventoryStatus(controller.signal);
    const livePending = port.inventoryStatus();
    controller.abort();
    const [cancelled, live] = await Promise.all([cancelledPending, livePending]);

    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error.code).toBe('cancelled');
    expect(live.ok).toBe(true);
    if (live.ok) expect(live.value.snapshot.files).toHaveLength(2);
    expect(calls()).toBe(1);

    const reused = await port.inventoryStatus();
    expect(reused.ok).toBe(true);
    expect(calls()).toBe(1);
  });

  it('distinguishes excluded and unknown files', async () => {
    const { root, targets } = fixture();
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets,
    });
    const excluded = await port.fileContext('ignored/secret.ts');
    const unknown = await port.fileContext('other/missing.ts');
    const manifest = await port.fileContext('package.json');
    expect(excluded.ok && excluded.value.status).toBe('excluded');
    expect(unknown.ok && unknown.value).toMatchObject({
      status: 'unknown',
      package: {
        name: 'fixture',
        verificationCommands: [expect.objectContaining({ argv: ['vitest', 'run'] })],
      },
    });
    expect(manifest.ok && manifest.value).toMatchObject({
      status: 'found',
      package: {
        name: 'fixture',
        verificationCommands: [expect.objectContaining({ argv: ['vitest', 'run'] })],
      },
    });
  });

  it('does not let a cancelled refresh overwrite the next generation', async () => {
    const fixtureResult = fixture();
    const { targets, calls } = countedResolver(fixtureResult.targets);
    const events: {
      readonly event: string;
      readonly status: string | number | boolean | undefined;
    }[] = [];
    const port = new LocalCodebaseReadPort({
      projectRoot: fixtureResult.root,
      configIdentity: 'sha256:config',
      targets,
      log: (event, fields) => events.push({ event, status: fields.status }),
    });
    const controller = new AbortController();

    const cancelledPending = port.inventoryStatus(controller.signal);
    controller.abort();
    const cancelled = await cancelledPending;
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.error.code).toBe('cancelled');

    const retry = await port.inventoryStatus();
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.snapshot.files).toHaveLength(2);
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        event: 'mcp.codebase.inventory.failed',
        status: 'cancelled',
      });
    });

    const callsAfterRetry = calls();
    const reused = await port.inventoryStatus();
    expect(reused.ok).toBe(true);
    if (retry.ok && reused.ok) expect(reused.value.identity).toBe(retry.value.identity);
    expect(calls()).toBe(callsAfterRetry);
    expect(
      events.filter((entry) => entry.event === 'mcp.codebase.inventory.completed'),
    ).toHaveLength(1);
  });

  it('returns a qualified negative when exclusion resolution throws', async () => {
    const { root, targets } = fixture();
    const throwingTargets: TargetResolver = {
      ...targets,
      applyGlobalExcludes: () => {
        throw new Error('/private/path and secret token must not escape');
      },
    };
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets: throwingTargets,
    });

    const result = await port.fileContext('other/missing.ts');
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'unavailable',
        reasonCodes: expect.arrayContaining(['target-exclusion-failed']),
      },
    });
    expect(JSON.stringify(result)).not.toContain('/private/path');
    expect(JSON.stringify(result)).not.toContain('secret token');
  });

  it('rejects absolute, traversal, empty, and control-character paths', async () => {
    const { root, targets } = fixture();
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets,
    });
    for (const file of [
      '',
      '/abs/path.ts',
      'C:\\windows\\path.ts',
      '../escape.ts',
      'src//double.ts',
      'src/./dot.ts',
      `src/\u0000bad.ts`,
      'x'.repeat(1025),
    ]) {
      const result = await port.fileContext(file);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'invalid-input' },
      });
    }
  });

  it('returns cancelled before refresh when the signal is already aborted', async () => {
    const { root, targets } = fixture();
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await port.inventoryStatus(controller.signal);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('returns cancelled for fileContext when the signal aborts after inventory', async () => {
    const { root, targets } = fixture();
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets,
    });
    await port.inventoryStatus();
    const controller = new AbortController();
    controller.abort();
    const result = await port.fileContext('src/a.ts', controller.signal);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  it('reports unavailable file context when inventory coverage is unavailable', async () => {
    const { root, targets } = fixture();
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets: baseOnlyResolver(targets),
    });
    const result = await port.fileContext('src/a.ts');
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'unavailable',
        reasonCodes: expect.arrayContaining(['bounded-target-resolution-unavailable']),
        nextActions: expect.arrayContaining([
          expect.stringMatching(/targets|inventory|coverage/i),
        ]),
      },
    });
    expect(result.ok && 'file' in result.value ? result.value.file : undefined).toBeUndefined();
  });

  it('falls back to the status snapshot when cache identity no longer matches', async () => {
    const { root, targets } = fixture();
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets,
    });
    const first = await port.inventoryStatus();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const original = port.inventoryStatus.bind(port);
    vi.spyOn(port, 'inventoryStatus').mockImplementation(async (signal, options) => {
      const result = await original(signal, options);
      if (result.ok) {
        // Publish a mismatched cache after the status DTO is built so
        // lookupFileFact must scan status.snapshot.files instead of fileByPath.
        (
          port as unknown as {
            cache: {
              inventory: {
                snapshot: { snapshotId: string };
                fileByPath: Map<string, never>;
              };
              capturedAt: string;
              verifiedAtMs: number;
            };
          }
        ).cache = {
          inventory: {
            snapshot: { snapshotId: 'i1:stale-identity' },
            fileByPath: new Map(),
          },
          capturedAt: result.value.freshness.capturedAt,
          verifiedAtMs: Date.now(),
        };
      }
      return result;
    });

    const found = await port.fileContext('src/a.ts');
    expect(found).toMatchObject({
      ok: true,
      value: {
        status: 'found',
        file: { path: 'src/a.ts' },
        inventoryIdentity: first.value.identity,
      },
    });
  });

  it('prefers package facts matched by name and nested package roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opensip-mcp-nested-pkg-'));
    roots.push(root);
    mkdirSync(join(root, 'packages', 'app', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'workspace', private: true, workspaces: ['packages/*'] }),
    );
    writeFileSync(
      join(root, 'packages', 'app', 'package.json'),
      JSON.stringify({ name: '@scope/app', private: true, scripts: { test: 'vitest run' } }),
    );
    writeFileSync(join(root, 'packages', 'app', 'src', 'a.ts'), 'export const a = 1;\n');
    const target: TargetView = {
      config: {
        name: 'source',
        description: 'source',
        include: ['packages/app/src/**/*.ts'],
        exclude: [],
        languages: ['typescript'],
        concerns: ['production'],
      },
    };
    const targets: BoundedTargetResolver = {
      getByName: (name) => (name === target.config.name ? target : undefined),
      getAll: () => [target],
      getByTag: () => [],
      has: (name) => name === target.config.name,
      resolveTargets: () => [join(root, 'packages', 'app', 'src', 'a.ts')],
      resolveTargetsBounded: (_names, _rootDir, options) =>
        Promise.resolve({
          files: [join(root, 'packages', 'app', 'src', 'a.ts')].slice(0, options.maxResults),
          capped: false,
          cancelled: false,
        }),
      applyGlobalExcludesBounded: (files, _rootDir, options) =>
        Promise.resolve({
          files: files.slice(0, options.maxResults),
          capped: false,
          cancelled: false,
        }),
      applyGlobalExcludes: (files) => files,
      globalExcludes: [],
    };
    const port = new LocalCodebaseReadPort({
      projectRoot: root,
      configIdentity: 'sha256:config',
      targets,
      languageEvidenceSupport: new Map([
        [
          'typescript',
          {
            callable: 'supported',
            declaration: 'supported',
            reference: 'supported',
          },
        ],
      ]),
    });
    const result = await port.fileContext('packages/app/src/a.ts');
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: 'found',
        package: { name: '@scope/app', root: 'packages/app' },
      },
    });
  });
});
