/**
 * Built-in synchronous-call allowlists for the detached-promises check.
 * Recipe config augments these via {@link DetachedPromisesConfig}.
 */

import { getCheckConfig } from '@opensip-cli/fitness';

/**
 * Recipe-config shape for the detached-promises check. Each field augments the
 * built-in defaults; nothing here is required. Project-specific helper names
 * (e.g. opensip's `attachDomainContext`, `sendError`) belong in a recipe's
 * `checks.config['detached-promises']` block, not in built-in defaults.
 */
export interface DetachedPromisesConfig extends Record<string, unknown> {
  /** Method/function names that are synchronous (no await needed). */
  additionalSyncFunctions?: readonly string[];
  /** Receiver identifiers (the part before the dot) that are synchronous. */
  additionalSyncReceivers?: readonly string[];
  /** Method-name prefixes that mark a call as synchronous (e.g. `'wire'`). */
  additionalSyncPrefixes?: readonly string[];
}

/**
 * Known synchronous functions that do NOT return promises. Limited to
 * generic JS / TS / Node defaults; framework-specific entries live in
 * recipe config under `additionalSyncFunctions`.
 */
export const KNOWN_SYNC_FUNCTIONS = new Set([
  // Node.js sync filesystem / process methods
  'execSync',
  'readFileSync',
  'writeFileSync',
  'existsSync',
  'mkdirSync',
  'rmdirSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'unlinkSync',
  'copyFileSync',
  'renameSync',
  'accessSync',
  // Timer clearing/scheduling helpers (sync side)
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  // Console (synchronous)
  'log',
  'time',
  'timeEnd',
  // Promise resolution helpers (sync wrappers)
  'reject',
  'resolve',
  // Builder / coercion terminators
  'build',
  'toJSON',
  'toString',
  'valueOf',
  // Array methods (synchronous)
  'map',
  'filter',
  'reduce',
  'find',
  'findIndex',
  'some',
  'every',
  'includes',
  'indexOf',
  'slice',
  'concat',
  'join',
  'sort',
  'reverse',
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'fill',
  'copyWithin',
  'flat',
  'flatMap',
  'forEach',
  // String methods (synchronous)
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
  'split',
  'replace',
  'replaceAll',
  'substring',
  'substr',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'match',
  'matchAll',
  'search',
  'normalize',
  'localeCompare',
  // Object methods (synchronous)
  'keys',
  'values',
  'entries',
  'assign',
  'freeze',
  'seal',
  'fromEntries',
  'create',
  'defineProperty',
  'defineProperties',
  'getOwnPropertyNames',
  'getOwnPropertyDescriptor',
  'getPrototypeOf',
  'setPrototypeOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  // JSON methods
  'stringify',
  'parse',
  // Math methods
  'floor',
  'ceil',
  'round',
  'max',
  'min',
  'abs',
  'random',
  'pow',
  'sqrt',
  'sign',
  'trunc',
  // Set/Map/WeakMap/WeakSet methods (synchronous)
  'add',
  'delete',
  'has',
  'clear',
  'get',
  'set',
  'size',
  // EventEmitter methods (synchronous)
  'emit',
  'on',
  'off',
  'once',
  'addListener',
  'removeListener',
  'removeAllListeners',
  'prependListener',
  'prependOnceListener',
  'eventNames',
  'listeners',
  'listenerCount',
  'rawListeners',
  // Date methods (synchronous)
  'getTime',
  'getDate',
  'getDay',
  'getFullYear',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
  'setTime',
  'setDate',
  'setFullYear',
  'setHours',
  'setMinutes',
  'setSeconds',
  'setMilliseconds',
  'toISOString',
  'toDateString',
  'toTimeString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleString',
  'now',
]);

/**
 * Known synchronous receiver identifiers — generic JS / Node namespaces.
 */
export const KNOWN_SYNC_RECEIVERS = new Set([
  'console',
  'log',
  'path',
  'fs',
  'process',
  'JSON',
  'Math',
  'Object',
  'Array',
  'String',
  'Number',
  'Date',
  'RegExp',
  'Symbol',
  'Boolean',
  'Error',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Reflect',
  'Proxy',
  'Intl',
]);

/** Substrings matched against receiver variable names (case-insensitive). */
export const KNOWN_SYNC_RECEIVER_PATTERNS = [
  'logger',
  'writer',
  'emitter',
  'registry',
  'cache',
  'store',
  'queue',
  'buffer',
  'timer',
  'counter',
  'gauge',
  'diagnostics',
];

/** File path patterns that indicate CLI commands or route registrations. */
export const FILE_SKIP_PATTERNS = [
  '/commands/',
  '/routes/',
  '/route-handlers/',
  '/handlers/',
  '/plugins/',
  'register-routes',
  'register-plugins',
];

/** Method-name prefixes that indicate synchronous calls. */
export const KNOWN_SYNC_PREFIXES = [
  'set',
  'get',
  'add',
  'remove',
  'delete',
  'clear',
  'reset',
  'is',
  'has',
  'can',
  'should',
  'was',
  'will',
  'assert',
  'emit',
  'on',
  'off',
  'once',
  'dispatch',
];

/** Method name suffixes that indicate synchronous calls. */
export const KNOWN_SYNC_SUFFIXES = ['Sync'];

/** Fire-and-forget patterns that are intentionally not awaited. */
export const FIRE_AND_FORGET_PATTERNS = new Set([
  'setImmediate',
  'setTimeout',
  'setInterval',
  'nextTick',
  'queueMicrotask',
]);

/** Built-in defaults merged with the recipe's `detached-promises` config slice. */
export interface EffectiveSyncSets {
  syncFunctions: ReadonlySet<string>;
  syncReceivers: ReadonlySet<string>;
  syncPrefixes: readonly string[];
}

/** Build effective sync-call lookup sets from defaults + recipe config. */
export function buildEffectiveSyncSets(): EffectiveSyncSets {
  const cfg = getCheckConfig<DetachedPromisesConfig>('detached-promises');
  const fns = new Set(KNOWN_SYNC_FUNCTIONS);
  for (const name of cfg.additionalSyncFunctions ?? []) fns.add(name);
  const recvs = new Set(KNOWN_SYNC_RECEIVERS);
  for (const name of cfg.additionalSyncReceivers ?? []) recvs.add(name);
  const prefixes = [...KNOWN_SYNC_PREFIXES, ...(cfg.additionalSyncPrefixes ?? [])];
  return { syncFunctions: fns, syncReceivers: recvs, syncPrefixes: prefixes };
}
