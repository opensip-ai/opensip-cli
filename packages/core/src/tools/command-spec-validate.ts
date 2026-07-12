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
  MAX_STATIC_HANDLER_DECLARATION,
  MAX_STATIC_HANDLER_PACKAGE,
  MAX_STATIC_HANDLER_PATH,
  RAW_STREAM_REASONS,
  type CommandContext,
  type CommandOutputMode,
  type CommandScopeRequirement,
  type CommandSpec,
  type CommonFlagKey,
  type RawStreamReason,
  type StaticHandlerDescriptor,
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

  // Own-property data only — never invoke getters or function stringifiers.
  let own: Record<string, unknown>;
  try {
    own = ownDataProperties(value);
  } catch (error) {
    return error instanceof Error
      ? error
      : new TypeError('defineCommand: command spec own-property inspection failed.');
  }

  const header = validateCommandHeader(own);
  if (header instanceof Error) return header;
  const { name, output, commonFlags } = header;

  const rawStreamError = rawStreamDeclarationError({
    name,
    output,
    rawStreamReason: own.rawStreamReason,
  });
  if (rawStreamError !== undefined) return rawStreamError;

  const flagsError = commonFlagsError(name, commonFlags);
  if (flagsError !== undefined) return flagsError;

  if (Object.hasOwn(own, 'staticHandler')) {
    const descriptorError = staticHandlerValidationError(own.staticHandler, name);
    if (descriptorError !== undefined) return descriptorError;
  }

  return undefined;
}

/** Validated scalar header fields required before flag/handler admission. */
interface ValidatedCommandHeader {
  readonly name: string;
  readonly output: CommandOutputMode;
  readonly commonFlags: readonly unknown[];
}

/**
 * Validate the scalar command-spec header (name, description, visibility, scope,
 * output, handler) in declaration order. Returns the first error, or the parsed
 * `name`/`output`/`commonFlags` needed by the remaining checks.
 */
function validateCommandHeader(own: Record<string, unknown>): ValidatedCommandHeader | Error {
  const name = own.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return new Error('defineCommand: `name` must be a non-empty string.');
  }
  const description = own.description;
  if (typeof description !== 'string' || description.trim() === '') {
    return new Error(`defineCommand: command '${name}' must have a non-empty description.`);
  }
  const visibility = own.visibility;
  if (visibility !== undefined && visibility !== 'public' && visibility !== 'internal') {
    return new Error(
      `defineCommand: command '${name}' declares unknown visibility '${describeUnknownValue(visibility)}'. ` +
        'Valid values: public, internal.',
    );
  }
  const commonFlags = own.commonFlags;
  if (!Array.isArray(commonFlags)) {
    return new TypeError(`defineCommand: command '${name}' must declare commonFlags as an array.`);
  }
  const scope = own.scope;
  if (!COMMAND_SCOPE_REQUIREMENTS.includes(scope as CommandScopeRequirement)) {
    return new Error(
      `defineCommand: command '${name}' declares unknown scope '${describeUnknownValue(scope)}'. ` +
        `Valid scopes: ${COMMAND_SCOPE_REQUIREMENTS.join(', ')}.`,
    );
  }
  const output = own.output;
  if (!COMMAND_OUTPUT_MODES.includes(output as CommandOutputMode)) {
    return new Error(
      `defineCommand: command '${name}' declares unknown output '${describeUnknownValue(output)}'. ` +
        `Valid outputs: ${COMMAND_OUTPUT_MODES.join(', ')}.`,
    );
  }
  if (typeof own.handler !== 'function') {
    return new TypeError(`defineCommand: command '${name}' must have a function handler.`);
  }
  return { name, output: output as CommandOutputMode, commonFlags };
}

/** Validate each declared common flag key: known key, no duplicates. */
function commonFlagsError(name: string, commonFlags: readonly unknown[]): Error | undefined {
  const seen = new Set<CommonFlagKey>();
  for (const key of commonFlags) {
    if (typeof key !== 'string' || !COMMON_FLAG_KEYS.includes(key as CommonFlagKey)) {
      return new Error(
        `defineCommand: command '${name}' declares unknown common flag '${describeUnknownValue(key)}'. ` +
          `Valid keys: ${COMMON_FLAG_KEYS.join(', ')}.`,
      );
    }
    const commonFlag = key as CommonFlagKey;
    if (seen.has(commonFlag)) {
      return new Error(
        `defineCommand: command '${name}' declares duplicate common flag '${commonFlag}'.`,
      );
    }
    seen.add(commonFlag);
  }
  return undefined;
}

/**
 * Read own enumerable data properties without invoking accessors.
 * Throws TypeError on throwing/revoked Proxies (fail-closed admission).
 *
 * @throws {TypeError} When a property is an accessor (get/set), not a data property.
 */
function ownDataProperties(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc === undefined) continue;
    if (desc.get !== undefined || desc.set !== undefined) {
      throw new TypeError(
        `defineCommand: command spec property '${key}' must be a data property (accessors rejected).`,
      );
    }
    out[key] = desc.value;
  }
  return out;
}

/**
 * Validate optional {@link StaticHandlerDescriptor}. Returns an Error when invalid.
 * Accepts only the three known keys; rejects unknown metadata fields.
 */
export function staticHandlerValidationError(
  value: unknown,
  commandName: string,
): Error | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    return new TypeError(
      `defineCommand: command '${commandName}' staticHandler must be a plain object.`,
    );
  }
  let own: Record<string, unknown>;
  try {
    own = ownDataProperties(value);
  } catch (error) {
    return error instanceof Error
      ? error
      : new TypeError(
          `defineCommand: command '${commandName}' staticHandler own-property inspection failed.`,
        );
  }
  const keys = Object.keys(own);
  for (const key of keys) {
    if (key !== 'package' && key !== 'path' && key !== 'declaration') {
      return new Error(
        `defineCommand: command '${commandName}' staticHandler has unknown field '${key}'.`,
      );
    }
  }
  const pkg = own.package;
  const path = own.path;
  const declaration = own.declaration;
  if (typeof pkg !== 'string' || !isSafeStaticHandlerText(pkg, MAX_STATIC_HANDLER_PACKAGE)) {
    return new Error(
      `defineCommand: command '${commandName}' staticHandler.package must be a non-empty ` +
        `NUL/control-free string of at most ${String(MAX_STATIC_HANDLER_PACKAGE)} characters.`,
    );
  }
  if (typeof path !== 'string' || !isSafeProjectRelativePosixPath(path)) {
    return new Error(
      `defineCommand: command '${commandName}' staticHandler.path must be a project-root-relative ` +
        `POSIX path (no absolute/drive/UNC/backslash/empty/./../ segments) of at most ` +
        `${String(MAX_STATIC_HANDLER_PATH)} characters.`,
    );
  }
  if (
    typeof declaration !== 'string' ||
    !isSafeStaticHandlerText(declaration, MAX_STATIC_HANDLER_DECLARATION)
  ) {
    return new Error(
      `defineCommand: command '${commandName}' staticHandler.declaration must be a non-empty ` +
        `NUL/control-free string of at most ${String(MAX_STATIC_HANDLER_DECLARATION)} characters.`,
    );
  }
  return undefined;
}

function isSafeStaticHandlerText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
}

/**
 * Require an already-normalized project-relative POSIX path.
 * Rejects absolute/drive/UNC, backslashes, empty/`.`/`..` segments, and overflow.
 */
export function isSafeProjectRelativePosixPath(value: string): boolean {
  if (!isSafeStaticHandlerText(value, MAX_STATIC_HANDLER_PATH)) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) return false;
  const segments = value.split('/');
  if (segments.length === 0) return false;
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

/** Copy and freeze a validated static-handler descriptor (own data only). */
export function freezeStaticHandlerDescriptor(
  value: StaticHandlerDescriptor,
): Readonly<StaticHandlerDescriptor> {
  return Object.freeze({
    package: value.package,
    path: value.path,
    declaration: value.declaration,
  });
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
 * Validate, **copy**, and **freeze** a {@link CommandSpec} (including optional
 * {@link StaticHandlerDescriptor}). Deliberately not an identity helper: the
 * returned object is a shallow data copy with frozen arrays/descriptor so
 * post-define mutation cannot alter the admitted surface.
 *
 * Validation is structural and pure — catches authoring mistakes at construction:
 * - `name` / `description` non-empty
 * - every `commonFlags` key is a valid {@link CommonFlagKey}; no duplicates
 * - valid `scope` and `output`; `handler` is a function
 * - optional `staticHandler` exact three-field shape and path bounds
 * - own data properties only (accessors / throwing Proxies fail closed)
 *
 * Deeper, Commander-coupled validation (choices subset enum, flag-string syntax)
 * happens at mount in cli — core cannot import Commander.
 *
 * @throws {Error | TypeError} When the spec violates the command contract.
 */
export function defineCommand<TOpts = unknown, TCtx = CommandContext>(
  spec: CommandSpec<TOpts, TCtx>,
): CommandSpec<TOpts, TCtx> {
  // assertCommandSpec narrows to the default CommandSpec shape; keep the
  // caller's TOpts/TCtx generics by validating on a widened view and freezing
  // the original typed reference. The `as CommandSpec` makes the assertion
  // target the cast EXPRESSION, not the `spec` variable, so `spec` keeps its
  // TOpts/TCtx generics for freezeCommandSpec (removing it regresses the return
  // type to CommandSpec<unknown, ...>). Load-bearing despite the lint heuristic.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- narrowing guard, see above
  assertCommandSpec(spec as CommandSpec);
  return freezeCommandSpec(spec);
}

/**
 * Shallow-copy and freeze a validated command spec so admitted metadata is
 * immutable. Handler function identity is preserved (not wrapped).
 */
function freezeCommandSpec<TOpts, TCtx>(spec: CommandSpec<TOpts, TCtx>): CommandSpec<TOpts, TCtx> {
  const frozen = {
    name: spec.name,
    description: spec.description,
    commonFlags: Object.freeze([...spec.commonFlags]),
    scope: spec.scope,
    output: spec.output,
    handler: spec.handler,
    ...(spec.aliases === undefined ? {} : { aliases: Object.freeze([...spec.aliases]) }),
    ...(spec.visibility === undefined ? {} : { visibility: spec.visibility }),
    ...(spec.parent === undefined ? {} : { parent: spec.parent }),
    ...(spec.options === undefined
      ? {}
      : {
          options: Object.freeze(
            spec.options.map((option) => Object.freeze({ ...option })),
          ) as CommandSpec<TOpts, TCtx>['options'],
        }),
    ...(spec.args === undefined
      ? {}
      : {
          args: Object.freeze(spec.args.map((arg) => Object.freeze({ ...arg }))) as CommandSpec<
            TOpts,
            TCtx
          >['args'],
        }),
    ...(spec.rawStreamReason === undefined ? {} : { rawStreamReason: spec.rawStreamReason }),
    ...(spec.producesVerdict === undefined ? {} : { producesVerdict: spec.producesVerdict }),
    ...(spec.staticHandler === undefined
      ? {}
      : { staticHandler: freezeStaticHandlerDescriptor(spec.staticHandler) }),
  };
  return Object.freeze(frozen as unknown as CommandSpec<TOpts, TCtx>);
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
