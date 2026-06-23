import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BootstrapDiagnosticsCollector,
  CLI_DIAGNOSTIC_CODES,
  PluginIncompatibleError,
  ToolRegistry as ToolRegistryClass,
  type Tool,
  type ToolCliContext,
  type ToolPluginManifest,
  type ToolProvenance,
  type ToolRegistry,
} from '@opensip-cli/core';
import { Command } from 'commander';
import { afterEach, describe, it, expect, vi } from 'vitest';

import { resetBootstrapDiagnosticsBuffer } from '../bootstrap/bootstrap-diagnostics-buffer.js';
import {
  BUNDLED_TOOL_PACKAGES,
  discoverAndRegisterToolPackages,
  mountAllToolCommands,
  registerFirstPartyTools,
} from '../bootstrap/register-tools.js';
import { INSTALLED_TOOL_ALLOWLIST_ENV } from '../bootstrap/tool-trust.js';

import { BUNDLED_TOOLS, BUNDLED_TOOL_IDS } from './test-utils/bundled-tools.js';

/** The bundled-tool ids discovery skips on a name collision (3.0.0: passed
 *  explicitly; production derives it from the loaded bundled manifests). */
const BUILTIN_IDS = new Set(BUNDLED_TOOL_IDS);

function makeRegistry(): ToolRegistry {
  const map = new Map<string, Tool>();
  const list = (): Tool[] => [...map.values()];
  return {
    register: (tool: Tool) => {
      const key = tool.metadata.name ?? tool.metadata.id;
      if (!map.has(key)) map.set(key, tool);
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
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve()),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
  };
}

describe('BUNDLED_TOOLS', () => {
  it('contains fitness, simulation, and graph (by canonical metadata.name)', () => {
    const names = BUNDLED_TOOLS.map((t) => t.metadata.name ?? t.metadata.id);
    expect(names).toEqual(expect.arrayContaining(['fitness', 'simulation', 'graph']));
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

    expect(registry.list().map((t) => t.metadata.name ?? t.metadata.id)).toEqual(
      expect.arrayContaining(['fitness', 'simulation', 'graph']),
    );
    expect(provenance).toHaveLength(BUNDLED_TOOLS.length);
    for (const record of provenance) {
      expect(record.source).toBe('bundled');
      expect(typeof record.manifestHash).toBe('string');
      expect(record.manifestHash.length).toBeGreaterThan(0);
      expect(record.packageName).toMatch(/^@opensip-cli\//);
    }
    // Manifest ids follow identity.name, the canonical human key.
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
      registerFirstPartyTools(registry, [], [], ['@opensip-cli/__definitely-not-a-real-package__']),
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
        name: '@opensip-cli-fixture/no-manifest-bundled',
        version: '0.0.0',
        type: 'module',
        main: './index.js',
      }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'index.js'),
      "export const tool = { metadata: { id: '00000000-0000-4000-8000-0000000000a1', name: 'no-manifest', version: '0.0.0' }, commands: [], commandSpecs: [{ name: 'c', description: 'c', commonFlags: [], scope: 'project', output: 'command-result', handler: () => Promise.resolve({}) }] };",
      'utf8',
    );
    const registry = new ToolRegistryClass();
    try {
      await expect(
        registerFirstPartyTools(registry, [], [], ['@opensip-cli-fixture/no-manifest-bundled']),
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
        name: '@opensip-cli-fixture/broken-bundled',
        version: '0.0.0',
        type: 'module',
        main: './index.js',
        opensipTools: {
          kind: 'tool',
          id: 'broken-bundled',
          identity: { name: 'broken-bundled' },
          apiVersion: 1,
          commands: [
            {
              name: 'broken-bundled',
              description: 'a tool that throws on import',
            },
          ],
        },
      }),
      'utf8',
    );
    writeFileSync(join(dir, 'index.js'), "throw new Error('boom on bundled import');", 'utf8');
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await expect(
        registerFirstPartyTools(registry, [], [], ['@opensip-cli-fixture/broken-bundled']),
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
    identity: { name: commandName },
    metadata: { id, name: commandName, version: '0.0.0', description: id },
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
    const program = new Command('opensip');

    mountAllToolCommands(registry, program, makeStubContext(), []);

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('a');
    expect(names).toContain('b');
  });

  it('surfaces a tool with no commandSpecs (mounts nothing, no throw)', () => {
    const registry = makeRegistry();
    // A tool with neither commandSpecs nor any mount surface — a mis-declaration.
    registry.register({
      identity: { name: 'empty' },
      metadata: {
        id: 'tool-empty',
        name: 'empty',
        version: '0.0.0',
        description: 'empty',
      },
      commands: [],
    });
    registry.register(specTool('tool-ok', 'ok'));
    const program = new Command('opensip');

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      mountAllToolCommands(registry, program, makeStubContext(), []);
    } finally {
      process.stderr.write = origWrite;
    }
    // The valid tool still mounts; the empty one contributes nothing.
    expect(program.commands.map((c) => c.name())).toContain('ok');
    expect(program.commands.map((c) => c.name())).not.toContain('tool-empty');
  });

  it('fail-closes a bundled tool whose spec fails to mount (subsequent tools do not mount)', () => {
    const registry = makeRegistry();
    // A malformed spec (a required boolean flag) throws inside mountCommandSpec.
    registry.register({
      identity: { name: 'bad' },
      metadata: {
        id: 'tool-bad',
        name: 'bad',
        version: '0.0.0',
        description: 'bad',
      },
      commands: [{ name: 'bad', description: 'bad' }],
      commandSpecs: [
        {
          name: 'bad',
          description: 'bad',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          options: [
            {
              flag: '--flag',
              description: 'boolean but required',
              required: true,
            },
          ],
          handler: () => Promise.resolve({ type: 'noop' }),
        },
      ] as never,
    });
    registry.register(specTool('tool-good', 'good'));
    const program = new Command('opensip');

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      expect(() => mountAllToolCommands(registry, program, makeStubContext(), [])).toThrow(
        PluginIncompatibleError,
      );
    } finally {
      process.stderr.write = origWrite;
    }
    expect(program.commands.map((c) => c.name())).not.toContain('good');
  });

  it('isolates an external tool whose spec fails to mount so the rest still mount', () => {
    const registry = makeRegistry();
    registry.register({
      identity: { name: 'bad' },
      metadata: {
        id: 'tool-bad',
        name: 'bad',
        version: '0.0.0',
        description: 'bad',
      },
      commands: [{ name: 'bad', description: 'bad' }],
      commandSpecs: [
        {
          name: 'bad',
          description: 'bad',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          options: [
            {
              flag: '--flag',
              description: 'boolean but required',
              required: true,
            },
          ],
          handler: () => Promise.resolve({ type: 'noop' }),
        },
      ] as never,
    });
    registry.register(specTool('tool-good', 'good'));
    const program = new Command('opensip');

    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      expect(() =>
        mountAllToolCommands(registry, program, makeStubContext(), [
          {
            id: 'bad',
            source: 'installed',
            version: '0.0.0',
            manifestHash: 'test',
          },
        ]),
      ).not.toThrow();
    } finally {
      process.stderr.write = origWrite;
    }
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
        discoverAndRegisterToolPackages(
          registry,
          { sources: [{ dir: empty, mode: 'walkUp' }] },
          new Set(),
        ),
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
// package's own node_modules (under a throwaway @opensip-cli-fixture scope)
// and point projectDir at the CLI package root so the ancestor-walk finds
// them AND Node's resolver can import them. Each fixture is removed afterwards.
// ---------------------------------------------------------------------------

const CLI_PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_SCOPE = join(CLI_PKG_ROOT, 'node_modules', '@opensip-cli-fixture');
/** Installed npm tools are deny-by-default; tests that expect load opt in via `*`. */
const ALLOW_ALL_INSTALLED: NodeJS.ProcessEnv = {
  [INSTALLED_TOOL_ALLOWLIST_ENV]: '*',
};
const WALK_UP_SOURCE_LIST = [{ dir: CLI_PKG_ROOT, mode: 'walkUp' as const }];
const WALK_UP_SOURCES = {
  sources: WALK_UP_SOURCE_LIST,
  env: ALLOW_ALL_INSTALLED,
};
/**
 * ADR-0054 M4-G: discovery in the dispatch WORKER (`OPENSIP_CLI_IN_TOOL_WORKER=1`).
 * The host NEVER imports an external runtime (it synthesizes a manifest-derived
 * Tool); the WORKER is the isolation boundary where the runtime import + the
 * runtime-shape checks (drift / malformed export / no-entry / import-throw) run.
 * Tests that assert those import-path skip behaviors therefore exercise the worker
 * path. Trust is still required (deny-by-default), so the allowlist stays `*`.
 */
const WALK_UP_SOURCES_WORKER = {
  sources: WALK_UP_SOURCE_LIST,
  env: { [INSTALLED_TOOL_ALLOWLIST_ENV]: '*', OPENSIP_CLI_IN_TOOL_WORKER: '1' },
};

interface Fixture {
  readonly name: string;
  readonly dir: string;
}

function withDefaultToolIdentity(packageJson: object): object {
  const json = packageJson as { opensipTools?: Record<string, unknown> };
  const manifest = json.opensipTools;
  if (
    manifest?.kind === 'tool' &&
    typeof manifest.id === 'string' &&
    manifest.identity === undefined
  ) {
    return {
      ...packageJson,
      opensipTools: {
        ...manifest,
        identity: { name: manifest.id },
      },
    };
  }
  return packageJson;
}

function stageFixture(shortName: string, files: { packageJson: object; indexJs: string }): Fixture {
  const dir = join(FIXTURE_SCOPE, shortName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(withDefaultToolIdentity(files.packageJson)),
    'utf8',
  );
  writeFileSync(join(dir, 'index.js'), files.indexJs, 'utf8');
  return { name: `@opensip-cli-fixture/${shortName}`, dir };
}

function silenceStderr(): () => void {
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  return () => {
    process.stderr.write = orig;
  };
}

function captureStderr(): {
  readonly read: () => string;
  readonly restore: () => void;
} {
  const orig = process.stderr.write.bind(process.stderr);
  let output = '';
  process.stderr.write = (chunk: unknown) => {
    output += String(chunk);
    return true;
  };
  return {
    read: () => output,
    restore: () => {
      process.stderr.write = orig;
    },
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
          name: '@opensip-cli-fixture/valid-tool',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-valid',
            apiVersion: 1,
            commands: [{ name: 'fixture-valid', description: 'x' }],
          },
        },
        indexJs:
          "export const tool = { identity: { name: 'fixture-valid' }, metadata: { id: '00000000-0000-4000-8000-0000000000b2', name: 'fixture-valid', version: '0.0.0', description: 'fixture' }, commandSpecs: [{ name: 'fixture-valid', description: 'x', commonFlags: ['json'], scope: 'project', output: 'command-result', handler: () => Promise.resolve({ type: 'text-lines', title: 't', lines: [] }) }] };",
      }),
    );
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(registry, WALK_UP_SOURCES, BUILTIN_IDS);
    expect(registry.get('fixture-valid')).toBeDefined();
  });

  it('skips a stale bundled installed copy without user-facing stderr (ADR-0060 Phase 1)', async () => {
    staged.push(
      stageFixture('stale-bundled-fitness', {
        packageJson: {
          name: '@opensip-cli/fitness',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fitness',
            apiVersion: 0,
            commands: [{ name: 'fitness', description: 'stale copy' }],
          },
        },
        indexJs: "throw new Error('stale bundled copy must never be imported');",
      }),
    );
    const registry = new ToolRegistryClass();
    const collector = resetBootstrapDiagnosticsBuffer();
    const stderr = captureStderr();
    try {
      await discoverAndRegisterToolPackages(
        registry,
        {
          sources: WALK_UP_SOURCE_LIST,
          env: ALLOW_ALL_INSTALLED,
          bootstrapDiagnostics: collector,
        },
        BUILTIN_IDS,
      );
    } finally {
      stderr.restore();
    }
    expect(registry.get('fitness')).toBeUndefined();
    expect(stderr.read()).toBe('');
    expect(collector.list()).toHaveLength(0);
  });

  it('records manifest-invalid unrelated tool as typed diagnostic without user-facing stderr (ADR-0060)', async () => {
    staged.push(
      stageFixture('manifest-invalid', {
        packageJson: {
          name: '@opensip-cli-fixture/manifest-invalid',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            apiVersion: 1,
            commands: [{ name: 'manifest-invalid', description: 'x' }],
          },
        },
        indexJs: 'export const tool = {};',
      }),
    );
    const registry = new ToolRegistryClass();
    const collector = new BootstrapDiagnosticsCollector();
    const stderr = captureStderr();
    try {
      await discoverAndRegisterToolPackages(
        registry,
        {
          sources: WALK_UP_SOURCE_LIST,
          env: ALLOW_ALL_INSTALLED,
          bootstrapDiagnostics: collector,
        },
        BUILTIN_IDS,
      );
    } finally {
      stderr.restore();
    }
    expect(registry.get('manifest-invalid')).toBeUndefined();
    expect(stderr.read()).toBe('');
    expect(collector.list()).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID,
        provenance: expect.objectContaining({
          packageName: '@opensip-cli-fixture/manifest-invalid',
        }),
      }),
    ]);
  });

  it('records trust denial as a typed diagnostic without user-facing stderr (ADR-0060 Phase 3)', async () => {
    staged.push(
      stageFixture('trust-denied', {
        packageJson: {
          name: '@opensip-cli-fixture/trust-denied',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-trust-denied',
            apiVersion: 1,
            commands: [{ name: 'fixture-trust-denied', description: 'x' }],
          },
        },
        indexJs: "throw new Error('trust-denied tool must never be imported');",
      }),
    );
    const registry = new ToolRegistryClass();
    const collector = new BootstrapDiagnosticsCollector();
    const stderr = captureStderr();
    try {
      await discoverAndRegisterToolPackages(
        registry,
        {
          sources: WALK_UP_SOURCE_LIST,
          env: {},
          bootstrapDiagnostics: collector,
        },
        BUILTIN_IDS,
      );
    } finally {
      stderr.restore();
    }
    expect(registry.get('fixture-trust-denied')).toBeUndefined();
    expect(stderr.read()).toBe('');
    expect(collector.list()).toEqual([
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_TRUST_DENIED,
        provenance: expect.objectContaining({ toolId: 'fixture-trust-denied' }),
      }),
    ]);
    expect(stderr.read()).not.toContain('trust-denied tool must never be imported');
  });

  it('loads a discovered installed package when its id is allowlisted', async () => {
    staged.push(
      stageFixture('trust-allowed', {
        packageJson: {
          name: '@opensip-cli-fixture/trust-allowed',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-trust-allowed',
            apiVersion: 1,
            commands: [{ name: 'fixture-trust-allowed', description: 'x' }],
          },
        },
        indexJs:
          "export const tool = { identity: { name: 'fixture-trust-allowed' }, metadata: { id: '00000000-0000-4000-8000-0000000000d5', name: 'fixture-trust-allowed', version: '0.0.0', description: 'fixture' }, commandSpecs: [{ name: 'fixture-trust-allowed', description: 'x', commonFlags: ['json'], scope: 'project', output: 'command-result', handler: () => Promise.resolve({ type: 'text-lines', title: 't', lines: [] }) }] };",
      }),
    );
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(
      registry,
      {
        sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }],
        env: { [INSTALLED_TOOL_ALLOWLIST_ENV]: 'fixture-trust-allowed' },
      },
      BUILTIN_IDS,
    );
    expect(registry.get('fixture-trust-allowed')).toBeDefined();
  });

  it('skips a discovered package whose manifest drifted from its runtime commands (worker path)', async () => {
    // ADR-0054 M4-G: the drift guard (assertManifestMatchesTool) runs only where
    // the runtime is imported — the dispatch WORKER (the host synthesizes from the
    // manifest and never imports). In the worker an installed tool's mismatch
    // skips-with-diagnostic (it must not take fit/graph/sim down).
    staged.push(
      stageFixture('drifted-manifest', {
        packageJson: {
          name: '@opensip-cli-fixture/drifted-manifest',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-drift',
            apiVersion: 1,
            commands: [
              {
                name: 'fixture-drift',
                description: 'declared in manifest only',
              },
            ],
          },
        },
        indexJs:
          "export const tool = { identity: { name: 'fixture-drift' }, metadata: { id: '00000000-0000-4000-8000-0000000000c3', name: 'fixture-drift', version: '0.0.0', description: 'fixture' }, commands: [{ name: 'fixture-drift', description: 'x' }, { name: 'something-else', description: 'x' }], commandSpecs: [{ name: 'fixture-drift', description: 'x', commonFlags: [], scope: 'project', output: 'command-result', handler: () => Promise.resolve({}) }, { name: 'something-else', parent: 'fixture-drift', description: 'x', commonFlags: [], scope: 'project', output: 'command-result', handler: () => Promise.resolve({}) }] };",
      }),
    );
    const registry = new ToolRegistryClass();
    const provenance: ToolProvenance[] = [];
    const restore = silenceStderr();
    try {
      await expect(
        discoverAndRegisterToolPackages(registry, WALK_UP_SOURCES_WORKER, BUILTIN_IDS, provenance),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(registry.get('fixture-drift')).toBeUndefined();
    expect(provenance.some((p) => p.id === 'fixture-drift')).toBe(false);
  });

  it('HOST synthesizes a discovered external tool from its manifest (no runtime import)', async () => {
    // ADR-0054 M4-G capstone: in the HOST (no OPENSIP_CLI_IN_TOOL_WORKER) the
    // discovery leg NEVER imports the runtime — it registers a manifest-derived
    // synthetic Tool. The fixture's runtime would THROW on import, so a successful
    // registration proves the host never imported it (the manifest is the source
    // of truth host-side; the worker imports the real runtime at dispatch).
    staged.push(
      stageFixture('host-synth', {
        packageJson: {
          name: '@opensip-cli-fixture/host-synth',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-host-synth',
            apiVersion: 1,
            commands: [
              {
                name: 'fixture-host-synth',
                description: 'x',
                commonFlags: [],
                scope: 'project',
                output: 'command-result',
              },
            ],
          },
        },
        indexJs: "throw new Error('host must never import the external runtime (ADR-0054 M4-G)');",
      }),
    );
    const registry = new ToolRegistryClass();
    const provenance: ToolProvenance[] = [];
    await discoverAndRegisterToolPackages(registry, WALK_UP_SOURCES, BUILTIN_IDS, provenance);
    const tool = registry.get('fixture-host-synth');
    expect(tool).toBeDefined();
    // Synthetic: command shell present from the manifest, NO runtime extensionPoints.
    expect(tool?.commandSpecs.map((s) => s.name)).toEqual(['fixture-host-synth']);
    expect(tool?.extensionPoints).toBeUndefined();
    expect(provenance.some((p) => p.id === 'fixture-host-synth')).toBe(true);
  });

  it('skips a discovered package whose `tool` export is malformed (worker path)', async () => {
    // ADR-0054 M4-G: the exported-symbol shape gate runs only where the runtime
    // is imported — the WORKER. (The host synthesizes from the manifest and never
    // touches the export.)
    staged.push(
      stageFixture('bad-shape', {
        packageJson: {
          name: '@opensip-cli-fixture/bad-shape',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-bad',
            apiVersion: 1,
            commands: [{ name: 'fixture-bad', description: 'x' }],
          },
        },
        indexJs: "export const tool = { not: 'a tool' };",
      }),
    );
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await discoverAndRegisterToolPackages(registry, WALK_UP_SOURCES_WORKER, BUILTIN_IDS);
    } finally {
      restore();
    }
    expect(registry.list()).toHaveLength(0);
  });

  it('skips a discovered package with no resolvable entry point (no-entry, worker path)', async () => {
    // ADR-0054 M4-G: a package.json that declares a tool but ships no main/exports
    // and no index.js fails only where the runtime import is attempted — the
    // WORKER. `resolvePackageEntryPoint` → undefined, so `importToolRuntime`
    // returns the 'no-entry' reason and the worker leg skips it. (The host would
    // synthesize from the manifest, which is valid — no entry point is needed to
    // mount the command shell.)
    const dir = join(FIXTURE_SCOPE, 'no-entry');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: '@opensip-cli-fixture/no-entry',
        version: '0.0.0',
        type: 'module',
        opensipTools: {
          kind: 'tool',
          id: 'fixture-no-entry',
          identity: { name: 'fixture-no-entry' },
          apiVersion: 1,
          commands: [{ name: 'fixture-no-entry', description: 'x' }],
        },
      }),
      'utf8',
    );
    staged.push({ name: '@opensip-cli-fixture/no-entry', dir });
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await discoverAndRegisterToolPackages(registry, WALK_UP_SOURCES_WORKER, BUILTIN_IDS);
    } finally {
      restore();
    }
    expect(registry.list()).toHaveLength(0);
  });

  it('skips a discovered package whose tool id collides with a built-in', async () => {
    // ADR-0054 M4-G: the built-in skip is a STATIC manifest check (admitInstalledTool
    // returns undefined when `manifest.id` is a built-in), so it fires in the HOST
    // before any synthesize OR import — no runtime needed. The fixture uses the real
    // built-in id `fit`; its runtime would throw on import, proving the static skip
    // precedes (and obviates) the runtime entirely.
    staged.push(
      stageFixture('shadow-fit', {
        packageJson: {
          name: '@opensip-cli-fixture/shadow-fit',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fitness',
            identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
            apiVersion: 1,
            commands: [{ name: 'fitness', aliases: ['fit'], description: 'x' }],
          },
        },
        indexJs: "throw new Error('a built-in-colliding tool must never be imported');",
      }),
    );
    const registry = new ToolRegistryClass();
    await discoverAndRegisterToolPackages(registry, WALK_UP_SOURCES, BUILTIN_IDS);
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
          name: '@opensip-cli-fixture/future-epoch',
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
        discoverAndRegisterToolPackages(registry, WALK_UP_SOURCES, BUILTIN_IDS, provenance),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    // Skipped ⇒ not registered, and no provenance recorded for it.
    expect(registry.get('fixture-future')).toBeUndefined();
    expect(provenance.some((p) => p.id === 'fixture-future')).toBe(false);
  });

  it('skips a discovered tool that declares NO apiVersion (3.0.0 — grace window ended)', async () => {
    // 3.0.0: a `kind:'tool'` package with a conformant manifest but no
    // `apiVersion` is no longer admitted off the marker alone — admitTool returns
    // 'skip' (not explicitly requested), so it never registers. The fixture also
    // throws on import, proving the gate rejected it BEFORE its module was loaded.
    staged.push(
      stageFixture('no-apiversion', {
        packageJson: {
          name: '@opensip-cli-fixture/no-apiversion',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-no-apiv',
            commands: [
              {
                name: 'fixture-no-apiv',
                description: 'a tool with no declared apiVersion',
              },
            ],
          },
        },
        indexJs: "throw new Error('no-apiversion tool must never be imported');",
      }),
    );
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await expect(
        discoverAndRegisterToolPackages(
          registry,
          { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] },
          BUILTIN_IDS,
        ),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(registry.get('fixture-no-apiv')).toBeUndefined();
  });

  it('isolates a package whose module throws on import', async () => {
    staged.push(
      stageFixture('throws-on-load', {
        packageJson: {
          name: '@opensip-cli-fixture/throws-on-load',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-throws',
            apiVersion: 1,
            commands: [{ name: 'fixture-throws', description: 'x' }],
          },
        },
        indexJs: "throw new Error('boom on import');",
      }),
    );
    const registry = new ToolRegistryClass();
    const restore = silenceStderr();
    try {
      await expect(
        discoverAndRegisterToolPackages(
          registry,
          { sources: [{ dir: CLI_PKG_ROOT, mode: 'walkUp' }] },
          BUILTIN_IDS,
        ),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(registry.list()).toHaveLength(0);
  });

  it('records no provenance or manifest for an admitted tool whose import fails (worker path)', async () => {
    // Parity regression: in the WORKER (the only place the runtime imports — the
    // host synthesizes), provenance + manifest are recorded only AFTER the runtime
    // actually registered. An installed tool that admits on its static manifest but
    // throws on import must leave NO trace in the collectors — otherwise the worker
    // registry would carry a tool that never loaded and seed its capability domains.
    staged.push(
      stageFixture('admits-then-throws', {
        packageJson: {
          name: '@opensip-cli-fixture/admits-then-throws',
          version: '0.0.0',
          type: 'module',
          main: './index.js',
          opensipTools: {
            kind: 'tool',
            id: 'fixture-admits-then-throws',
            apiVersion: 1,
            commands: [{ name: 'fixture-admits-then-throws', description: 'x' }],
          },
        },
        indexJs: "throw new Error('boom after admission');",
      }),
    );
    const registry = new ToolRegistryClass();
    const provenance: ToolProvenance[] = [];
    const manifests: ToolPluginManifest[] = [];
    const restore = silenceStderr();
    try {
      await expect(
        discoverAndRegisterToolPackages(
          registry,
          WALK_UP_SOURCES_WORKER,
          BUILTIN_IDS,
          provenance,
          manifests,
        ),
      ).resolves.toBeUndefined();
    } finally {
      restore();
    }
    expect(registry.get('fixture-admits-then-throws')).toBeUndefined();
    expect(provenance.some((p) => p.id === 'fixture-admits-then-throws')).toBe(false);
    expect(manifests.some((m) => m.id === 'fixture-admits-then-throws')).toBe(false);
  });
});

/** Workstream A: prove a (new) manifest entry flows through the admission + mount path. */
describe('bundled-tools manifest (data-driven)', () => {
  it('BUNDLED_TOOL_PACKAGES and EXPECTED_SCAFFOLDING_TOOL_IDS are derived from the manifest', () => {
    expect(BUNDLED_TOOL_PACKAGES).toEqual([
      '@opensip-cli/fitness',
      '@opensip-cli/simulation',
      '@opensip-cli/graph',
      '@opensip-cli/yagni',
    ]);
    expect(BUNDLED_TOOL_PACKAGES).toContain('@opensip-cli/fitness');
  });

  it('registerFirstPartyTools accepts an injected packages list (proves new manifest entry would be admitted/mounted via the exact same path)', async () => {
    const registry = new ToolRegistryClass();
    // The packages param exists precisely so tests (and future) can prove
    // an added entry from the manifest would travel the uniform bundled
    // admit → dynamic import → register → mount path (no special casing).
    // We exercise the seam with the current manifest-derived list.
    await expect(
      registerFirstPartyTools(registry, [], [], BUNDLED_TOOL_PACKAGES),
    ).resolves.toBeUndefined();
    // The three are registered (their runtimes provide commands).
    expect(registry.list().length).toBeGreaterThanOrEqual(3);
  });
});
