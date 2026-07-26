/**
 * Trusted-surface Commander probe.
 *
 * Host and bundled command declarations are immutable code shipped with this
 * binary, so they may be mounted before runtime coordination. The probe runs
 * Commander with captured output and a preAction sentinel:
 *
 * - help, version, and parse failures on that trusted surface are final and
 *   require no project/user discovery or runtime lease;
 * - a valid action falls through to the normal leased bootstrap;
 * - an unknown root verb also falls through because it may name an installed
 *   or authored Tool. Unknown nested verbs on a known bundled/host command are
 *   final parse failures because external Tools cannot extend that surface.
 */

import {
  LanguageRegistry,
  LoggerImpl,
  RunScope,
  SystemError,
  ToolRegistry,
  generatePrefixedId,
  inspectRuntimePromotionRecoveryHeader,
  logger,
} from '@opensip-cli/core';
import { CommanderError, type Command } from 'commander';

import { buildToolCliContext, createLiveViewRegistry, getOrOpenDatastore } from '../cli-context.js';
import { buildInitRecoverySpec } from '../commands/host-command-specs.js';
import { registerCliCommands } from '../commands/index.js';
import { mountCommandSpec } from '../commands/mount-command-spec.js';
import { handleParseError } from '../error-handler.js';
import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { buildCommandRegistrationInput } from './build-command-registration-input.js';
import { createCommandActionScopeRunner } from './pre-action-hook.js';
import { mountAllToolCommands } from './register-tools-mount.js';
import { renderResult } from './render.js';
import { executeReportOpen } from './report.js';
import { resolveStartupProjectSelection } from './startup-runtime-lease.js';

import { bootstrapCli } from './index.js';

import type { ToolRuntimeExecutionMode } from './worker-datastore.js';
import type { CliCommandsContext } from '../commands/shared.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const PROBE_LIMIT = hostErrorCatalog.require('SYSTEM.HOST.PROBE_LIMIT');

class ContinueToLeasedBootstrap extends Error {
  constructor() {
    super('trusted command probe reached an action');
    this.name = 'ContinueToLeasedBootstrap';
  }
}

const MAX_CAPTURED_COMMANDER_OUTPUT_BYTES = 256 * 1024;

export interface LightweightCommandProbeInput {
  readonly program: Command;
  readonly argv: readonly string[];
  readonly projectDir: string;
  readonly cwd: string;
  readonly cliEntryUrl: string;
  readonly runtimeMode: ToolRuntimeExecutionMode;
}

function flushCapturedOutput(stdout: readonly string[], stderr: readonly string[]): void {
  for (const chunk of stdout) process.stdout.write(chunk);
  for (const chunk of stderr) process.stderr.write(chunk);
}

function createBoundedOutputCapture(): {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly writeOut: (chunk: string) => void;
  readonly writeErr: (chunk: string) => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let capturedBytes = 0;
  const append = (target: string[], chunk: string): void => {
    capturedBytes += Buffer.byteLength(chunk);
    if (capturedBytes > MAX_CAPTURED_COMMANDER_OUTPUT_BYTES) {
      throw new SystemError('Trusted command probe output exceeded its safety bound.', {
        code: PROBE_LIMIT.code,
        definition: PROBE_LIMIT,
        metadata: { condition: 'output-limit' },
      });
    }
    target.push(chunk);
  };
  return {
    stdout,
    stderr,
    writeOut: (chunk) => append(stdout, chunk),
    writeErr: (chunk) => append(stderr, chunk),
  };
}

function commandIsKnown(program: Command, name: string): boolean {
  return program.commands.some(
    (command) => command.name() === name || command.aliases().includes(name),
  );
}

interface RootOperand {
  readonly index: number;
  readonly value: string;
}

/**
 * Find the first token Commander would treat as a root operand. Returning no
 * operand also covers terminal root options: neither case needs Tool discovery.
 */
function findRootOperand(argv: readonly string[]): RootOperand | undefined {
  let optionsEnded = false;
  for (const [index, argument] of argv.entries()) {
    if (optionsEnded) return { index, value: argument };
    if (argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') return undefined;
    if (argument === '--no-cloud' || argument === '--no-plugins') continue;
    // Any other option before the first operand belongs to the root parser.
    // Let Commander produce its authoritative help/parse result.
    if (argument.startsWith('-')) return undefined;
    return { index, value: argument };
  }
  return undefined;
}

function helpTargetRequiresDiscovery(
  program: Command,
  argv: readonly string[],
  helpIndex: number,
): boolean {
  for (let targetIndex = helpIndex + 1; targetIndex < argv.length; targetIndex += 1) {
    const target = argv[targetIndex] ?? '';
    if (target === '--') continue;
    if (target.startsWith('-')) return false;
    return !commandIsKnown(program, target);
  }
  return false;
}

/**
 * Decide before Commander parses whether the first root operand can only be an
 * installed/authored command. Commander renders root help for
 * `unknown --help`, so waiting for its error code would lose the distinction
 * between root-terminal `--help unknown` and external-command
 * `unknown --help`.
 */
function unknownRootRequiresDiscovery(program: Command, argv: readonly string[]): boolean {
  const operand = findRootOperand(argv);
  if (operand === undefined) return false;
  if (operand.value !== 'help') return !commandIsKnown(program, operand.value);

  // `help <target>` may name an installed/authored command. A help/invalid
  // option before its target is terminal on the trusted root surface.
  return helpTargetRequiresDiscovery(program, argv, operand.index);
}

function createProbeToolContext() {
  return buildToolCliContext({
    render: renderResult,
    liveViews: createLiveViewRegistry(logger),
    maybeOpenReport: executeReportOpen,
    logger,
  });
}

/**
 * Recovery must be reachable before the ordinary trusted-surface probe imports
 * bundled Tool runtimes. This context carries only the established output/error
 * seams. Any accidental datastore access fails loud instead of silently
 * materializing runtime state before recovery has acquired exclusive authority.
 */
function createInitRecoveryCommandContext(
  handle: ReturnType<typeof createProbeToolContext>,
): CliCommandsContext {
  return {
    setExitCode: handle.ctx.setExitCode,
    getExitCode: handle.getExitCode,
    render: renderResult,
    reportFailure: handle.ctx.reportFailure,
    emitJson: handle.ctx.emitJson,
    emitRaw: handle.ctx.emitRaw,
    emitError: handle.ctx.emitError,
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: () => {
      throw new SystemError('The lean Init recovery probe cannot open the datastore.', {
        code: PROBE_LIMIT.code,
        definition: PROBE_LIMIT,
        metadata: { condition: 'recovery-datastore' },
      });
    },
  };
}

function createInitRecoveryScope(
  project: ReturnType<typeof resolveStartupProjectSelection>['project'],
  debug: boolean,
): RunScope {
  const runId = generatePrefixedId('run');
  const scopeLogger = new LoggerImpl({
    runId,
    debugMode: debug,
    silent: !debug,
  });
  return new RunScope({
    logger: scopeLogger,
    projectContext: project,
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    runId,
    datastore: () => {
      throw new SystemError('The lean Init recovery scope cannot open the datastore.', {
        code: PROBE_LIMIT.code,
        definition: PROBE_LIMIT,
        metadata: { condition: 'recovery-datastore' },
      });
    },
  });
}

async function presentProbeError(
  error: unknown,
  input: LightweightCommandProbeInput,
  capture: ReturnType<typeof createBoundedOutputCapture>,
  ctx: ReturnType<typeof createProbeToolContext>['ctx'],
): Promise<void> {
  flushCapturedOutput(capture.stdout, capture.stderr);
  await handleParseError(error, {
    setExitCode: ctx.setExitCode,
    render: renderResult,
    jsonRequested: input.argv.includes('--json'),
  });
}

/**
 * Parse the canonical Init grammar before inspecting the fixed journal.
 *
 * `undefined` means this is not an exact root Init invocation. A boolean has
 * the same meaning as the public probe: true was handled, false must continue
 * through normal leased startup. The recovery-only handler can never fall back
 * to fresh Init if the journal disappears between header inspection and action.
 */
async function runInitRecoveryProbe(
  input: LightweightCommandProbeInput,
  capture: ReturnType<typeof createBoundedOutputCapture>,
): Promise<boolean | undefined> {
  // observability-ok -- this pre-scope recovery probe captures output for the
  // normal host dispatcher, which owns and emits the canonical command lifecycle.
  if (findRootOperand(input.argv)?.value !== 'init') return undefined;

  const handle = createProbeToolContext();
  const commandContext = createInitRecoveryCommandContext(handle);
  const actionScope = createCommandActionScopeRunner();

  /** @throws {ContinueToLeasedBootstrap} When no fixed recovery journal exists. */
  function stageRecoveryScope(_thisCommand: Command, actionCommand: Command): void {
    const selection = resolveStartupProjectSelection(input.argv, input.cwd);
    const opts = actionCommand.opts();
    Object.assign(opts, {
      projectContext: selection.project,
      cwdExplicit: selection.cwdExplicit,
    });
    const header = inspectRuntimePromotionRecoveryHeader(selection.project.projectRoot);
    if (header.status === 'absent') throw new ContinueToLeasedBootstrap();
    actionScope.stage(createInitRecoveryScope(selection.project, opts.debug === true));
  }

  input.program.hook('preAction', stageRecoveryScope); // observability-ok -- pre-scope staging; host dispatch owns lifecycle.
  mountCommandSpec(
    input.program,
    buildInitRecoverySpec(commandContext),
    commandContext,
    {},
    actionScope,
  );

  try {
    await input.program.parseAsync(input.argv, { from: 'user' });
    return true;
  } catch (error) {
    if (error instanceof ContinueToLeasedBootstrap) return false;
    await actionScope.runWithOwnedScope(() => presentProbeError(error, input, capture, handle.ctx));
    return true;
  } finally {
    actionScope.disposeStaged();
  }
}

/**
 * Return `true` when the trusted probe completely handled this invocation.
 * `false` means the caller must perform the normal leased discovery/dispatch.
 */
export async function runLightweightCommandProbe(
  input: LightweightCommandProbeInput,
): Promise<boolean> {
  const capture = createBoundedOutputCapture();
  input.program.configureOutput({
    writeOut: capture.writeOut,
    writeErr: capture.writeErr,
  });

  const initRecoveryHandled = await runInitRecoveryProbe(input, capture);
  if (initRecoveryHandled !== undefined) return initRecoveryHandled;

  const languages = new LanguageRegistry();
  const tools = new ToolRegistry();
  const { provenance, manifests } = await bootstrapCli({
    langRegistry: languages,
    toolRegistry: tools,
    projectDir: input.projectDir,
    cwd: input.cwd,
    cliEntryUrl: input.cliEntryUrl,
    argv: input.argv,
    runtimeMode: input.runtimeMode,
    discoveryMode: 'bundled-surface-only',
  });
  const { ctx, runActionHooks, getExitCode } = createProbeToolContext();
  const registrationInput = buildCommandRegistrationInput(tools, {
    provenance,
    cwd: input.cwd,
  });
  const commandContext = {
    setExitCode: ctx.setExitCode,
    getExitCode,
    render: renderResult,
    reportFailure: ctx.reportFailure,
    emitJson: ctx.emitJson,
    emitRaw: ctx.emitRaw,
    emitError: ctx.emitError,
    datastore: () => getOrOpenDatastore(logger),
    manifests,
    provenance,
    toolContext: ctx,
    toolRunActionHooks: runActionHooks,
    ...registrationInput,
  };

  input.program.hook('preAction', () => {
    throw new ContinueToLeasedBootstrap();
  });
  mountAllToolCommands(tools, input.program, ctx, provenance, runActionHooks);
  registerCliCommands(input.program, commandContext);

  if (unknownRootRequiresDiscovery(input.program, input.argv)) return false;

  try {
    await input.program.parseAsync(input.argv, { from: 'user' });
    return true;
  } catch (error) {
    if (error instanceof ContinueToLeasedBootstrap) return false;
    // Fall through only when Commander actually reached an unknown root
    // command, which may be an installed/authored Tool. Root help and root
    // option errors are already terminal even if later operands look unknown;
    // classifying those operands first would incorrectly trigger discovery.
    if (
      error instanceof CommanderError &&
      error.code === 'commander.unknownCommand' &&
      unknownRootRequiresDiscovery(input.program, input.argv)
    ) {
      return false;
    }
    await presentProbeError(error, input, capture, ctx);
    return true;
  }
}
