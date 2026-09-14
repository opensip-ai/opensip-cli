/**
 * Regression: the pre-action hook must resolve the PROJECT-SELECTION options
 * (`--cwd`, `--config`) through Commander's globals-resolved view, not through
 * the action command's LOCAL option bag.
 *
 * This program never calls Commander's `enablePositionalOptions`, so options are
 * non-positional: a flag typed anywhere on the command line is consumed by the
 * OUTERMOST command in the chain that declares it. For `--cwd` / `--config` that
 * is the tool PRIMARY, never the nested `<tool> <verb>` child Commander hands the
 * hook as `actionCommand`. Reading `actionCommand.opts()` / `getOptionValueSource`
 * there returned the child's own seeded DEFAULTS:
 *
 *   - `opensip graph index --cwd /elsewhere` planned against `process.cwd()` and
 *     (against the argv-scanned startup lease) refused with a misleading
 *     "canonical project root changed during startup" error;
 *   - `opensip fit list --config ./other.yml` silently dropped `--config` and
 *     planned against the default project config.
 *
 * These tests drive the REAL Commander program + `installPreActionHook` +
 * `mountAllToolCommands` with a nested `<tool> <verb>` fixture command, so they
 * exercise the same wiring production uses. The pre-existing `--cwd`-source test
 * (`register-action-bodies.test.ts`) only covers flat top-level `init` and stubs
 * `cwdExplicit` by hand, so it cannot see this divergence.
 */

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILTIN_TRUST_POLICY } from '@opensip-cli/config';
import {
  LanguageRegistry,
  ToolRegistry,
  type ProjectContext,
  type Tool,
  type ToolCliContext,
} from '@opensip-cli/core';
import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildCommandScopeIndex } from '../../commands/command-scope-index.js';
import { PolicyAuditCollector } from '../policy-audit.js';
import { installPreActionHook } from '../pre-action-hook.js';
import { resetInitializedToolIdsForTest } from '../process-idempotency.js';
import { mountAllToolCommands } from '../register-tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** A real, valid project config — copied into each throwaway project root. */
const SAMPLE_CONFIG = join(HERE, '../../__tests__/fixtures/sample-project/opensip-cli.config.yml');

let priorHome: string | undefined;
let testHome: string;
/** Throwaway initialized project the `--cwd` flag points at. */
let targetProject: string;

beforeAll(() => {
  priorHome = process.env.HOME;
  testHome = mkdtempSync(join(tmpdir(), 'opensip-nested-opts-home-'));
  process.env.HOME = testHome;
  targetProject = mkdtempSync(join(tmpdir(), 'opensip-nested-opts-project-'));
  copyFileSync(SAMPLE_CONFIG, join(targetProject, 'opensip-cli.config.yml'));
});

afterAll(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  rmSync(testHome, { recursive: true, force: true });
  rmSync(targetProject, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetInitializedToolIdsForTest();
});

/** Opts the hook published onto the live option bag, as the handler saw them. */
interface ObservedOpts extends Record<string, unknown> {
  readonly projectContext?: ProjectContext;
  readonly cwdExplicit?: boolean;
}

/** Minimal handler-facing ToolCliContext (mount-only; no real seams exercised). */
function stubCtx(): ToolCliContext {
  return {
    project: {
      cwd: targetProject,
      cwdExplicit: false,
      projectRoot: targetProject,
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
  } as unknown as ToolCliContext;
}

/**
 * A tool with the production `<tool> <verb>` shape: a PRIMARY (`probe`, matching
 * `metadata.name` so the host decorates it with the guaranteed `--cwd`/`--config`)
 * and one nested child (`leaf`) that also declares `cwd` — exactly the collision
 * that made the child's locals diverge from what the user typed.
 */
function makeNestedTool(seen: ObservedOpts[]): Tool {
  const record = (rawOpts: unknown) => {
    seen.push(rawOpts as ObservedOpts);
    return { type: 'ok' };
  };
  return {
    identity: { name: 'probe-tool' },
    metadata: { id: 'probe-tool', name: 'probe', version: '0.0.0', description: 'fixture tool' },
    commands: [
      { name: 'probe', description: 'primary' },
      { name: 'leaf', description: 'nested verb', parent: 'probe' },
    ],
    commandSpecs: [
      {
        name: 'probe',
        description: 'primary',
        commonFlags: ['cwd'],
        scope: 'project',
        output: 'command-result',
        handler: record,
      },
      {
        name: 'leaf',
        description: 'nested verb',
        parent: 'probe',
        commonFlags: ['cwd'],
        scope: 'project',
        output: 'command-result',
        handler: record,
      },
    ] as never,
  };
}

/** Wire a fresh program with the real preAction hook + the fixture tool mounted. */
function buildProgram(tool: Tool): Command {
  const tools = new ToolRegistry();
  tools.register(tool);
  const program = new Command();
  program.exitOverride();
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

describe('preAction option resolution for nested <tool> <verb> commands', () => {
  it('resolves --cwd typed AFTER the nested verb (the parent primary consumed it)', async () => {
    const seen: ObservedOpts[] = [];
    const program = buildProgram(makeNestedTool(seen));

    await program.parseAsync(['node', 'cli', 'probe', 'leaf', '--cwd', targetProject], {
      from: 'node',
    });

    const opts = seen.at(-1);
    if (opts === undefined) throw new Error('the nested handler never ran');
    // Pre-fix the hook read `leaf`'s LOCAL `cwd` — its own seeded `process.cwd()`
    // default — so the plan resolved this repo's root, not the target project.
    expect(opts.projectContext?.projectRoot).toBe(targetProject);
    expect(opts.cwdExplicit).toBe(true);
  });

  it('resolves --cwd typed BEFORE the nested verb identically', async () => {
    const seen: ObservedOpts[] = [];
    const program = buildProgram(makeNestedTool(seen));

    await program.parseAsync(['node', 'cli', 'probe', '--cwd', targetProject, 'leaf'], {
      from: 'node',
    });

    const opts = seen.at(-1);
    if (opts === undefined) throw new Error('the nested handler never ran');
    expect(opts.projectContext?.projectRoot).toBe(targetProject);
    expect(opts.cwdExplicit).toBe(true);
  });

  it('honours --config on a nested verb (the flag is declared only on the primary)', async () => {
    const seen: ObservedOpts[] = [];
    const program = buildProgram(makeNestedTool(seen));
    const missingConfig = join(targetProject, 'definitely-absent.config.yml');

    // Strict `--config` semantics: an explicit path that does not exist must fail
    // the run. Pre-fix the nested verb's local `config` was always `undefined`
    // (only the primary declares the flag), so the hook silently fell back to the
    // project's default config and the run succeeded.
    await expect(
      program.parseAsync(
        ['node', 'cli', 'probe', 'leaf', '--cwd', targetProject, '--config', missingConfig],
        { from: 'node' },
      ),
    ).rejects.toMatchObject({
      name: 'BootstrapError',
      message: expect.stringContaining('does not exist'),
    });
    expect(seen).toHaveLength(0);
  });

  it('leaves a FLAT primary command unchanged (globals-resolved === locals there)', async () => {
    const seen: ObservedOpts[] = [];
    const program = buildProgram(makeNestedTool(seen));

    await program.parseAsync(['node', 'cli', 'probe', '--cwd', targetProject], { from: 'node' });

    const opts = seen.at(-1);
    if (opts === undefined) throw new Error('the primary handler never ran');
    expect(opts.projectContext?.projectRoot).toBe(targetProject);
    expect(opts.cwdExplicit).toBe(true);
  });

  it('keeps cwdExplicit false for a nested verb when no --cwd was typed', async () => {
    const seen: ObservedOpts[] = [];
    // Mount from inside the target project so the seeded `--cwd` DEFAULT (captured
    // at mount time) is that project — the "user ran from inside the repo" shape,
    // with no flag on the command line.
    const priorCwd = process.cwd();
    process.chdir(targetProject);
    let program: Command;
    try {
      program = buildProgram(makeNestedTool(seen));
    } finally {
      process.chdir(priorCwd);
    }

    await program.parseAsync(['node', 'cli', 'probe', 'leaf'], { from: 'node' });

    const opts = seen.at(-1);
    if (opts === undefined) throw new Error('the nested handler never ran');
    expect(opts.projectContext?.projectRoot).toBe(targetProject);
    expect(opts.cwdExplicit).toBe(false);
  });
});
