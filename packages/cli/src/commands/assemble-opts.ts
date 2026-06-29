import { ConfigurationError, type OptionSpec } from '@opensip-cli/core';

const NO_PREVIOUS_VALUE: unknown = undefined;

export interface AssembleOptsInput {
  readonly options: readonly OptionSpec[] | undefined;
  readonly suppliedValues?: Readonly<Record<string, unknown>>;
}

export interface AssembledOpts {
  readonly opts: Record<string, unknown>;
  readonly knownKeys: ReadonlySet<string>;
}

export function optionKey(spec: OptionSpec): string {
  const long = spec.flag
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.startsWith('--'));
  const token = long ?? spec.flag.trim().split(/\s+/)[0] ?? '';
  const withoutPrefix = token.replace(/^--no-/, '').replace(/^--/, '');
  return withoutPrefix.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function assembleOptsFromSpec(input: AssembleOptsInput): AssembledOpts {
  const supplied = input.suppliedValues ?? {};
  const opts: Record<string, unknown> = {};
  const knownKeys = new Set<string>();

  for (const spec of input.options ?? []) {
    const key = optionKey(spec);
    knownKeys.add(key);
    const value = parseOptionValue(spec, initialOptionValue(spec, supplied, key));
    validateChoices(key, spec, value);
    validateRequired(key, spec, value);
    assignIfPresent(opts, key, value);
  }

  return { opts, knownKeys };
}

export function optionDefaultValue(spec: OptionSpec): unknown {
  if (spec.arrayDefault !== undefined) return [...spec.arrayDefault];
  if (spec.default !== undefined) return spec.default;
  if (spec.negatable === true) return true;
  return undefined;
}

function initialOptionValue(
  spec: OptionSpec,
  supplied: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(supplied, key)
    ? supplied[key]
    : optionDefaultValue(spec);
}

function parseOptionValue(spec: OptionSpec, value: unknown): unknown {
  if (value === undefined || spec.parse === undefined) return value;
  if (!Array.isArray(value)) return spec.parse(stringifyOptionValue(value), NO_PREVIOUS_VALUE);

  let previous: unknown = spec.arrayDefault === undefined ? undefined : [...spec.arrayDefault];
  for (const item of value) {
    previous = spec.parse(stringifyOptionValue(item), previous);
  }
  return previous;
}

function validateChoices(key: string, spec: OptionSpec, value: unknown): void {
  if (value === undefined || spec.choices === undefined || spec.choices.length === 0) return;

  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    const text = stringifyOptionValue(candidate);
    if (!spec.choices.includes(text)) {
      throw new ConfigurationError(
        `Invalid value for option '${key}': ${text}. Expected one of: ${spec.choices.join(', ')}`,
        { code: 'CONFIG.SUITE.OPTION_CHOICE' },
      );
    }
  }
}

function validateRequired(key: string, spec: OptionSpec, value: unknown): void {
  if (spec.required !== true || (value !== undefined && value !== '')) return;
  throw new ConfigurationError(`Missing required option '${key}'.`, {
    code: 'CONFIG.SUITE.OPTION_REQUIRED',
  });
}

function assignIfPresent(opts: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) opts[key] = value;
}

function stringifyOptionValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) return 'null';
  throw new ConfigurationError(`Invalid non-scalar value for option parsing.`, {
    code: 'CONFIG.SUITE.OPTION_VALUE_TYPE',
  });
}
