import { realpathSync as defaultRealpathSync, statSync as defaultStatSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

import {
  DISTRIBUTION_FOOTPRINT_DEFAULT_OUTPUT,
  DISTRIBUTION_INSTALL_MODES,
  DISTRIBUTION_MEASURE_DEFAULT_REPEATS,
  DISTRIBUTION_MEASURE_MAX_REPEATS,
  DISTRIBUTION_MEASURE_USAGE,
} from './distribution-footprint-constants.mjs';
import { normalizeDistributionVersion } from './distribution-footprint-release.mjs';

const INSTALL_MODES = new Set(DISTRIBUTION_INSTALL_MODES);

export function distributionMeasureHelp() {
  return DISTRIBUTION_MEASURE_USAGE;
}

/** Parse and validate the repository-only distribution measurement command arguments. */
export function parseDistributionMeasureArgs(argv, options = {}) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');

  const parsed = {
    mode: 'offline-cache',
    repeats: DISTRIBUTION_MEASURE_DEFAULT_REPEATS,
    output: DISTRIBUTION_FOOTPRINT_DEFAULT_OUTPUT,
    allowRegistry: false,
    help: false,
  };
  const seen = new Set();

  for (const [rawIndex, argument] of argv.entries()) {
    if (typeof argument !== 'string') {
      throw new TypeError(`argv[${String(rawIndex)}] must be a string`);
    }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help') {
      assertFlagOnce(seen, argument);
      parsed.help = true;
      continue;
    }

    assertFlagOnce(seen, argument);
    switch (argument) {
      case '--dir': {
        parsed.artifactDir = requiredArgumentValue(argv, ++index, argument);
        break;
      }
      case '--expected-version': {
        parsed.expectedVersion = requiredArgumentValue(argv, ++index, argument);
        break;
      }
      case '--out': {
        parsed.output = requiredArgumentValue(argv, ++index, argument);
        break;
      }
      case '--repeats': {
        parsed.repeats = parseRepeatCount(requiredArgumentValue(argv, ++index, argument));
        break;
      }
      case '--mode': {
        parsed.mode = requiredArgumentValue(argv, ++index, argument);
        break;
      }
      case '--store-dir': {
        parsed.storeDir = requiredArgumentValue(argv, ++index, argument);
        break;
      }
      case '--registry': {
        parsed.registry = requiredArgumentValue(argv, ++index, argument);
        break;
      }
      case '--allow-registry': {
        parsed.allowRegistry = true;
        break;
      }
      default: {
        throw new Error(`Unknown option ${argument}.\n${DISTRIBUTION_MEASURE_USAGE}`);
      }
    }
  }

  if (parsed.help) return { help: true };
  if (!INSTALL_MODES.has(parsed.mode)) {
    throw new Error('--mode must be either offline-cache or registry-cold');
  }
  if (parsed.artifactDir === undefined) throw new Error('--dir is required');
  if (parsed.expectedVersion === undefined) throw new Error('--expected-version is required');

  const pathOptions = {
    cwd: options.cwd ?? process.cwd(),
    realpathSync: options.realpathSync ?? defaultRealpathSync,
    statSync: options.statSync ?? defaultStatSync,
  };
  const common = {
    help: false,
    artifactDir: resolveExistingDirectory(parsed.artifactDir, '--dir', pathOptions),
    expectedVersion: normalizeDistributionVersion(parsed.expectedVersion, '--expected-version'),
    outputPath: resolve(pathOptions.cwd, parsed.output),
    repeats: parsed.repeats,
    mode: parsed.mode,
    allowRegistry: parsed.allowRegistry,
  };

  if (parsed.mode === 'offline-cache') {
    if (parsed.storeDir === undefined) {
      throw new Error('--store-dir is required in offline-cache mode');
    }
    if (parsed.registry !== undefined || parsed.allowRegistry) {
      throw new Error('--registry and --allow-registry are only valid in registry-cold mode');
    }
    return {
      ...common,
      storeDir: resolveExistingDirectory(parsed.storeDir, '--store-dir', pathOptions),
    };
  }

  if (parsed.storeDir !== undefined) {
    throw new Error('--store-dir is not valid in registry-cold mode');
  }
  if (!parsed.allowRegistry) {
    throw new Error('registry-cold mode requires explicit --allow-registry acknowledgement');
  }
  if (parsed.registry === undefined) {
    throw new Error('--registry is required in registry-cold mode');
  }
  return {
    ...common,
    registryOrigin: validateDistributionRegistryOrigin(parsed.registry),
  };
}

/** Validate and reduce a caller-selected registry URL to a credential-free origin. */
export function validateDistributionRegistryOrigin(value, source = '--registry') {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${source} must be a non-empty URL without surrounding whitespace`);
  }
  if (value.includes('?') || value.includes('#')) {
    throw new Error(`${source} must not contain a query or hash`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${source} must be a valid URL`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${source} must not contain credentials`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${source} must be an origin without a path`);
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return url.origin;
  throw new Error(`${source} must use HTTPS, except for loopback HTTP test registries`);
}

function assertFlagOnce(seen, flag) {
  if (seen.has(flag)) throw new Error(`Option ${flag} may only be specified once`);
  seen.add(flag);
}

function requiredArgumentValue(argv, index, flag) {
  const value = argv[index];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseRepeatCount(value) {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error('--repeats must be a positive integer');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > DISTRIBUTION_MEASURE_MAX_REPEATS) {
    throw new RangeError(`--repeats must not exceed ${String(DISTRIBUTION_MEASURE_MAX_REPEATS)}`);
  }
  return count;
}

function resolveExistingDirectory(value, flag, options) {
  const absolute = resolve(options.cwd, value);
  let real;
  try {
    real = options.realpathSync(absolute);
  } catch {
    throw new Error(`${flag} must name an existing directory`);
  }
  let info;
  try {
    info = options.statSync(real);
  } catch {
    throw new Error(`${flag} must name an existing directory`);
  }
  if (!info.isDirectory()) throw new Error(`${flag} must name an existing directory`);
  return real;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.$/u, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split('.')[0] === '127';
}
