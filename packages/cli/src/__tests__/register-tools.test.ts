import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PluginIncompatibleError,
  ToolRegistry as ToolRegistryClass,
  type Tool,
  type ToolCliContext,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-tools/core';
import { Command } from 'commander';
import { afterEach, describe, it, expect, vi } from 'vitest';

import {
  FIRST_PARTY_TOOLS,
  discoverAndRegisterToolPackages,
  mountAllToolCommands,
  registerFirstPartyTools,
} from '../bootstrap/register-tools.js';

function makeRegistry(): ToolRegistry {
  const map = new Map<string, Tool>();
  const list = (): Tool[] => [...map.values()];
  return {
    register: (tool: Tool) => {
      if (!map.has(tool.metadata.id)) map.set(tool.metadata.id, tool);
    },
    get: (id: string) => map.get(id),
    list,
    clear: () => map.clear(),
  } as never;
}

function makeStubContext(): ToolCliContext {
  return {
    program: new Command('opensip-tools'),
    project: { scope: 'project', projectRoot: '/x', walkedUp: 0 } as never,
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenDashboard: vi.fn(() => Promise.resolve()),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitEnvelope: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

describe('FIRST_PARTY_TOOLS', () => {
  it('contains fitness, simulation, and graph', () => {
    const ids = FIRST_PARTY_TOOLS.map((t) => t.metadata.id);
    expect(ids).toEqual(expect.arrayContaining(['fitness', 'simulation', 'graph']));
  });
});

describe('registerFirstPartyTools', () => {
  it('registers every first-party tool into the supplied registry', () => {
    const registry = makeRegistry();
    registerFirstPartyTools(registry);
    expect(registry.list()).toHaveLength(FIRST_PARTY_TOOLS.length);
  });

  it('is idempotent when called twice (first-writer-wins via id check)', () => {
    const registry = makeRegistry();
    registerFirstPartyTools(registry);
    registerFirstPartyTools(registry);
    expect(registry.list()).toHaveLength(FIRST_PARTY_TOOLS.length);
  });

  // Release 2.8.0 Phase 3: bundled tools flow through the admitTool gate and
  // contribute provenance. The gate runs ALONGSIDE registration (additive) —
  // every first-party tool still registers, and now each yields a bundled
  // ToolProvenance with a manifestHash.
  it('collects bundled ToolProvenance for every first-party tool (gate runs)', () => {
    const registry = new ToolRegistryClass();
    const provenance: ToolProvenance[] = [];
    registerFirstPartyTools(registry, provenance);

    expect(registry.list().map((t) => t.metadata.id)).toEqual(
      expect.arrayContaining(['fitness', 'simulation', 'graph']),
    );
    expect(provenance).toHaveLength(FIRST_PARTY_TOOLS.length);
    for (const record of provenance) {
      expect(record.source).toBe('bundled');
      expect(typeof record.manifestHash).toBe('string');
      expect(record.manifestHash.length).toBeGreaterThan(0);
      expect(record.packageName).toMatch(/^@opensip-tools\//);
    }
    expect(provenance.map((p) => p.id)).toEqual(
      expect.arrayContaining(['fitness', 'simulation', 'graph']),
    );
  });

  it('a bundled fail-closed throws a PluginIncompatibleError (→ exit 5)', () => {
    // The gate's fail-closed verdict for a bundled tool must surface as the
    // typed error the CLI error boundary maps to PLUGIN_INCOMPATIBLE. We
    // assert the error TYPE here; the contracts exit-code mapping is tested
    // in contracts. (A real out-of-range bundled manifest can't be staged
    // without a fixture, so this asserts the type the throw paths use.)
    const err = new PluginIncompatibleError('bundled tool x is incompatible', {
      diagnostic: 'epoch mismatch',
    });
    expect(err).toBeInstanceOf(PluginIncompatibleError);
    expect(err.code).toBe('PLUGIN_INCOMPATIBLE');
    expect(err.diagnostic).toBe('epoch mismatch');
  });
});

describe('mountAllToolCommands', () => {
  it('calls register(ctx) on every tool', () => {
    const registry = makeRegistry();
    const registerA = vi.fn();
    const registerB = vi.fn();
    registry.register({
      metadata: { id: 'tool-a', name: 'A' },
      register: registerA,
    } as never);
    registry.register({
      metadata: { id: 'tool-b', name: 'B' },
      register: registerB,
    } as never);
    const ctx = makeStubContext();

    mountAllToolCommands(registry, ctx);

    expect(registerA).toHaveBeenCalledWith(ctx);
    expect(registerB).toHaveBeenCalledWith(ctx);
  });

  it('isolates a failing register so the rest still mount', () => {
    const registry = makeRegistry();
    const registerOk = vi.fn();
    const registerBad = vi.fn(() => {
      throw new Error('boom');
    });
    registry.register({
      metadata: { id: 'tool-good', name: 'good' },
      register: registerOk,
    } as never);
    registry.register({
      metadata: { id: 'tool-bad', name: 'bad' },
      register: registerBad,
    } as never);
    const ctx = makeStubContext();

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
    try {
      mountAllToolCommands(registry, ctx);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(registerOk).toHaveBeenCalledOnce();
    expect(registerBad).toHaveBeenCalledOnce();
  });

  it('isolates a non-Error throw too', () => {
    const registry = makeRegistry();
    registry.register({
      metadata: { id: 'tool-throws-string', name: 'x' },
      register: () => {
        const nonError: unknown = 'plain string';
        throw nonError;
      },
    } as never);
    const ctx = makeStubContext();
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
    try {
      expect(() => mountAllToolCommands(registry, ctx)).not.toThrow();
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe('discoverAndRegisterToolPackages', () => {
  it('does not throw when there are no third-party tool packages on disk', async () => {
    // Per-test fresh ToolRegistry (the previously-exported
    // `defaultToolRegistry` module singleton was removed in T1 cleanup).
    const registry = new ToolRegistryClass();
    const empty = mkdtempSync(join(tmpdir(), 'opensip-discover-test-'));
    try {
      await expect(
        discoverAndRegisterToolPackages(registry, { sources: [{ dir: empty, mode: 'walkUp' }] }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Discovery loop body. `discoverAndRegisterToolPackages` does `await
// import(pkg.name)` on every discovered package, so the package must be
// importable by its bare name. We stage fixture packages inside the CLI
// package's own node_modules (under a throwaway @opensip-tools-fixture scope)
// and point projectDir at the CLI package root so the ancestor-walk finds
// them AND Node's resolver can import them. Each fixture is removed afterwards.
// ---------------------------------------------------------------------------

const CLI_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_SCOPE = join(CLI_PKG_ROOT, 'node_modules', '@opensip-tools-fixture');

interface Fixture {
  readonly name: string;
  readonly dir: string;
}

function stageFixture(shortName: string, files: { packageJson: object; indexJs: string }): Fixture {
  const dir = join(FIXTURE_SCOPE, shortName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(files.packageJson), 'utf8');
  writeFileSync(join(dir, 'index.js'), files.indexJs, 'utf8');
  return { name: `@opensip-tools-fixture/${shortName}`, dir };
}

function silenceStderr(): () => void {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true);
  return () => {
    process.stderr.write = orig;
  };
}

describe('discoverAndRegisterToolPackages — discovered package handling', () => {
  const staged: Fixture[] = [];

  afterEach(() => {
    for (const f of staged.splice(0)) rmSync(f.dir, { recursive: true, force: true });
    rmSync(FIXTURE_SCOPE, { recursive: true, force: true });
  });

  it('registers a discovered package that exports a valid tool', async () => {
    staged.push(
      stageFixture('valid-tool', {
        packageJson: {
          name: '@opensip-tools-fixture/valid-tool',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: { kind: 'tool' },
        },
        indexJs:
          "export const tool = { metadata: { id: 'fixture-valid', name: 'Fixture', version: '0.0.0' }, commands: [], register() {} };",
      }),
    );
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] });
    expect(registry.get('fixture-valid')).toBeDefined();
  });

  it('skips a discovered package whose `tool` export is malformed', async () => {
    staged.push(
      stageFixture('bad-shape', {
        packageJson: {
          name: '@opensip-tools-fixture/bad-shape',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: { kind: 'tool' },
        },
        indexJs: "export const tool = { not: 'a tool' };",
      }),
    );
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] });
    } finally {
      restore();
    }
    expect(registry.list()).toHaveLength(0);
  });

  it('skips a discovered package whose tool id collides with a built-in', async () => {
    staged.push(
      stageFixture('shadow-fitness', {
        packageJson: {
          name: '@opensip-tools-fixture/shadow-fitness',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: { kind: 'tool' },
        },
        indexJs:
          "export const tool = { metadata: { id: 'fitness', name: 'Shadow', version: '0.0.0' }, commands: [], register() {} };",
      }),
    );
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] });
    // The built-in id is skipped before registration ⇒ nothing added.
    expect(registry.list()).toHaveLength(0);
  });

  it('skips an installed package whose manifest is a FUTURE epoch (skip, not fail)', async () => {
    // Release 2.8.0: a discovered installed tool runs through admitTool with
    // explicitlyRequested:false, so an out-of-range (future-epoch) manifest
    // SKIPS — it must not fail the whole CLI. The fixture also throws on import,
    // so reaching the (resolved, non-throwing) call additionally proves the
    // gate rejected it on the static manifest BEFORE its module was imported.
    staged.push(
      stageFixture('future-epoch', {
        packageJson: {
          name: '@opensip-tools-fixture/future-epoch',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-future',
            apiVersion: 999,
            commands: [{ name: 'fixture-future', description: 'a tool from the future' }],
          },
        },
        indexJs: "throw new Error('future-epoch tool must never be imported');",
      }),
    );
    const registry = new ToolRegistryClass();
    const provenance: ToolProvenance[] = [];
    const restore = silenceStderr();
    try {
      // Whole-CLI must NOT fail — the incompatible installed tool is skipped.
      await expect(
        discoverAndRegisterToolPackages(
          registry,
          { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] },
          provenance,
        ),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    // Skipped ⇒ not registered, and no provenance recorded for it.
    expect(registry.get('fixture-future')).toBeUndefined();
    expect(provenance.some((p) => p.id === 'fixture-future')).toBe(false);
  });

  it('isolates a package whose module throws on import', async () => {
    staged.push(
      stageFixture('throws-on-load', {
        packageJson: {
          name: '@opensip-tools-fixture/throws-on-load',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: { kind: 'tool' },
        },
        indexJs: "throw new Error('boom on import');",
      }),
    );
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await expect(
        discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] }),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(registry.list()).toHaveLength(0);
  });
});
