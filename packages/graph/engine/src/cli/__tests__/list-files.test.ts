/**
 * `executeListFiles` — discovery-only `graph --list-files` mode.
 *
 * The collaborators (adapter discovery, positional-path resolution, workspace
 * unit enumeration, adapter selection, error mapping) are mocked: this suite
 * pins list-files's OWN logic — scope routing, the union/dedup/sort/relativize
 * pipeline, the json-vs-render seam choice, and the two failure paths
 * (empty-workspace, mutually-exclusive flags) — not the discovery internals,
 * which their own packages test.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeListFiles } from '../list-files.js';

import type { GraphCommandOptions } from '../graph-options.js';
import type { ToolCliContext } from '@opensip-cli/core';

const h = vi.hoisted(() => ({
  discoverFiles: vi.fn(),
  selectAdapter: vi.fn(),
  resolvePositionalPaths: vi.fn(),
  discoverPolyglotUnits: vi.fn(),
  resolveAdaptersForRun: vi.fn(),
  handleGraphError: vi.fn(),
}));

vi.mock('../../lang-adapter/registry.js', () => ({
  currentAdapterRegistry: () => ({}),
}));
vi.mock('../../lang-adapter/selector.js', () => ({
  GraphAdapterSelector: vi.fn().mockImplementation(function () {
    return { pick: h.selectAdapter };
  }),
}));
vi.mock('../positional-paths.js', () => ({
  resolvePositionalPaths: h.resolvePositionalPaths,
}));
vi.mock('../workspace-runner.js', () => ({
  discoverPolyglotUnits: h.discoverPolyglotUnits,
}));
vi.mock('../resolve-adapters.js', () => ({
  resolveAdaptersForRun: h.resolveAdaptersForRun,
}));
vi.mock('../graph.js', () => ({ handleGraphError: h.handleGraphError }));

const adapter = { id: 'typescript', discoverFiles: h.discoverFiles };

function mockCli(): ToolCliContext {
  return {
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    logger: console,
    scope: { languages: {} },
    reportFailure: vi.fn(() => Promise.resolve()),
  } as unknown as ToolCliContext;
}

// cwd `/proj` does not exist on disk, so realpathSync throws and the code
// falls back to the resolved absolute path — exactly the symlink-probe
// fallback branch, and a stable root for relativization assertions.
const opts = (o: Partial<GraphCommandOptions>): GraphCommandOptions => ({
  cwd: '/proj',
  ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.selectAdapter.mockReturnValue(adapter);
  h.discoverFiles.mockReturnValue({ files: ['/proj/b.ts', '/proj/a.ts'] });
});

afterEach(() => vi.restoreAllMocks());

describe('executeListFiles — whole-project scope', () => {
  it('emits relativized, sorted, deduped files under --json', async () => {
    h.discoverFiles.mockReturnValue({
      files: ['/proj/b.ts', '/proj/a.ts', '/proj/a.ts'],
    });
    const cli = mockCli();
    await executeListFiles(opts({ json: true }), cli);
    expect(cli.emitJson).toHaveBeenCalledWith({
      count: 2,
      files: ['a.ts', 'b.ts'],
    });
    expect(cli.setExitCode).toHaveBeenCalledWith(EXIT_CODES.SUCCESS);
    expect(h.selectAdapter).toHaveBeenCalledWith({
      cwd: '/proj',
      language: undefined,
    });
  });

  it('renders graph-status lines (paths only, no header) without --json', async () => {
    const cli = mockCli();
    await executeListFiles(opts({}), cli);
    expect(cli.render).toHaveBeenCalledWith({
      type: 'graph-status',
      lines: ['a.ts', 'b.ts'],
    });
    expect(cli.emitJson).not.toHaveBeenCalled();
  });
});

describe('executeListFiles — positional subtrees', () => {
  it('unions discovery across each resolved positional path', async () => {
    h.resolvePositionalPaths.mockReturnValue(['/proj/pkg1', '/proj/pkg2']);
    h.discoverFiles
      .mockReturnValueOnce({ files: ['/proj/pkg1/x.ts'] })
      .mockReturnValueOnce({ files: ['/proj/pkg2/y.ts'] });
    const cli = mockCli();
    await executeListFiles(opts({ json: true, paths: ['pkg1', 'pkg2'] }), cli);
    expect(h.resolvePositionalPaths).toHaveBeenCalledWith(['pkg1', 'pkg2'], '/proj');
    expect(cli.emitJson).toHaveBeenCalledWith({
      count: 2,
      files: ['pkg1/x.ts', 'pkg2/y.ts'],
    });
  });
});

describe('executeListFiles — --language', () => {
  it('uses the named adapter from the registry', async () => {
    const cli = mockCli();
    await executeListFiles(opts({ json: true, language: 'typescript' }), cli);
    expect(h.selectAdapter).toHaveBeenCalledWith({
      cwd: '/proj',
      language: 'typescript',
    });
    expect(cli.emitJson).toHaveBeenCalledWith({
      count: 2,
      files: ['a.ts', 'b.ts'],
    });
  });

  it('routes an unregistered named adapter through handleGraphError', async () => {
    h.selectAdapter.mockImplementation(() => {
      throw new Error('graph: language adapter klingon is not registered');
    });
    const cli = mockCli();
    await executeListFiles(opts({ json: true, language: 'klingon' }), cli);
    expect(h.handleGraphError).toHaveBeenCalledTimes(1);
  });
});

describe('executeListFiles — --workspace', () => {
  it('unions discovery across every workspace unit', async () => {
    h.resolveAdaptersForRun.mockReturnValue([adapter]);
    h.discoverPolyglotUnits.mockResolvedValue([
      { id: 'u1', rootDir: '/proj/u1' },
      { id: 'u2', rootDir: '/proj/u2', configPath: '/proj/u2/tsconfig.json' },
    ]);
    h.discoverFiles
      .mockReturnValueOnce({ files: ['/proj/u1/a.ts'] })
      .mockReturnValueOnce({ files: ['/proj/u2/b.ts'] });
    const cli = mockCli();
    await executeListFiles(opts({ json: true, workspace: true }), cli);
    expect(h.discoverPolyglotUnits).toHaveBeenCalledWith('/proj', [adapter]);
    expect(cli.emitJson).toHaveBeenCalledWith({
      count: 2,
      files: ['u1/a.ts', 'u2/b.ts'],
    });
  });

  it('skips a unit whose discovery throws (non-fatal)', async () => {
    h.resolveAdaptersForRun.mockReturnValue([adapter]);
    h.discoverPolyglotUnits.mockResolvedValue([
      { id: 'u1', rootDir: '/proj/u1' },
      { id: 'u2', rootDir: '/proj/u2' },
    ]);
    h.discoverFiles
      .mockImplementationOnce(() => {
        throw new Error('cannot discover u1');
      })
      .mockReturnValueOnce({ files: ['/proj/u2/b.ts'] });
    const cli = mockCli();
    await executeListFiles(opts({ json: true, workspace: true }), cli);
    expect(cli.emitJson).toHaveBeenCalledWith({ count: 1, files: ['u2/b.ts'] });
  });

  it('routes an empty workspace through handleGraphError', async () => {
    h.resolveAdaptersForRun.mockReturnValue([adapter]);
    h.discoverPolyglotUnits.mockResolvedValue([]);
    const cli = mockCli();
    await executeListFiles(opts({ workspace: true }), cli);
    expect(h.handleGraphError).toHaveBeenCalledTimes(1);
    expect(h.handleGraphError.mock.calls[0]?.[0]).toBe('list-files');
    expect(cli.emitJson).not.toHaveBeenCalled();
  });
});

describe('executeListFiles — guards', () => {
  it('rejects --workspace combined with positional paths', async () => {
    const cli = mockCli();
    await executeListFiles(opts({ workspace: true, paths: ['pkg1'] }), cli);
    expect(h.handleGraphError).toHaveBeenCalledTimes(1);
    expect(h.discoverPolyglotUnits).not.toHaveBeenCalled();
  });
});
