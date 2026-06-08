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
  discoverAndRegisterToolPackages,
  mountAllToolCommands,
  registerFirstPartyTools,
} from '../bootstrap/register-tools.js';

import { BUNDLED_TOOLS, BUNDLED_TOOL_IDS } from './test-utils/bundled-tools.js';

/** The bundled-tool ids discovery skips on a name collision (3.0.0: passed
 *  explicitly; production derives it from the loaded bundled manifests). */
const BUILTIN_IDS = new Set(BUNDLED_TOOL_IDS);

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
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

describe('BUNDLED_TOOLS', () => {
  it('contains fitness, simulation, and graph', () => {
    const ids = BUNDLED_TOOLS.map((t) => t.metadata.id);
    expect(ids).toEqual(expect.arrayContaining(['fitness', 'simulation', 'graph']));
  });
});

describe('registerFirstPartyTools', () => {
  it('registers every bundled tool into the supplied registry (via dynamic import)', async () => {
    const registry = makeRegistry();
    await registerFirstPartyTools(registry);
    expect(registry.list()).toHaveLength(BUNDLED_TOOLS.length);
  });

  it('is idempotent when called twice (first-writer-wins via id check)', async () => {
    const registry = makeRegistry();
    await registerFirstPartyTools(registry);
    await registerFirstPartyTools(registry);
    expect(registry.list()).toHaveLength(BUNDLED_TOOLS.length);
  });

  // Release 2.8.0 Phase 3 / 3.0.0 GA: bundled tools flow through the admitTool
  // gate and contribute provenance. In 3.0.0 the runtime is loaded by DYNAMIC
  // IMPORT through the same path installed tools use — every bundled tool still
  // registers, and each yields a bundled ToolProvenance with a manifestHash.
  it('collects bundled ToolProvenance for every bundled tool (gate runs)', async () => {
    const registry = new ToolRegistryClass();
    const provenance: ToolProvenance[] = [];
    await registerFirstPartyTools(registry, provenance);

    expect(registry.list().map((t) => t.metadata.id)).toEqual(
      expect.arrayContaining(['fitness', 'simulation', 'graph']),
    );
    expect(provenance).toHaveLength(BUNDLED_TOOLS.length);
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

  // 3.0.0: bundled tools load through the dynamic-import path, so the bundled
  // fail-closed branches are now reachable with a fixture package name (the
  // `packages` param is injectable for exactly this). A bundled tool ships with
  // the CLI, so any load failure is fail-closed — never a silent skip.
  it('fails closed (throws) when a bundled package cannot be resolved on disk', async () => {
    const registry = new ToolRegistryClass();
    await expect(
      registerFirstPartyTools(registry, [], [], ['@opensip-tools/__definitely-not-a-real-package__']),
    ).rejects.toBeInstanceOf(PluginIncompatibleError);
    expect(registry.list()).toHaveLength(0);
  });

  it('fails closed (throws) when a bundled package ships no conformant manifest', async () => {
    // The package resolves on disk but has no `opensipTools` block, so
    // `loadToolManifest` → undefined → the bundled path fail-closes (a bundled
    // tool MUST ship a manifest; tool-has-manifest backstops this at CI).
    const dir = join(FIXTURE_SCOPE, 'no-manifest-bundled');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@opensip-tools-fixture/no-manifest-bundled',
        version: '0.0.0',
        type: 'module',
        main: './index.js',
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'index.js'),
      "export const tool = { metadata: { id: 'no-manifest', name: 'NM', version: '0.0.0' }, commands: [], commandSpecs: [{ name: 'c', description: 'c', commonFlags: [], output: 'command-result', handler: () => Promise.resolve({}) }] };",
      'utf8',
    );
    const registry = new ToolRegistryClass();
    try {
      await expect(
        registerFirstPartyTools(registry, [], [], ['@opensip-tools-fixture/no-manifest-bundled']),
      ).rejects.toBeInstanceOf(PluginIncompatibleError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(FIXTURE_SCOPE, { recursive: true, force: true });
    }
    expect(registry.list()).toHaveLength(0);
  });

  it('fails closed (throws) when a bundled tool runtime fails to load', async () => {
    // A bundled fixture with a valid manifest (so it resolves + admits) whose
    // entry throws on import → `importToolRuntime` 'import-failed' → the bundled
    // path fail-closes rather than skipping.
    const dir = join(FIXTURE_SCOPE, 'broken-bundled');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@opensip-tools-fixture/broken-bundled',
        version: '0.0.0',
        type: 'module',
        main: './index.js',
        opensipTools: {
          kind: 'tool',
          id: 'broken-bundled',
          apiVersion: 1,
          commands: [{ name: 'broken-bundled', description: 'a tool that throws on import' }],
        },
      }),
      'utf8',
    );
    writeFileSync(join(dir, 'index.js'), "throw new Error('boom on bundled import');", 'utf8');
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await expect(
        registerFirstPartyTools(registry, [], [], ['@opensip-tools-fixture/broken-bundled']),
      ).rejects.toBeInstanceOf(PluginIncompatibleError);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
      rmSync(FIXTURE_SCOPE, { recursive: true, force: true });
    }
    expect(registry.list()).toHaveLength(0);
  });
});

/** A minimal tool that mounts one command via the declarative commandSpecs path. */
function specTool(id: string, commandName: string): Tool {
  return {
    metadata: { id, name: id, version: '0.0.0', description: id },
    commands: [{ name: commandName, description: `${commandName} cmd` }],
    commandSpecs: [
      {
        name: commandName,
        description: `${commandName} cmd`,
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () => Promise.resolve({ type: 'noop' }),
      },
    ] as never,
  };
}

describe('mountAllToolCommands', () => {
  it('mounts every tool via its commandSpecs (the one command surface, 3.0.0)', () => {
    const registry = makeRegistry();
    registry.register(specTool('tool-a', 'a'));
    registry.register(specTool('tool-b', 'b'));
    const program = new Command('opensip-tools');

    mountAllToolCommands(registry, program, makeStubContext());

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('surfaces a tool with no commandSpecs (mounts nothing, no throw)', () => {
    const registry = makeRegistry();
    // A tool with neither commandSpecs nor any mount surface — a mis-declaration.
    registry.register({
      metadata: { id: 'tool-empty', name: 'empty', version: '0.0.0', description: 'empty' },
      commands: [],
    } as never);
    registry.register(specTool('tool-ok', 'ok'));
    const program = new Command('opensip-tools');

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
    try {
      mountAllToolCommands(registry, program, makeStubContext());
    } finally {
      process.stderr.write = origWrite;
    }
    // The valid tool still mounts; the empty one contributes nothing.
    expect(program.commands.map((c) => c.name())).toContain('ok');
    expect(program.commands.map((c) => c.name())).not.toContain('tool-empty');
  });

  it('isolates a tool whose spec fails to mount so the rest still mount', () => {
    const registry = makeRegistry();
    // A malformed spec (a required boolean flag) throws inside mountCommandSpec.
    registry.register({
      metadata: { id: 'tool-bad', name: 'bad', version: '0.0.0', description: 'bad' },
      commands: [{ name: 'bad', description: 'bad' }],
      commandSpecs: [
        {
          name: 'bad',
          description: 'bad',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          options: [{ flag: '--flag', description: 'boolean but required', required: true }],
          handler: () => Promise.resolve({ type: 'noop' }),
        },
      ] as never,
    } as never);
    registry.register(specTool('tool-good', 'good'));
    const program = new Command('opensip-tools');

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true);
    try {
      expect(() => mountAllToolCommands(registry, program, makeStubContext())).not.toThrow();
    } finally {
      process.stderr.write = origWrite;
    }
    // The good tool mounted despite the bad tool throwing.
    expect(program.commands.map((c) => c.name())).toContain('good');
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
        discoverAndRegisterToolPackages(registry, { sources: [{ dir: empty, mode: 'walkUp' }] }, new Set()),
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
          "export const tool = { metadata: { id: 'fixture-valid', name: 'Fixture', version: '0.0.0' }, commands: [], commandSpecs: [{ name: 'c', description: 'c', commonFlags: [], output: 'command-result', handler: () => Promise.resolve({}) }] };",
      }),
    );
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] }, BUILTIN_IDS);
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
      await discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] }, BUILTIN_IDS);
    } finally {
      restore();
    }
    expect(registry.list()).toHaveLength(0);
  });

  it('skips a discovered package with no resolvable entry point (no-entry)', async () => {
    // A package.json that declares a tool but ships no main/exports and no
    // index.js: `resolvePackageEntryPoint` → undefined, so `importToolRuntime`
    // returns the 'no-entry' reason and the loader skips it (3.0.0 shared path).
    const dir = join(FIXTURE_SCOPE, 'no-entry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@opensip-tools-fixture/no-entry',
        version: '0.0.0',
        type: 'module',
        opensipTools: { kind: 'tool' },
      }),
      'utf8',
    );
    staged.push({ name: '@opensip-tools-fixture/no-entry', dir });
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] }, BUILTIN_IDS);
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
          "export const tool = { metadata: { id: 'fitness', name: 'Shadow', version: '0.0.0' }, commands: [], commandSpecs: [{ name: 'c', description: 'c', commonFlags: [], output: 'command-result', handler: () => Promise.resolve({}) }] };",
      }),
    );
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] }, BUILTIN_IDS);
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
          { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] }, BUILTIN_IDS,
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
        discoverAndRegisterToolPackages(registry, { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] }, BUILTIN_IDS),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(registry.list()).toHaveLength(0);
  });
});
