/**
 * Bounded JSON-safe value normalizer (ADR-0175).
 *
 * Single owner for turning open `unknown` bags into trees that always survive
 * `JSON.stringify` — used at {@link DiagnosticsBus.emit} so diagnostic `data`
 * cannot poison `--json` outcome serialization. Normalize-and-keep: unserializable
 * leaves become deterministic sentinels rather than dropping the event.
 *
 * Caps are intentionally tight: diagnostics are operator pivots, not payload
 * dumps. SARIF property bounding lives separately in `@opensip-cli/output`.
 */

/** JSON-serializable value tree produced by {@link toJsonValue}. */
export type JsonValue = boolean | null | number | string | readonly JsonValue[] | JsonRecord;

/**
 * Plain JSON object of {@link JsonValue} leaves.
 * Interface (not type-alias Record) so the recursive JsonValue union type-checks.
 */
export interface JsonRecord {
  readonly [key: string]: JsonValue;
}

/** Default maximum nesting depth (root = 0). */
export const JSON_VALUE_MAX_DEPTH = 8;

/** Default maximum string length (characters). */
export const JSON_VALUE_MAX_STRING_LENGTH = 2000;

/** Default maximum array items retained. */
export const JSON_VALUE_MAX_ARRAY_ITEMS = 50;

/** Default maximum object keys retained (stable insertion order). */
export const JSON_VALUE_MAX_OBJECT_KEYS = 64;

/**
 * Optional caps for {@link toJsonValue} / {@link toJsonRecord}. Omitted fields
 * use the `JSON_VALUE_MAX_*` defaults.
 */
export interface ToJsonValueOptions {
  /** Maximum nesting depth (root = 0). */
  readonly maxDepth?: number;
  /** Maximum string length in characters. */
  readonly maxStringLength?: number;
  /** Maximum array items retained. */
  readonly maxArrayItems?: number;
  /** Maximum object keys retained (insertion order). */
  readonly maxObjectKeys?: number;
}

const SENTINEL_CIRCULAR = '[Circular]';
const SENTINEL_DEPTH = '[MaxDepth]';
const SENTINEL_FUNCTION = '[Function]';
const SENTINEL_SYMBOL = '[Symbol]';
const SENTINEL_UNDEFINED = '[Undefined]';
const SENTINEL_UNSERIALIZABLE = '[Unserializable]';
const SENTINEL_NAN = '[NaN]';
const SENTINEL_POS_INFINITY = '[Infinity]';
const SENTINEL_NEG_INFINITY = '[-Infinity]';
const SENTINEL_TRUNCATED = '…';

/**
 * Convert an open value into a bounded JSON-safe tree. Always returns a value
 * that `JSON.stringify` accepts without a replacer (never throws for ordinary
 * input; hostile `toJSON` is caught and replaced).
 */
export function toJsonValue(value: unknown, options: ToJsonValueOptions = {}): JsonValue {
  const limits = resolveLimits(options);
  return normalize(value, 0, new WeakSet<object>(), limits);
}

/**
 * Normalize a plain record of open values (diagnostic `data` bags). Keys that
 * normalize to `undefined` are omitted; the result is always a plain object.
 */
export function toJsonRecord(
  value: Readonly<Record<string, unknown>>,
  options: ToJsonValueOptions = {},
): JsonRecord {
  const limits = resolveLimits(options);
  return normalizeObject(value, 0, new WeakSet<object>(), limits);
}

interface Limits {
  readonly maxDepth: number;
  readonly maxStringLength: number;
  readonly maxArrayItems: number;
  readonly maxObjectKeys: number;
}

function resolveLimits(options: ToJsonValueOptions): Limits {
  return {
    maxDepth: options.maxDepth ?? JSON_VALUE_MAX_DEPTH,
    maxStringLength: options.maxStringLength ?? JSON_VALUE_MAX_STRING_LENGTH,
    maxArrayItems: options.maxArrayItems ?? JSON_VALUE_MAX_ARRAY_ITEMS,
    maxObjectKeys: options.maxObjectKeys ?? JSON_VALUE_MAX_OBJECT_KEYS,
  };
}

function normalize(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  limits: Limits,
): JsonValue {
  const primitive = normalizePrimitive(value, limits.maxStringLength);
  return primitive === undefined ? normalizeObjectLike(value, depth, seen, limits) : primitive;
}

/**
 * Returns a JSON leaf when the value is primitive-shaped, or `undefined` to
 * signal that the object path must handle it.
 *
 * Sonar `function-return-type` is suppressed: the contract is intentionally a
 * JsonValue union (plus undefined as the "not a leaf" signal).
 */
// eslint-disable-next-line sonarjs/function-return-type -- JsonValue union + undefined probe
function normalizePrimitive(value: unknown, maxStringLength: number): JsonValue | undefined {
  if (value === null) return null;
  if (value === undefined) return SENTINEL_UNDEFINED;
  switch (typeof value) {
    case 'string': {
      return truncateString(value, maxStringLength);
    }
    case 'boolean': {
      return value;
    }
    case 'number': {
      return normalizeNumber(value);
    }
    case 'bigint': {
      return `${value.toString()}n`;
    }
    case 'function': {
      return SENTINEL_FUNCTION;
    }
    case 'symbol': {
      return SENTINEL_SYMBOL;
    }
    default: {
      return undefined;
    }
  }
}

// eslint-disable-next-line sonarjs/function-return-type -- JsonValue union by design
function normalizeObjectLike(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  limits: Limits,
): JsonValue {
  if (typeof value !== 'object' || value === null) {
    return SENTINEL_UNSERIALIZABLE;
  }

  // Prefer structural Error projection over empty `{}` from JSON.stringify.
  if (value instanceof Error) {
    return projectErrorAsJsonRecord(value, depth, seen, limits);
  }

  // Date → ISO string (matches JSON.stringify's toJSON behaviour without
  // re-entering a potentially hostile prototype).
  if (value instanceof Date) {
    return normalizeDate(value);
  }

  if (seen.has(value)) return SENTINEL_CIRCULAR;
  if (depth >= limits.maxDepth) return SENTINEL_DEPTH;

  const viaToJson = tryNormalizeViaToJson(value, depth, seen, limits);
  if (viaToJson !== undefined) return viaToJson;

  if (Array.isArray(value)) {
    return normalizeArray(value, depth, seen, limits);
  }

  return normalizeObject(asOpenRecord(value), depth, seen, limits);
}

function asOpenRecord(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function normalizeDate(value: Date): JsonValue {
  const time = value.getTime();
  return Number.isFinite(time) ? value.toISOString() : SENTINEL_UNSERIALIZABLE;
}

/**
 * Honour cooperative `toJSON` when present. Returns the normalized projection,
 * or `undefined` when the value has no `toJSON` method.
 */
// eslint-disable-next-line sonarjs/function-return-type -- JsonValue union + undefined probe
function tryNormalizeViaToJson(
  value: object,
  depth: number,
  seen: WeakSet<object>,
  limits: Limits,
): JsonValue | undefined {
  if (!('toJSON' in value)) return undefined;
  const candidate = (value as { toJSON?: unknown }).toJSON;
  if (typeof candidate !== 'function') return undefined;
  try {
    // Call as a method; catch hostile throws.
    const projected: unknown = (candidate as (this: object) => unknown).call(value);
    // Mark the source object as seen so a toJSON that returns `this` (or a
    // cycle through `this`) cannot explode.
    seen.add(value);
    const normalized = normalize(projected, depth, seen, limits);
    seen.delete(value);
    return normalized;
  } catch {
    return SENTINEL_UNSERIALIZABLE;
  }
}

// eslint-disable-next-line sonarjs/function-return-type -- JsonValue union by design
function normalizeNumber(value: number): JsonValue {
  if (Number.isFinite(value)) return value;
  if (Number.isNaN(value)) return SENTINEL_NAN;
  return value > 0 ? SENTINEL_POS_INFINITY : SENTINEL_NEG_INFINITY;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= SENTINEL_TRUNCATED.length) return value.slice(0, maxLength);
  return value.slice(0, maxLength - SENTINEL_TRUNCATED.length) + SENTINEL_TRUNCATED;
}

function projectErrorAsJsonRecord(
  error: Error,
  depth: number,
  seen: WeakSet<object>,
  limits: Limits,
): JsonRecord {
  // Treat Error as a plain bag so nested `cause` is bounded without relying on
  // enumerable props (Error.message is non-enumerable on many engines).
  const bag: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.cause !== undefined) bag.cause = error.cause;
  return normalizeObject(bag, depth, seen, limits);
}

function normalizeArray(
  value: readonly unknown[],
  depth: number,
  seen: WeakSet<object>,
  limits: Limits,
): JsonValue[] {
  seen.add(value);
  const items = value.slice(0, limits.maxArrayItems);
  const out: JsonValue[] = [];
  for (const item of items) {
    out.push(normalize(item, depth + 1, seen, limits));
  }
  seen.delete(value);
  return out;
}

function normalizeObject(
  value: Readonly<Record<string, unknown>>,
  depth: number,
  seen: WeakSet<object>,
  limits: Limits,
): JsonRecord {
  seen.add(value);
  const out: Record<string, JsonValue> = {};
  const entries = Object.entries(value).slice(0, limits.maxObjectKeys);
  for (const [key, child] of entries) {
    // Skip undefined leaves so the bag matches JSON.stringify omission for
    // undefined object values — except we already map free-standing undefined
    // to a sentinel when it appears as a root or array element.
    if (child === undefined) continue;
    out[key] = normalize(child, depth + 1, seen, limits);
  }
  seen.delete(value);
  return out;
}
