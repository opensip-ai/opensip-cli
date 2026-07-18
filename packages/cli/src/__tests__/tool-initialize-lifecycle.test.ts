/**
 * Tool.initialize() lifecycle test (audit P1a).
 *
 * The Tool contract documents initialize() as "called by the CLI before
 * any of the tool's commands run … at most once per process." Before this
 * fix it was declared, implemented (fitness no-op), and documented — but
 * never called by any composition root. This test pins the wiring: the
 * preAction hook resolves the tool owning the invoked subcommand and runs
 * its initialize() exactly once, before the action body, and fails the run
 * closed when initialize() throws.
 *
 * It drives the REAL Commander program + installPreActionHook against the
 * sample-project fixture (a valid project, so no no-project bailout), with
 * a fixture Tool handed to the hook via its `PreActionRuntime` closure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN_TRUST_POLICY } from '@opensip-cli/config';
import { LanguageRegistry, ToolRegistry, type Tool, type ToolCliContext } from '@opensip-cli/core';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PolicyAuditCollector } from '../bootstrap/policy-audit.js';
import { installPreActionHook, resolveOwningTool } from '../bootstrap/pre-action-hook.js';
import { resetInitializedToolIdsForTest } from '../bootstrap/process-idempotency.js';
import { mountAllToolCommands } from '../bootstrap/register-tools.js';
import { buildCommandScopeIndex } from '../commands/command-scope-index.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/sample-project');
let priorHome: string | undefined;
let testHome: string;

beforeAll(() => {
  priorHome = process.env.HOME;
  testHome = mkdtempSync(join(tmpdir(), 'opensip-tool-initialize-home-'));
  process.env.HOME = testHome;
});

afterAll(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(testHome, { recursive: true, force: true });
});

/** Minimal handler-facing ToolCliContext (no Commander program — 3.0.0). */
function stubCtx(): ToolCliContext {
  return {
    project: {
      cwd: FIXTURE,
      cwdExplicit: false,
      projectRoot: FIXTURE,
      configPath: undefined,
      walkedUp: 0,
      scope: 'none',
    },
    render: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    renderLive: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitEnvelope: vi.fn(),
    emitError: vi.fn(),
    deliverSignals: vi.fn(() => Promise.resolve({ cloudAccepted: 0 })),
    writeSarif: vi.fn(() => Promise.resolve()),
    datastore: undefined,
    // Mount-only stub: command handlers are never invoked in these tests, so
    // the remaining ToolCliContext seams (scope, baseline/artifact/toolState)
    // are intentionally omitted. Cast is compile-time only — no runtime change.
  } as unknown as ToolCliContext;
}

interface FixtureOpts {
  readonly throwOnInit?: boolean;
  readonly aliases?: readonly string[];
}

function makeFixtureTool(
  id: string,
  cmdName: string,
  events: string[],
  opts: FixtureOpts = {},
): Tool {
  return {
    identity: { name: id },
    metadata: { id, name: id, version: '0.0.0', description: 'fixture tool' },
    commands: [{ name: cmdName, description: 'fixture command', aliases: opts.aliases }],
    extensionPoints: {
      initialize: () => {
        events.push(`initialize:${id}`);
        return opts.throwOnInit ? Promise.reject(new Error('init boom')) : Promise.resolve();
      },
    },
    // 3.0.0: the command surface is the declarative commandSpec (register() gone).
    // The handler records the action; the host mounts it + the `--cwd` common flag.
    commandSpecs: [
      {
        name: cmdName,
        description: 'fixture command',
        aliases: opts.aliases ? [...opts.aliases] : undefined,
        commonFlags: ['cwd'],
        scope: 'project',
        output: 'command-result',
        handler: () => {
          events.push(`action:${cmdName}`);
          return { type: 'ok' };
        },
      },
    ] as never,
  };
}

function makeToolWithCommandSpecs(
  id: string,
  specs: readonly {
    readonly name: string;
    readonly parent?: string;
    readonly aliases?: readonly string[];
  }[],
): Tool {
  return {
    identity: { name: id },
    metadata: { id, name: id, version: '0.0.0', description: `${id} fixture` },
    commands: specs.map((spec) => ({
      name: spec.name,
      description: `${spec.name} command`,
      ...(spec.parent === undefined ? {} : { parent: spec.parent }),
      ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
    })),
    commandSpecs: specs.map((spec) => ({
      name: spec.name,
      description: `${spec.name} command`,
      ...(spec.parent === undefined ? {} : { parent: spec.parent }),
      ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
      commonFlags: ['cwd'],
      scope: 'project',
      output: 'command-result',
      handler: () => ({ type: 'ok' }),
    })) as never,
  };
}

/** Wire a program with the preAction hook + the fixture tool's mounted command. */
function buildProgram(tool: Tool): Command {
  const tools = new ToolRegistry();
  tools.register(tool);
  const program = new Command();
  program.exitOverride();
  // The hook captures the registries + admitted-tool facts in its closure
  // (the production shape after eliminating the module-global handoff bag);
  // this fixture run admits a single tool and no manifests/provenance.
  const actionScopeRunner = installPreActionHook(
    program,
    'test',
    {
      languages: new LanguageRegistry(),
      tools,
      manifests: [],
      provenance: [],
      bootstrapDiagnostics: [],
      trustPolicy: BUILTIN_TRUST_POLICY,
      policyAudit: new PolicyAuditCollector(),
    },
    buildCommandScopeIndex({
      toolSpecs: tool.commandSpecs ?? [],
      hostSpecs: [],
      hostGroups: [],
    }),
  );
  mountAllToolCommands(tools, program, stubCtx(), [], {}, actionScopeRunner);
  return program;
}

afterEach(() => {
  vi.restoreAllMocks();
  // Tool.initialize() idempotency is process-scoped; reset between tests so each
  // fixture tool's initialize() can run again (previously done as a side effect
  // of the removed setCliRegistriesForRun).
  resetInitializedToolIdsForTest();
});

describe('resolveOwningTool', () => {
  const events: string[] = [];

  it('matches a tool by its command name', () => {
    const tools = new ToolRegistry();
    tools.register(makeFixtureTool('t1', 'cmd-a', events));
    expect(resolveOwningTool(tools, 'cmd-a')?.metadata.id).toBe('t1');
  });

  it('matches a tool by a command alias', () => {
    const tools = new ToolRegistry();
    tools.register(makeFixtureTool('t2', 'cmd-b', events, { aliases: ['cb'] }));
    expect(resolveOwningTool(tools, 'cb')?.metadata.id).toBe('t2');
  });

  it('matches a nested command by the first command-path segment, not the leaf', () => {
    const tools = new ToolRegistry();
    tools.register(
      makeToolWithCommandSpecs('fit-tool', [{ name: 'fit' }, { name: 'list', parent: 'fit' }]),
    );
    tools.register(
      makeToolWithCommandSpecs('graph-tool', [
        { name: 'graph' },
        { name: 'list', parent: 'graph' },
      ]),
    );

    expect(resolveOwningTool(tools, 'graph list')?.metadata.id).toBe('graph-tool');
  });

  it('returns undefined for host command groups that share tool leaf names', () => {
    const tools = new ToolRegistry();
    tools.register(
      makeToolWithCommandSpecs('fit-tool', [{ name: 'fit' }, { name: 'list', parent: 'fit' }]),
    );

    expect(resolveOwningTool(tools, 'tools list')).toBeUndefined();
  });

  it('returns undefined for a command owned by no tool (CLI-only)', () => {
    const tools = new ToolRegistry();
    tools.register(makeFixtureTool('t3', 'cmd-c', events));
    expect(resolveOwningTool(tools, 'init')).toBeUndefined();
  });
});

describe('Tool.initialize() wiring (preAction)', () => {
  it('runs initialize() exactly once, before the action body', async () => {
    const events: string[] = [];
    const program = buildProgram(makeFixtureTool('order-tool', 'order-cmd', events));

    await program.parseAsync(['node', 'cli', 'order-cmd', '--cwd', FIXTURE], {
      from: 'node',
    });

    expect(events).toEqual(['initialize:order-tool', 'action:order-cmd']);
  });

  it('does not re-run initialize() on a second invocation (once per process)', async () => {
    const events: string[] = [];
    const program = buildProgram(makeFixtureTool('memo-tool', 'memo-cmd', events));

    await program.parseAsync(['node', 'cli', 'memo-cmd', '--cwd', FIXTURE], {
      from: 'node',
    });
    // The action-scope runner disposes and clears the first invocation before
    // Commander starts the second one in this same process.
    await program.parseAsync(['node', 'cli', 'memo-cmd', '--cwd', FIXTURE], {
      from: 'node',
    });

    // initialize once total; action twice.
    expect(events).toEqual(['initialize:memo-tool', 'action:memo-cmd', 'action:memo-cmd']);
  });

  it('fails the run closed (exit 1) when initialize() throws, without running the action', async () => {
    const events: string[] = [];
    const program = buildProgram(
      makeFixtureTool('boom-tool', 'boom-cmd', events, { throwOnInit: true }),
    );

    // 2.12.0 (§4.7): a tool-init failure THROWS a typed BootstrapError (exit 1)
    // for the top-level boundary to render — it no longer calls process.exit
    // itself. The throw propagates out of parseAsync here (this bare test program
    // installs no catch boundary).
    await expect(
      program.parseAsync(['node', 'cli', 'boom-cmd', '--cwd', FIXTURE], {
        from: 'node',
      }),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      exitCode: 1,
      message: expect.stringContaining('failed to initialize'),
    });

    // initialize attempted, but the action never ran.
    expect(events).toEqual(['initialize:boom-tool']);
  });
});
