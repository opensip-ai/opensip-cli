/**
 * @fileoverview Command-plane types (launch, north-star §5.4).
 *
 * The declarative command surface a tool exports so the **host** can mount it
 * — replacing each tool's raw-Commander access (`program.command(...).option(...).
 * action(...)`). A tool returns typed {@link CommandSpec}s; the host's
 * `mountCommandSpec` (cli, Phase 1) translates them into Commander commands,
 * applies the common flags, declares the options/args, and owns the
 * parse → handler → dispatch → error → exit pipeline.
 *
 * Why this lives in **core**: these are kernel-level contract types, declared
 * beside the {@link Tool} contract. core stays Commander-free — there is no
 * `commander` import here, only plain data shapes. The Commander-touching
 * mounting runtime lives in cli; the Commander-touching `applyCommonFlags`
 * runtime lives in contracts. Only the pure KEY TYPE ({@link CommonFlagKey})
 * lives here.
 *
 * `OptionSpec` is grounded in the *real* first-party flag corpus (graph 26 +
 * fit 10 + sim 1 + host commands), enumerated in the Phase 0 flag-corpus table.
 * Every flag shape maps to a field below — there is no raw-Commander escape
 * hatch by design (the the "one command surface" invariant). Any future flag
 * that cannot be expressed is an OptionSpec EXTENSION, never an escape.
 */

/**
 * The canonical common-flag keys shared across tool run commands (ADR-0021).
 *
 * The KEY TYPE lives here in core so {@link CommandSpec.commonFlags} can be
 * statically typed at the kernel layer without core importing contracts
 * (a layering inversion forbidden by dependency-cruiser). The Commander-touching
 * runtime that turns these keys into `.option(...)` calls — `applyCommonFlags`,
 * the `commonFlags` registry, and `CommonFlagSpec` — stays in
 * `@opensip-cli/contracts/cli-flags`, which re-exports this type so existing
 * `import { CommonFlagKey } from '@opensip-cli/contracts'` sites keep working.
 *
 * Keep this union in lockstep with the `commonFlags` registry keys in
 * contracts (the `cross-tool-flag-parity` check guards the run-command set).
 */
export type CommonFlagKey =
  | 'json'
  | 'cwd'
  | 'quiet'
  | 'verbose'
  | 'debug'
  | 'reportTo'
  | 'apiKey'
  | 'open';

/** The full set of {@link CommonFlagKey} values — the validation source for `defineCommand`. */
export const COMMON_FLAG_KEYS: readonly CommonFlagKey[] = [
  'json',
  'cwd',
  'quiet',
  'verbose',
  'debug',
  'reportTo',
  'apiKey',
  'open',
] as const;

/**
 * A single tool-specific option declaration.
 *
 * Expresses every shape in the first-party corpus:
 * - boolean (`--gate-save`, default `false`): `{ flag, default: false }`
 * - negatable (`--no-cache`): `{ flag: '--no-cache', negatable: true }`
 * - value (`--recipe <name>`, `--profile <path>`): `{ flag, value: '<name>' }`
 * - value + default (`--resolution <mode>` default `exact`): add `default`
 * - choices (`--resolution` ∈ `exact|fast`): add `choices`
 * - custom coercion (`--concurrency <n>` → Number; `--exclude <slug>` repeatable;
 *   `--older-than <days>` validated): declared as a pure `parse`
 * - short alias (`-y, --yes`, `-q, --quiet`): carried verbatim in `flag`
 * - required value (`--out <path>` via `.requiredOption`): `{ value, required: true }`
 */
export interface OptionSpec {
  /**
   * The Commander flag string, including any short alias — e.g. `'--no-cache'`,
   * `'--resolution'`, `'-y, --yes'`. Does NOT include the value placeholder; put
   * that in {@link value}.
   */
  readonly flag: string;
  /**
   * The value placeholder (`'<mode>'`, `'<path>'`, `'[path]'`). Presence marks
   * this as a value-taking option; absence marks it boolean. Optional-value
   * placeholders use square brackets (`'[path]'`), matching Commander.
   */
  readonly value?: string;
  /** Help text (the single source of truth for this option's description). */
  readonly description: string;
  /**
   * Literal default applied at mount. A boolean default models a boolean flag's
   * resting state (`false`); a string default models a value flag's fallback
   * (`'exact'`). Computed-per-invocation defaults (e.g. `process.cwd()`) belong
   * to {@link CommonFlagKey} common flags, not here.
   */
  readonly default?: string | boolean;
  /**
   * Repeatable/array default (e.g. `--exclude`, `--changed-file` accumulate into
   * `string[]`). Kept distinct from {@link default} so the mount layer can pass a
   * fresh array as Commander's `defaultValue` alongside a {@link parse} reducer.
   */
  readonly arrayDefault?: readonly string[];
  /** `--no-cache` style negatable boolean. The flag already carries the `--no-` prefix. */
  readonly negatable?: boolean;
  /** Variadic value option (rare for options; carried for completeness). */
  readonly variadic?: boolean;
  /** Whether the option is required (`.requiredOption`). Value options only. */
  readonly required?: boolean;
  /** Declared allowed values — the mount layer enforces membership (was handler-side, e.g. `--resolution`). */
  readonly choices?: readonly string[];
  /**
   * Declared pure coercion/validation. Covers Commander's `(value, previous) =>
   * next` reducer shape used by repeatable flags (`--exclude`, `--changed-file`)
   * and scalar parsers (`--concurrency` → Number, `--older-than` → validated int).
   * MUST be pure — no I/O, no scope reads. Runs at parse time in the mount layer.
   */
  readonly parse?: (raw: string, previous: unknown) => unknown;
}

/** A positional argument declaration (`.argument(...)`). */
export interface ArgSpec {
  /** The argument name as it appears in help (`'paths'`, `'name'`, `'shell'`). */
  readonly name: string;
  /** Help text for the argument. */
  readonly description: string;
  /** Variadic positional (`[paths...]` / `<paths...>`). */
  readonly variadic?: boolean;
  /** Optional positional (`[name]` rather than `<name>`). */
  readonly optional?: boolean;
}

/**
 * What the handler returns and how the host renders it through the single
 * dispatch seam (Phase 1). The launch `CommandOutcome` swap happens at this seam
 * without changing the handler contract.
 *
 * - `signal-envelope` — handler yields a `SignalEnvelope` (fit/graph runs); the
 *   host renders it (`--json` → emitEnvelope, else render).
 * - `command-result` — handler yields a `CommandResult` variant (list/export/host).
 * - `raw-stream` — the host renders NOTHING; the handler owns its entire output
 *   surface. Covers two cases: (a) a handler that writes directly to stdout/a
 *   file (completion script, SARIF/baseline export, shard-worker); and (b) a
 *   handler that owns a runtime-conditional render+egress flow no single static
 *   mode captures — e.g. `sim`, which branches between an interactive Ink live
 *   view and a static render/JSON path depending on the TTY, then performs its
 *   own cloud egress, report auto-open, and exit-code decision. In both cases
 *   the handler returns `void` and the host does not touch the stream.
 * - `live-view` — interactive Ink view path (graph/fit live default on a TTY)
 *   where the command is UNCONDITIONALLY a live view; the host dispatches to the
 *   tool's registered renderer via `renderLive(name, …)`.
 */
export type CommandOutputMode = 'signal-envelope' | 'command-result' | 'raw-stream' | 'live-view';

/**
 * Narrow categories for the `raw-stream` escape hatch. A raw-stream command must
 * explain why the host-owned render seam cannot handle its output.
 */
export type RawStreamReason =
  | 'completion-script'
  | 'file-export'
  | 'worker-ipc'
  | 'runtime-render-dispatch'
  | 'session-replay'
  | 'diagnostic-gate'
  | 'lookup';

export const RAW_STREAM_REASONS: readonly RawStreamReason[] = [
  'completion-script',
  'file-export',
  'worker-ipc',
  'runtime-render-dispatch',
  'session-replay',
  'diagnostic-gate',
  'lookup',
];

const COMMAND_OUTPUT_MODES: readonly CommandOutputMode[] = [
  'signal-envelope',
  'command-result',
  'raw-stream',
  'live-view',
];

/**
 * Whether the command needs a resolved project scope (RunScope project context,
 * datastore, recipe config) entered before the handler runs.
 *
 * - `project` — needs the entered RunScope (every run/list/export command).
 * - `none` — scope-agnostic (e.g. `completion`, `configure`).
 */
export type CommandScopeRequirement = 'project' | 'none';

const COMMAND_SCOPE_REQUIREMENTS: readonly CommandScopeRequirement[] = ['project', 'none'];

/**
 * The context the host passes to a handler when it invokes it. The concrete
 * shape is finalized in Phase 1 (mounting) — it carries the per-invocation scope
 * and the output emitters (`render` / `emitJson` / `renderLive` / `writeSarif` /
 * `deliverSignals` / `setExitCode`), i.e. today's `ToolCliContext` surface minus
 * raw `program` access.
 *
 * Declared here as an empty marker interface (NOT a bare `unknown` alias): core
 * stays Commander-free and does not pin the cli/contracts-owned context shape, so
 * the kernel cannot name the concrete emitters. Handlers parameterize `TCtx` with
 * the real context type (`ToolCliContext`) at the cli/tool layer; this marker is
 * the unconstrained default.
 */
export type CommandContext = Readonly<Record<string, unknown>>;

/**
 * A command handler: pure-ish business logic the host invokes after parsing.
 * Receives the parsed, typed options and the host {@link CommandContext}; returns
 * whatever the declared {@link CommandSpec.output} mode dispatches (sync or a
 * promise), or void for `raw-stream` / `live-view`, which side-effect directly.
 */
export type CommandHandler<TOpts = unknown, TCtx = CommandContext> = (
  opts: TOpts,
  ctx: TCtx,
) => unknown;

/**
 * The declarative spec a tool exports for one command. The host mounts it; the
 * tool never touches Commander.
 */
export interface CommandSpec<TOpts = unknown, TCtx = CommandContext> {
  /** The command name as typed on the CLI (`'graph'`, `'fit-list'`). */
  readonly name: string;
  /** One-line description shown in help. */
  readonly description: string;
  /** Alternate names (`'inspect'` for `'analyze'`). */
  readonly aliases?: readonly string[];
  /**
   * When set, the host mounts this spec as a SUBCOMMAND of the named parent
   * command (the tool's primary verb, e.g. `'graph'` / `'fit'`) rather than
   * flat at the root program — the handler-mount mirror of
   * {@link ToolCommandDescriptor.parent}. Enables the `<tool> <verb>` grammar
   * (`graph export`, `fit list`): `mountOneTool` mounts the tool's primary
   * first, then mounts every `parent`-matched child onto it via
   * `mountCommandSpec(primaryCmd, child, ctx)`. Omitted ⇒ flat root mount.
   */
  readonly parent?: string;
  /** The common flags this command exposes, applied via `applyCommonFlags` at mount. */
  readonly commonFlags: readonly CommonFlagKey[];
  /** Tool-specific options. */
  readonly options?: readonly OptionSpec[];
  /** Positional arguments (declaration order is mount order). */
  readonly args?: readonly ArgSpec[];
  /** Whether the host enters a project scope before the handler. */
  readonly scope: CommandScopeRequirement;
  /** How the host dispatches the handler's return value. */
  readonly output: CommandOutputMode;
  /** Required when `output` is `raw-stream`, forbidden otherwise. */
  readonly rawStreamReason?: RawStreamReason;
  /** The business-logic handler the host invokes after parse. */
  readonly handler: CommandHandler<TOpts, TCtx>;
}

/** A plain-object guard that treats arrays and null as non-objects. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeUnknownValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === undefined) {
    return String(value);
  }
  if (value === null) return 'null';
  return typeof value;
}

function commandSpecValidationError(value: unknown): Error | undefined {
  if (!isPlainObject(value)) {
    return new TypeError('defineCommand: command spec must be an object.');
  }

  const spec = value as {
    readonly name?: unknown;
    readonly description?: unknown;
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
