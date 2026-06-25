/**
 * @fileoverview Runtime validation for the command-plane contract (launch, §5.4).
 *
 * The declarative {@link CommandSpec} TYPES live next door in `./command-spec.ts`
 * (the kernel-level contract). This module is their runtime admission guard: the
 * shared structural check (`assertCommandSpec` / `validateCommandSpec`) and the
 * `defineCommand` identity helper that both first-party command authoring and
 * untrusted third-party tool admission run a spec through before mount.
 *
 * Kept separate from the type declarations so each file stays a single concern
 * (and under the file-length soft limit). Stays Commander-free, exactly like the
 * types: flag syntax and option mounting remain CLI-layer concerns — core cannot
 * import Commander. Deeper, Commander-coupled validation (choices subset enum,
 * flag-string syntax) happens at mount in cli.
 */
import { isPlainRecord } from '../lib/json-guards.js';

import {
  COMMON_FLAG_KEYS,
  RAW_STREAM_REASONS,
  type CommandContext,
  type CommandOutputMode,
  type CommandScopeRequirement,
  type CommandSpec,
  type CommonFlagKey,
  type RawStreamReason,
} from './command-spec.js';

const COMMAND_OUTPUT_MODES: readonly CommandOutputMode[] = [
  'signal-envelope',
  'command-result',
  'raw-stream',
  'live-view',
];

const COMMAND_SCOPE_REQUIREMENTS: readonly CommandScopeRequirement[] = ['project', 'none'];

function describeUnknownValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
    return String(value);
  }
  if (value === null) return 'null';
  return typeof value;
}

function commandSpecValidationError(value: unknown): Error | undefined {
  if (!isPlainRecord(value)) {
    return new TypeError('defineCommand: command spec must be an object.');
  }

  const spec = value as {
    readonly name?: unknown;
    readonly description?: unknown;
    readonly visibility?: unknown;
    readonly commonFlags?: unknown;
    readonly scope?: unknown;
    readonly output?: unknown;
    readonly rawStreamReason?: unknown;
    readonly handler?: unknown;
  };

  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    return new Error('defineCommand: `name` must be a non-empty string.');
  }
  if (typeof spec.description !== 'string' || spec.description.trim() === '') {
    return new Error(`defineCommand: command '${spec.name}' must have a non-empty description.`);
  }
  if (
    spec.visibility !== undefined &&
    spec.visibility !== 'public' &&
    spec.visibility !== 'internal'
  ) {
    return new Error(
      `defineCommand: command '${spec.name}' declares unknown visibility '${describeUnknownValue(spec.visibility)}'. ` +
        'Valid values: public, internal.',
    );
  }
  if (!Array.isArray(spec.commonFlags)) {
    return new TypeError(
      `defineCommand: command '${spec.name}' must declare commonFlags as an array.`,
    );
  }
  if (!COMMAND_SCOPE_REQUIREMENTS.includes(spec.scope as CommandScopeRequirement)) {
    return new Error(
      `defineCommand: command '${spec.name}' declares unknown scope '${describeUnknownValue(spec.scope)}'. ` +
        `Valid scopes: ${COMMAND_SCOPE_REQUIREMENTS.join(', ')}.`,
    );
  }
  if (!COMMAND_OUTPUT_MODES.includes(spec.output as CommandOutputMode)) {
    return new Error(
      `defineCommand: command '${spec.name}' declares unknown output '${describeUnknownValue(spec.output)}'. ` +
        `Valid outputs: ${COMMAND_OUTPUT_MODES.join(', ')}.`,
    );
  }
  if (typeof spec.handler !== 'function') {
    return new TypeError(`defineCommand: command '${spec.name}' must have a function handler.`);
  }

  const rawStreamError = rawStreamDeclarationError({
    name: spec.name,
    output: spec.output as CommandOutputMode,
    rawStreamReason: spec.rawStreamReason,
  });
  if (rawStreamError !== undefined) return rawStreamError;

  const seen = new Set<CommonFlagKey>();
  for (const key of spec.commonFlags as readonly unknown[]) {
    if (typeof key !== 'string' || !COMMON_FLAG_KEYS.includes(key as CommonFlagKey)) {
      return new Error(
        `defineCommand: command '${spec.name}' declares unknown common flag '${describeUnknownValue(key)}'. ` +
          `Valid keys: ${COMMON_FLAG_KEYS.join(', ')}.`,
      );
    }
    const commonFlag = key as CommonFlagKey;
    if (seen.has(commonFlag)) {
      return new Error(
        `defineCommand: command '${spec.name}' declares duplicate common flag '${commonFlag}'.`,
      );
    }
    seen.add(commonFlag);
  }

  return undefined;
}

/**
 * Assert that an unknown value satisfies the runtime {@link CommandSpec} shape.
 *
 * This is the shared structural check for first-party `defineCommand` and
 * third-party tool admission. It deliberately stays Commander-free: flag syntax
 * and option mounting remain CLI-layer concerns, while the kernel-level command
 * contract is rejected before mount.
 *
 * @throws {Error | TypeError} When the value violates the command contract.
 */
export function assertCommandSpec(value: unknown): asserts value is CommandSpec {
  const error = commandSpecValidationError(value);
  if (error !== undefined) throw error;
}

/** Boolean form of {@link assertCommandSpec} for untrusted plugin admission. */
export function validateCommandSpec(value: unknown): value is CommandSpec {
  return commandSpecValidationError(value) === undefined;
}

/**
 * Identity helper that validates and returns a {@link CommandSpec}. Mirrors
 * `defineCheck` / `defineTool`: returns the value so the caller registers it
 * explicitly (no module-import side effects). Validation is structural and pure
 * — it catches authoring mistakes at construction time:
 *
 * - `name` non-empty
 * - `description` non-empty
 * - every `commonFlags` key is a valid {@link CommonFlagKey}
 * - no duplicate `commonFlags` keys
 * - valid `scope` and `output`
 * - `handler` is a function
 *
 * Deeper, Commander-coupled validation (e.g. choices subset enum, flag-string
 * syntax) happens at mount in cli — core cannot import Commander.
 *
 * @throws {Error | TypeError} When the spec violates the command contract.
 */
export function defineCommand<TOpts = unknown, TCtx = CommandContext>(
  spec: CommandSpec<TOpts, TCtx>,
): CommandSpec<TOpts, TCtx> {
  assertCommandSpec(spec);
  return spec;
}

/** Return an error when a `raw-stream` declaration is missing or inconsistent. */
function rawStreamDeclarationError(spec: {
  readonly name: string;
  readonly output: CommandOutputMode;
  readonly rawStreamReason?: unknown;
}): Error | undefined {
  if (spec.output === 'raw-stream') {
    if (spec.rawStreamReason === undefined) {
      return new Error(
        `defineCommand: command '${spec.name}' declares output 'raw-stream' without ` +
          'rawStreamReason. Raw-stream commands must document why the host render seam ' +
          'cannot own their output.',
      );
    }
    if (!RAW_STREAM_REASONS.includes(spec.rawStreamReason as RawStreamReason)) {
      return new Error(
        `defineCommand: command '${spec.name}' declares unknown rawStreamReason ` +
          `'${describeUnknownValue(spec.rawStreamReason)}'. Valid reasons: ${RAW_STREAM_REASONS.join(', ')}.`,
      );
    }
    return undefined;
  }
  if (spec.rawStreamReason !== undefined) {
    return new Error(
      `defineCommand: command '${spec.name}' declares rawStreamReason but output is ` +
        `'${spec.output}'. rawStreamReason is only valid for raw-stream commands.`,
    );
  }
  return undefined;
}
