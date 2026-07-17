/**
 * `agent-catalog` — the self-describing machine surface for AI agents. The
 * catalog builder is pure (no I/O), and the command adapter only reads the
 * current scope for optional project context, so they unit-test directly; the
 * command was previously only exercised via the subprocess surface, which is
 * coverage-invisible.
 */

import { RESERVED_SUITE_NAMES } from '@opensip-cli/config';
import {
  agentCatalogOverlayKeys,
  agentCatalogPlatformEntryPoints,
  assembleAgentCatalog,
  assertAgentCatalogOverlayKeys,
  commonFlags,
  hostSupportFromRuntimeProjection,
  summarizeTargetConventions,
  type AgentHostSupport,
} from '@opensip-cli/contracts';
import {
  PLATFORM_SUPPORT_CONTRACT_VERSION,
  projectRuntimeHostSupport,
  RunScope,
  ToolRegistry,
  runWithScopeSync,
  type CommandSpec,
  type TargetResolver,
  type Tool,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { registerFirstPartyTools } from '../bootstrap/register-tools.js';
import { HOST_RESERVED_ROOT_COMMANDS } from '../bootstrap/reserved-names.js';
import { buildAgentCatalog, executeAgentCatalog } from '../commands/agent-catalog.js';
import { buildTopLevelHostSpecs } from '../commands/host-command-specs.js';
import { buildHostSubcommandGroups } from '../commands/host-subcommand-groups.js';

import { BUNDLED_TOOLS } from './test-utils/bundled-tools.js';

import type { CliCommandsContext } from '../commands/shared.js';

/**
 * @throws Error when a public tool command is missing from the agent catalog.
 */
function assertCatalogCoversTools(
  catalog: ReturnType<typeof buildAgentCatalog>,
  tools: ToolRegistry,
): void {
  const commands = new Set(catalog.entryPoints.map((entry) => entry.command));
  const missing = tools
    .list()
    .flatMap((tool) =>
      (tool.commandSpecs ?? [])
        .filter(
          (spec) =>
            spec.parent === undefined &&
            spec.visibility !== 'internal' &&
            !/(?:-run-worker|-shard-worker|-equivalence-check)\b/.test(spec.name),
        )
        .map((spec) => spec.name),
    )
    .filter((name) => !commands.has(name));
  if (missing.length > 0) {
    throw new Error(`agent-catalog missing public tool entry point(s): ${missing.join(', ')}`);
  }
}

function assertJsonExamplesMatchToolFlagSurface(
  catalog: ReturnType<typeof buildAgentCatalog>,
  tools: ToolRegistry,
): void {
  const primarySpecs = new Map(
    tools
      .list()
      .flatMap((tool) => tool.commandSpecs ?? [])
      .filter(
        (spec) =>
          spec.parent === undefined &&
          spec.visibility !== 'internal' &&
          !/(?:-run-worker|-shard-worker|-equivalence-check)\b/.test(spec.name),
      )
      .map((spec) => [spec.name, spec]),
  );

  for (const entry of catalog.entryPoints.filter((candidate) => candidate.tier === 'tool')) {
    const spec = primarySpecs.get(entry.command);
    expect(spec, `catalog entry '${entry.command}' must map to a mounted primary`).toBeDefined();
    if (spec?.commonFlags?.includes('json') === true) continue;
    for (const example of entry.examples) {
      expect(example, `entry '${entry.command}' must not advertise unsupported --json`).not.toMatch(
        /\s--json(?:\s|$)/,
      );
    }
  }
}

function targetResolver(): TargetResolver {
  return {
    getByName: () => undefined,
    getAll: () => [
      {
        config: {
          name: 'app',
          description: 'Application',
          include: ['src/**/*.ts'],
          exclude: [],
          conventions: {
            entrypoints: ['src/routes/**', 'src/actions/**'],
            alwaysUsed: ['src/config/runtime.ts'],
            usedExports: [{ file: 'src/routes/page.ts', names: ['loader', 'action'] }],
          },
        },
      },
      {
        config: {
          name: 'plain',
          description: 'Plain',
          include: ['packages/**/*.ts'],
          exclude: [],
        },
      },
    ],
    getByTag: () => [],
    has: () => false,
    resolveTargets: () => [],
    applyGlobalExcludes: (files) => files,
    globalExcludes: [],
  };
}

async function makeRegistry(): Promise<ToolRegistry> {
  const tools = new ToolRegistry();
  await registerFirstPartyTools(tools);
  tools.register({
    identity: { name: 'third-party-tool' },
    metadata: {
      id: 'third-party-tool',
      name: 'third-party-tool',
      version: '0.0.0',
      description: 'fixture third-party tool',
    },
    commandSpecs: [
      {
        name: 'third-party-tool',
        description: 'run the third-party tool',
        commonFlags: [],
        scope: 'project',
        output: 'command-result',
        handler: () => ({ type: 'text-lines', lines: ['ok'] }),
      },
      {
        name: 'third-party-tool-worker',
        description: '[internal] worker',
        commonFlags: [],
        scope: 'project',
        output: 'raw-stream',
        rawStreamReason: 'worker-ipc',
        visibility: 'internal',
        handler: () => undefined,
      },
    ],
  } satisfies Tool);
  return tools;
}

interface CatalogCommandSurface {
  readonly spec: CommandSpec<unknown, unknown>;
  readonly flags: ReadonlySet<string>;
}

function longFlags(flags: string): readonly string[] {
  return flags.match(/--[a-z0-9-]+/g) ?? [];
}

function declaredFlags(spec: CommandSpec<unknown, unknown>): ReadonlySet<string> {
  const flags = new Set<string>();
  const commonFlagKeys = (spec as { readonly commonFlags?: readonly (keyof typeof commonFlags)[] })
    .commonFlags;
  for (const key of commonFlagKeys ?? []) {
    for (const flag of longFlags(commonFlags[key].flags)) flags.add(flag);
  }
  for (const option of spec.options ?? []) {
    for (const flag of longFlags(option.flag)) flags.add(flag);
  }
  return flags;
}

function addSurface(
  surfaces: Map<string, CatalogCommandSurface>,
  path: string,
  spec: CommandSpec<unknown, unknown>,
): void {
  surfaces.set(path, { spec, flags: declaredFlags(spec) });
}

function toolCommandSurfaces(tools: readonly Tool[]): Map<string, CatalogCommandSurface> {
  const surfaces = new Map<string, CatalogCommandSurface>();
  for (const tool of tools) {
    const specs = (tool.commandSpecs ?? []) as readonly CommandSpec<unknown, unknown>[];
    const primarySpecs = specs.filter((spec) => spec.parent === undefined);
    const primaryNames = new Map<string, readonly string[]>();
    for (const primary of primarySpecs) {
      const names = [
        primary.name,
        ...(primary.aliases ?? []),
        ...(tool.identity.name === primary.name ? (tool.identity.aliases ?? []) : []),
      ];
      primaryNames.set(primary.name, [...new Set(names)]);
      for (const name of names) addSurface(surfaces, name, primary);
    }

    for (const spec of specs.filter((candidate) => candidate.parent !== undefined)) {
      const parentNames = primaryNames.get(spec.parent ?? '') ?? [spec.parent ?? ''];
      const leafNames = [spec.name, ...(spec.aliases ?? [])];
      for (const parent of parentNames) {
        for (const leaf of leafNames) addSurface(surfaces, `${parent} ${leaf}`, spec);
      }
    }
  }
  return surfaces;
}

function hostCtx(tools?: ToolRegistry): CliCommandsContext {
  return {
    setExitCode: () => undefined,
    render: () => Promise.resolve(),
    emitJson: () => undefined,
    emitRaw: () => undefined,
    emitError: () => undefined,
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: () => undefined,
    ...(tools === undefined ? {} : { tools }),
  };
}

function hostCommandSurfaces(ctx: CliCommandsContext): Map<string, CatalogCommandSurface> {
  const surfaces = new Map<string, CatalogCommandSurface>();
  for (const spec of buildTopLevelHostSpecs(ctx)) {
    addSurface(surfaces, spec.name, spec as CommandSpec<unknown, unknown>);
    for (const alias of spec.aliases ?? []) {
      addSurface(surfaces, alias, spec as CommandSpec<unknown, unknown>);
    }
  }
  for (const group of buildHostSubcommandGroups(ctx)) {
    for (const leaf of group.leaves) {
      addSurface(surfaces, `${group.name} ${leaf.name}`, leaf as CommandSpec<unknown, unknown>);
      for (const alias of leaf.aliases ?? []) {
        addSurface(surfaces, `${group.name} ${alias}`, leaf as CommandSpec<unknown, unknown>);
      }
    }
  }
  return surfaces;
}

function combinedCommandSurfaces(tools: ToolRegistry): Map<string, CatalogCommandSurface> {
  return new Map([...toolCommandSurfaces(tools.list()), ...hostCommandSurfaces(hostCtx(tools))]);
}

function exampleSegments(example: string): readonly string[] {
  return example.split('&&').map((segment) => segment.trim());
}

function resolveExampleCommand(
  segment: string,
  surfaces: ReadonlyMap<string, CatalogCommandSurface>,
): {
  readonly command: string;
  readonly surface: CatalogCommandSurface;
  readonly tokens: readonly string[];
} {
  const tokens = segment.split(/\s+/);
  expect(tokens[0], `catalog example must start with opensip: ${segment}`).toBe('opensip');
  for (let length = Math.min(3, tokens.length - 1); length >= 1; length--) {
    const command = tokens.slice(1, 1 + length).join(' ');
    const surface = surfaces.get(command);
    if (surface !== undefined) return { command, surface, tokens };
  }
  throw new Error(`catalog example does not name a mounted command: ${segment}`);
}

function exampleFlags(tokens: readonly string[]): readonly string[] {
  return tokens.filter((token) => token.startsWith('--'));
}

describe('buildAgentCatalog', () => {
  it('returns a stable, fully-populated catalog from the live registry', async () => {
    const tools = await makeRegistry();
    const c = buildAgentCatalog({ tools });
    expect(c.version).toBe('1.0.0');
    expect(c.description).toMatch(/AI agents/i);
    // Every documented entry point carries at least one example.
    expect(c.entryPoints.length).toBeGreaterThanOrEqual(6);
    for (const e of c.entryPoints) {
      expect(e.command).toBeTruthy();
      expect(e.description).toBeTruthy();
      expect(e.examples.length).toBeGreaterThan(0);
    }
    expect(c.entryPoints.map((e) => e.command)).toEqual(
      expect.arrayContaining([
        'fitness',
        'graph',
        'mcp',
        'simulation',
        'yagni',
        'third-party-tool',
        'suite run',
        'status',
        'sessions list',
        'sessions show',
        'agent-catalog',
      ]),
    );
    assertCatalogCoversTools(c, tools);
    assertJsonExamplesMatchToolFlagSurface(c, tools);
    expect(c.entryPoints.find((entry) => entry.command === 'mcp')?.examples).toEqual([
      'opensip mcp',
    ]);
  });

  it('keeps curated tool overlay keys matched to bundled public primaries or aliases', () => {
    const tools = new ToolRegistry();
    for (const tool of BUNDLED_TOOLS) tools.register(tool);

    expect(agentCatalogOverlayKeys()).toEqual(['fitness', 'graph', 'sim', 'yagni']);
    expect(() => assertAgentCatalogOverlayKeys(tools)).not.toThrow();
    const c = buildAgentCatalog({ tools, validateOverlays: true });
    expect(c.entryPoints.find((entry) => entry.command === 'simulation')?.examples).toEqual([
      'opensip sim --json',
      'opensip sim --recipe default --json',
    ]);
  });

  it('keeps platform catalog entries backed by mounted host command specs', () => {
    const mounted = hostCommandSurfaces(hostCtx());
    for (const entry of agentCatalogPlatformEntryPoints()) {
      expect(mounted.has(entry.command), `missing mounted host spec for '${entry.command}'`).toBe(
        true,
      );
    }
  });

  it('keeps catalog examples within declared command flag surfaces', async () => {
    const tools = await makeRegistry();
    const surfaces = combinedCommandSurfaces(tools);
    const catalog = buildAgentCatalog({ tools, validateOverlays: true });
    const examples = [
      ...catalog.entryPoints.flatMap((entry) => entry.examples),
      ...catalog.commonPatterns.map((pattern) => pattern.example),
    ];

    for (const example of examples) {
      for (const segment of exampleSegments(example)) {
        const { command, surface, tokens } = resolveExampleCommand(segment, surfaces);
        for (const flag of exampleFlags(tokens)) {
          expect(
            surface.flags.has(flag),
            `example '${segment}' uses undeclared flag '${flag}' for '${command}'`,
          ).toBe(true);
        }
      }
    }
  });

  it('omits tools without a public primary command', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'internal-only-tool' },
      metadata: {
        id: 'internal-only-tool',
        name: 'internal-only-tool',
        version: '0.0.0',
        description: 'fixture internal-only tool',
      },
      commandSpecs: [
        {
          name: 'internal-only-run-worker',
          description: '[internal] worker',
          commonFlags: [],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'worker-ipc',
          visibility: 'internal',
          handler: () => undefined,
        },
      ],
    } satisfies Tool);

    const c = buildAgentCatalog({ tools });
    expect(c.entryPoints.map((entry) => entry.command)).not.toContain('internal-only-run-worker');
  });

  it('honors the host-provided internal command denylist', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'hidden-tool' },
      metadata: {
        id: 'hidden-tool',
        name: 'hidden-tool',
        version: '0.0.0',
        description: 'fixture hidden tool',
      },
      commandSpecs: [
        {
          name: 'hidden-tool',
          description: 'hidden by host policy',
          commonFlags: [],
          scope: 'project',
          output: 'command-result',
          handler: () => ({ type: 'text-lines', lines: ['hidden'] }),
        },
      ],
    } satisfies Tool);

    const c = buildAgentCatalog({
      tools,
      internalCommands: new Set(['hidden-tool']),
    });
    expect(c.entryPoints.map((entry) => entry.command)).not.toContain('hidden-tool');
  });

  // tool-command-surface-taxonomy Task 4.5 — the catalog is grouped by tier and
  // never surfaces a Tier-3 internal command.
  describe('command taxonomy — tiered + no Tier-3 leakage', () => {
    /** The Tier-3 internal command-name shapes that must never be catalogued. */
    const INTERNAL_RE = /(?:-run-worker|-shard-worker|-equivalence-check)\b/;

    it('annotates every entry point with a non-internal taxonomy tier', async () => {
      const c = buildAgentCatalog({ tools: await makeRegistry() });
      for (const e of c.entryPoints) {
        // Task 1.4 grouped the surface by tier; each entry carries the predictable
        // Tier-1 (platform) / Tier-2 (tool) shape — and NEVER 'internal'.
        expect(e.tier, `entry '${e.command}' must declare a tier`).toBeDefined();
        expect(['platform', 'tool']).toContain(e.tier);
        expect(e.tier).not.toBe('internal');
      }
      // The catalog exposes both tiers (it is genuinely grouped, not all-one-tier).
      const tiers = new Set(c.entryPoints.map((e) => e.tier));
      expect(tiers.has('platform')).toBe(true);
      expect(tiers.has('tool')).toBe(true);
    });

    it('fit/graph are tool-tier; the host commands are platform-tier', async () => {
      const c = buildAgentCatalog({ tools: await makeRegistry() });
      const tierOf = (command: string) => c.entryPoints.find((e) => e.command === command)?.tier;
      expect(tierOf('fitness')).toBe('tool');
      expect(tierOf('graph')).toBe('tool');
      expect(tierOf('suite run')).toBe('platform');
      expect(tierOf('sessions list')).toBe('platform');
      expect(tierOf('sessions show')).toBe('platform');
      expect(tierOf('agent-catalog')).toBe('platform');
    });

    it('no entry point or common pattern references an internal command name', () => {
      const c = buildAgentCatalog({ tools: new ToolRegistry() });
      for (const e of c.entryPoints) {
        expect(INTERNAL_RE.test(e.command), `entry '${e.command}' must not be internal`).toBe(
          false,
        );
        for (const ex of e.examples) {
          expect(INTERNAL_RE.test(ex), `example '${ex}' must not name an internal command`).toBe(
            false,
          );
        }
      }
      for (const p of c.commonPatterns) {
        expect(INTERNAL_RE.test(p.example), `pattern '${p.example}' must not be internal`).toBe(
          false,
        );
      }
    });

    it('does not advertise the removed flat export verbs as entry points', () => {
      const c = buildAgentCatalog({ tools: new ToolRegistry() });
      const commands = c.entryPoints.map((e) => e.command);
      for (const removed of [
        'sarif-export',
        'catalog-export',
        'graph-baseline-export',
        'fit-baseline-export',
      ]) {
        expect(commands, `removed '${removed}' must not be an entry point`).not.toContain(removed);
      }
    });
  });

  it('describes the common agent patterns and output shapes', () => {
    const c = buildAgentCatalog({ tools: new ToolRegistry() });
    expect(c.commonPatterns.length).toBeGreaterThan(0);
    for (const p of c.commonPatterns) {
      expect(p.name).toBeTruthy();
      expect(p.example).toMatch(/^opensip /);
    }
    expect(c.commonPatterns.some((p) => p.example === 'opensip audit --json')).toBe(true);
    expect(c.entryPoints.filter((entry) => entry.command === 'audit')).toHaveLength(1);
    expect(c.outputShapes.signalEnvelope).toMatch(/SignalEnvelope|schemaVersion/);
    expect(c.outputShapes.reviewBrief).toMatch(/reviewBrief|version: 1/);
    expect(c.outputShapes.reviewBrief).toMatch(/correlatedRisks/);
    expect(c.outputShapes.reviewBrief).toMatch(/verification/);
    expect(c.outputShapes.taskContext).toMatch(/contextManifest/);
    expect(c.outputShapes.taskContext).toMatch(/fileScope\.status/);
    expect(c.outputShapes.taskContext).toMatch(/createdAt/);
    expect(c.outputShapes.taskContext).toMatch(/projectIdentity/);
    expect(c.outputShapes.taskContext).toMatch(/freshness,coverage,caps/);
    expect(c.outputShapes.taskContext).toMatch(/available \+ matched \+ ready/);
    expect(c.notes.some((note) => note.includes('same explicit project-relative files'))).toBe(
      true,
    );
    expect(c.outputShapes.sessionReplay).toMatch(/fidelity/);
    expect(c.outputShapes.history).toMatch(/history/);
    expect(c.notes.length).toBeGreaterThan(0);
  });

  it('surfaces agent recipes and the read-latest-result workflow', async () => {
    const c = buildAgentCatalog({ tools: await makeRegistry() });
    expect(c.commonPatterns.some((p) => p.name.toLowerCase().includes('read-latest'))).toBe(true);
    expect(c.commonPatterns.some((p) => p.example.includes('agent-fast'))).toBe(true);
    expect(c.commonPatterns.some((p) => p.example.includes('opensip audit'))).toBe(true);
    expect(c.notes.some((n) => n.includes('agent-fast'))).toBe(true);
    expect(c.notes.some((n) => n.includes('graph impact'))).toBe(true);
    expect(c.notes.some((n) => n.includes('fullyVerified'))).toBe(true);
  });

  it('omits project context when no convention summary is provided', () => {
    const c = buildAgentCatalog({ tools: new ToolRegistry() });
    expect(c.projectContext).toBeUndefined();
  });

  it('includes bounded target convention counts when provided', () => {
    const c = buildAgentCatalog({
      tools: new ToolRegistry(),
      projectContext: {
        targetConventions: [
          {
            target: 'app',
            entrypointCount: 2,
            alwaysUsedCount: 1,
            usedExportCount: 2,
          },
        ],
      },
    });
    expect(c.projectContext?.targetConventions).toEqual([
      {
        target: 'app',
        entrypointCount: 2,
        alwaysUsedCount: 1,
        usedExportCount: 2,
      },
    ]);
  });
});

describe('executeAgentCatalog', () => {
  it('wraps the full catalog in a machine result under --json', async () => {
    const tools = await makeRegistry();
    const out = executeAgentCatalog({ json: true, tools });
    expect(out.type).toBe('agent-catalog');
    expect(out).toHaveProperty('catalog');
    const { catalog } = out as {
      catalog: ReturnType<typeof buildAgentCatalog>;
    };
    // The host wrapper injects the reserved-name lists (ADR-0159) and the
    // process-only host-support projection (Plan 02) the bare contracts builder
    // cannot know about; the rest must match the pure builder exactly.
    const { reservedNames, hostSupport, ...rest } = catalog;
    expect(rest).toEqual(buildAgentCatalog({ tools }));
    expect(reservedNames?.rootCommands).toContain('audit');
    expect(reservedNames?.rootCommands).toContain('init');
    expect(reservedNames?.suiteNames).toEqual(['audit', 'agent-context']);
    // hostSupport is always injected from live process facts. It is honest:
    // never an exact match (npm/filesystem/install-channel are unobserved at
    // runtime), it carries the support-contract version, and its status stays
    // within the closed vocabulary. It never claims `supported` unless the
    // registry row itself does (macOS is preview at launch).
    expect(hostSupport).toBeDefined();
    expect(hostSupport?.supportContractVersion).toBe(PLATFORM_SUPPORT_CONTRACT_VERSION);
    expect(['partial', 'none']).toContain(hostSupport?.match);
    expect(hostSupport?.match).not.toBe('exact');
    expect(['supported', 'preview', 'unqualified', 'unsupported']).toContain(hostSupport?.status);
  });

  it('returns a concise text summary in human mode (no --json)', async () => {
    const out = executeAgentCatalog({ tools: await makeRegistry() });
    expect(out.type).toBe('text-lines');
    const lines = (out as { lines: string[] }).lines;
    expect(lines[0]).toMatch(/Agent Catalog/);
    // Each common pattern surfaces as a bullet; key entry points are summarized.
    expect(lines.some((l) => l.includes('•'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Key entry points:'))).toBe(true);
  });

  it('defaults to the human summary when given no options', () => {
    expect(executeAgentCatalog({}).type).toBe('text-lines');
  });

  it('adds scoped target convention counts to JSON output when available', () => {
    const scope = new RunScope();
    Object.assign(scope, { targets: targetResolver() });

    const out = runWithScopeSync(scope, () => executeAgentCatalog({ json: true }));

    expect(out.type).toBe('agent-catalog');
    const { catalog } = out as {
      catalog: ReturnType<typeof buildAgentCatalog>;
    };
    expect(catalog.projectContext?.targetConventions).toEqual([
      {
        target: 'app',
        entrypointCount: 2,
        alwaysUsedCount: 1,
        usedExportCount: 2,
      },
    ]);
  });
});

// The Plan 03 catalog-parity seam: the CLI and MCP composition roots both use
// `assembleAgentCatalog` and derive `hostSupport` from the SAME core projection
// via the SAME contracts mapper. Feeding identical process facts must produce
// EQUAL full AgentCatalog objects (including hostSupport), not merely equal
// hostSupport payloads. (The MCP read port's forwarding half is proven in
// packages/mcp/src/__tests__/session-results-read-port.test.ts.)
describe('CLI↔MCP catalog parity (Plan 03 handoff)', () => {
  /** The exact live-process projection both composition roots compute. */
  function liveHostSupport(): AgentHostSupport {
    return hostSupportFromRuntimeProjection(
      projectRuntimeHostSupport({
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        nodeAbi: process.versions.modules,
      }),
      PLATFORM_SUPPORT_CONTRACT_VERSION,
    );
  }

  /** The complete common body both production composition roots assemble. */
  function commonCatalog(tools: ToolRegistry, hostSupport: AgentHostSupport) {
    return assembleAgentCatalog({
      tools,
      hostSupport,
      rootCommands: [...HOST_RESERVED_ROOT_COMMANDS].sort(),
      suiteNames: RESERVED_SUITE_NAMES,
    });
  }

  it('CLI executeAgentCatalog equals the complete common catalog for identical facts', async () => {
    const tools = await makeRegistry();
    const out = executeAgentCatalog({ json: true, tools });
    const { catalog } = out as { catalog: ReturnType<typeof buildAgentCatalog> };

    // Plan 03 makes reserved names part of the common body; MCP adds only its
    // top-level connector overlay after this complete projection is assembled.
    const common = commonCatalog(tools, liveHostSupport());
    expect(catalog).toEqual(common);
    expect(catalog.reservedNames).toBeDefined();
    // Prove the equality is not vacuous: hostSupport is present, additive, and
    // identical on both sides (the load-bearing Plan 03 field).
    expect(catalog.hostSupport).toBeDefined();
    expect(catalog.hostSupport).toEqual(common.hostSupport);
    expect(catalog.hostSupport).toEqual(liveHostSupport());
    expect(JSON.stringify(catalog.hostSupport)).toBe(JSON.stringify(common.hostSupport));
  });

  it('the shared hostSupport is honest: contract-versioned, never exact, closed vocabulary', async () => {
    const tools = await makeRegistry();
    const hostSupport = commonCatalog(tools, liveHostSupport()).hostSupport;
    expect(hostSupport?.supportContractVersion).toBe(PLATFORM_SUPPORT_CONTRACT_VERSION);
    expect(hostSupport?.match).not.toBe('exact');
    expect(['partial', 'none']).toContain(hostSupport?.match);
    expect(['supported', 'preview', 'unqualified', 'unsupported']).toContain(hostSupport?.status);
  });

  // Plan 03 Task 1.1/2.1: the CLI adapter must route through the SAME contracts
  // `assembleAgentCatalog` seam MCP uses. These prove the CLI's rendered catalog
  // is byte-for-byte what the shared assembler produces for the CLI's
  // authoritative inputs — a full-object comparison, not a hand-picked subset.
  it('executeAgentCatalog(--json) deep-equals the shared assembler result (no scope)', async () => {
    const tools = await makeRegistry();
    const out = executeAgentCatalog({ json: true, tools });
    const { catalog } = out as { catalog: ReturnType<typeof buildAgentCatalog> };
    // The CLI's authority inputs: its sorted static reserved roots (ADR-0159),
    // config's reserved suite names, and the live process-only hostSupport.
    const assembled = assembleAgentCatalog({
      tools,
      rootCommands: [...HOST_RESERVED_ROOT_COMMANDS].sort(),
      suiteNames: RESERVED_SUITE_NAMES,
      hostSupport: liveHostSupport(),
    });
    expect(catalog).toEqual(assembled);
    // No entered scope → no project context on either side.
    expect(catalog.projectContext).toBeUndefined();
  });

  it('routes reserved names + bounded target conventions through the assembler (entered scope)', () => {
    const scope = new RunScope();
    Object.assign(scope, { targets: targetResolver() });
    const out = runWithScopeSync(scope, () => executeAgentCatalog({ json: true }));
    const { catalog } = out as { catalog: ReturnType<typeof buildAgentCatalog> };
    const assembled = assembleAgentCatalog({
      rootCommands: [...HOST_RESERVED_ROOT_COMMANDS].sort(),
      suiteNames: RESERVED_SUITE_NAMES,
      hostSupport: liveHostSupport(),
      projectContext: { targetConventions: summarizeTargetConventions(targetResolver()) },
    });
    expect(catalog).toEqual(assembled);
    // The deterministic reserved-name shape flows through the shared path.
    expect(catalog.reservedNames?.suiteNames).toEqual(['audit', 'agent-context']);
    expect(catalog.reservedNames?.rootCommands).toEqual([...HOST_RESERVED_ROOT_COMMANDS].sort());
    expect(catalog.projectContext?.targetConventions.length).toBeGreaterThan(0);
  });
});
