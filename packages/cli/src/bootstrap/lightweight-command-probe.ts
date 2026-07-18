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

import { LanguageRegistry, SystemError, ToolRegistry, logger } from '@opensip-cli/core';
import { CommanderError, type Command } from 'commander';

import { buildToolCliContext, createLiveViewRegistry, getOrOpenDatastore } from '../cli-context.js';
import { registerCliCommands } from '../commands/index.js';
import { handleParseError } from '../error-handler.js';

import { buildCommandRegistrationInput } from './build-command-registration-input.js';
import { mountAllToolCommands } from './register-tools-mount.js';
import { renderResult } from './render.js';
import { executeReportOpen } from './report.js';

import { bootstrapCli } from './index.js';

import type { ToolRuntimeExecutionMode } from './worker-datastore.js';

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
        code: 'SYSTEM.COMMAND_PROBE.OUTPUT_LIMIT',
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
  const { ctx, runActionHooks, getExitCode } = buildToolCliContext({
    render: renderResult,
    liveViews: createLiveViewRegistry(logger),
    maybeOpenReport: executeReportOpen,
    logger,
  });
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
    flushCapturedOutput(capture.stdout, capture.stderr);
    await handleParseError(error, {
      setExitCode: ctx.setExitCode,
      render: renderResult,
      jsonRequested: input.argv.includes('--json'),
    });
    return true;
  }
}
